import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import xtermHeadless from "@xterm/headless";
import type { Terminal as XtermTerminal } from "@xterm/headless";
import { WebSocketServer, type WebSocket } from "ws";
import type { IPty } from "node-pty";
import { clearState, writeState } from "./state.js";
import type { BridgeEvent, BridgeMode, ClientMessage, RuntimeOptions } from "./types.js";

const MAX_BUFFERED_EVENTS = 300;
const DEFAULT_TERMINAL_COLS = 120;
const DEFAULT_TERMINAL_ROWS = 140;
const { Terminal } = xtermHeadless;

export interface BridgeServer {
  sessionId: string;
  setPty(pty: IPty): void;
  ingestTerminal(data: string): void;
  resize(cols: number, rows: number): void;
  broadcast(event: BridgeEvent): void;
  close(): Promise<void>;
}

export async function createBridgeServer(options: RuntimeOptions, mode: BridgeMode): Promise<BridgeServer> {
  const sessionId = randomUUID();
  const startedAt = new Date().toISOString();
  const clients = new Set<WebSocket>();
  const bufferedEvents: BridgeEvent[] = [];
  let ptyProcess: IPty | null = null;
  let latestScreen: Extract<BridgeEvent, { type: "screen" }> | null = null;
  let terminal = new Terminal({
    cols: Number(process.env.RMTERM_COLS ?? DEFAULT_TERMINAL_COLS),
    rows: Number(process.env.RMTERM_ROWS ?? DEFAULT_TERMINAL_ROWS),
    scrollback: Number(process.env.RMTERM_SCROLLBACK_LINES ?? 5000),
    allowProposedApi: true
  });
  let screenFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let isClosing = false;
  let close: () => Promise<void>;
  let submitQueue = Promise.resolve();

  const pushEvent = (event: BridgeEvent) => {
    if (event.type === "screen") {
      latestScreen = event;
    } else if (event.type !== "terminal") {
      bufferedEvents.push(event);
      if (bufferedEvents.length > MAX_BUFFERED_EVENTS) {
        bufferedEvents.shift();
      }
    }

    const encoded = JSON.stringify(event);
    for (const client of clients) {
      if (client.readyState === client.OPEN && client.bufferedAmount < 1024 * 1024) {
        client.send(encoded);
      }
    }
  };

  const server = createServer(async (req, res) => {
    if (req.url === "/health") {
      writeJson(res, 200, {
        ok: true,
        mode,
        sessionId,
        cwd: options.cwd,
        startedAt,
        hasPty: Boolean(ptyProcess)
      });
      return;
    }

    if (req.url === "/shutdown" && req.method === "POST") {
      if (!isAuthorized(req, options.token)) {
        writeJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }

      writeJson(res, 200, { ok: true });
      setTimeout(() => {
        void close();
      }, 25);
      return;
    }

    if (req.url?.startsWith("/hooks/") && req.method === "POST") {
      if (!isAuthorized(req, options.token)) {
        writeJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }

      const source = req.url.split("/").filter(Boolean)[1] ?? "unknown";
      const payload = await readJsonBody(req);
      pushEvent({
        type: "hook",
        sessionId,
        source,
        payload,
        at: new Date().toISOString()
      });
      writeJson(res, 202, { ok: true });
      return;
    }

    writeJson(res, 404, { ok: false, error: "not_found" });
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/ws") || !isAuthorized(req, options.token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({
      type: "hello",
      mode,
      sessionId,
      cwd: options.cwd,
      startedAt,
      hasPty: Boolean(ptyProcess)
    } satisfies BridgeEvent));

    for (const event of bufferedEvents) {
      ws.send(JSON.stringify(event));
    }
    if (latestScreen) {
      ws.send(JSON.stringify(latestScreen));
    }

    ws.on("message", (raw) => {
      const message = parseClientMessage(raw.toString());
      if (!message) {
        return;
      }

      if (message.type === "input") {
        ptyProcess?.write(message.data);
      }

      if (message.type === "submit") {
        submitQueue = submitQueue
          .then(() => writeSubmit(ptyProcess, message.data, message.key))
          .catch(() => undefined);
      }

      if (message.type === "resize" && ptyProcess) {
        resizeTerminal(message.cols, message.rows);
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });

  writeState({
    pid: process.pid,
    host: options.host,
    port: options.port,
    mode,
    startedAt,
    publicUrl: options.ngrokUrl
  });

  close = async () => {
    if (isClosing) {
      return;
    }
    isClosing = true;
    for (const client of clients) {
      client.close();
    }
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearState();
  };

  return {
    sessionId,
    setPty(pty) {
      ptyProcess = pty;
    },
    ingestTerminal(data) {
      terminal.write(data, () => {
        scheduleScreenFlush();
      });
    },
    resize(cols, rows) {
      resizeTerminal(cols, rows);
    },
    broadcast: pushEvent,
    close
  };

  function resizeTerminal(cols: number, rows: number) {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
      return;
    }

    const safeCols = Math.max(40, Math.min(240, Math.floor(cols)));
    const safeRows = Math.max(10, Math.min(80, Math.floor(rows)));
    terminal.resize(safeCols, safeRows);
    ptyProcess?.resize(safeCols, safeRows);
    scheduleScreenFlush();
  }

  function scheduleScreenFlush() {
    if (screenFlushTimer) {
      return;
    }

    screenFlushTimer = setTimeout(() => {
      screenFlushTimer = null;
      const snapshot = snapshotTerminal(terminal, sessionId);
      if (snapshot.text.trim().length > 0) {
        pushEvent(snapshot);
      }
    }, Number(process.env.RMTERM_SCREEN_THROTTLE_MS ?? 80));
  }
}

function snapshotTerminal(
  terminal: XtermTerminal,
  sessionId: string
): Extract<BridgeEvent, { type: "screen" }> {
  const lines: string[] = [];
  const buffer = terminal.buffer.active;
  const maxHistoryLines = Number(process.env.RMTERM_SCREEN_HISTORY_LINES ?? 800);
  const start = Math.max(0, buffer.length - maxHistoryLines);

  for (let index = start; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true).replace(/[ \t]+$/g, "") ?? "");
  }

  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return {
    type: "screen",
    sessionId,
    text: lines.join("\n"),
    lines,
    cols: terminal.cols,
    rows: terminal.rows,
    at: new Date().toISOString()
  };
}

function isAuthorized(req: IncomingMessage, token: string) {
  if (!token) {
    return true;
  }

  const header = req.headers.authorization;
  if (header === `Bearer ${token}`) {
    return true;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  return url.searchParams.get("token") === token;
}

function writeJson(res: ServerResponse, statusCode: number, value: unknown) {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (!body) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({ raw: body });
      }
    });
    req.on("error", () => resolve(null));
  });
}

function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const parsed = JSON.parse(raw) as ClientMessage;
    if (parsed.type === "input" && typeof parsed.data === "string") {
      return parsed;
    }
    if (parsed.type === "submit" && typeof parsed.data === "string") {
      return parsed;
    }
    if (
      parsed.type === "resize" &&
      Number.isFinite(parsed.cols) &&
      Number.isFinite(parsed.rows)
    ) {
      return parsed;
    }
    if (parsed.type === "ping") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function getSubmitKeySequence(key: "enter" | "enhancedEnter" | "ctrlEnter" | undefined) {
  switch (key) {
    case "enter":
      return "\r";
    case "ctrlEnter":
      return "\u001b[13;5u";
    case "enhancedEnter":
    default:
      return "\u001b[13u";
  }
}

async function writeSubmit(
  ptyProcess: IPty | null,
  data: string,
  key: "enter" | "enhancedEnter" | "ctrlEnter" | undefined
) {
  if (!ptyProcess) {
    return;
  }

  const typeDelayMs = Number(process.env.RMTERM_TYPE_DELAY_MS ?? 8);
  const submitDelayMs = Number(process.env.RMTERM_SUBMIT_DELAY_MS ?? 120);

  for (const character of data) {
    ptyProcess.write(character);
    if (typeDelayMs > 0) {
      await delay(typeDelayMs);
    }
  }

  if (submitDelayMs > 0) {
    await delay(submitDelayMs);
  }

  ptyProcess.write(getSubmitKeySequence(key));
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
