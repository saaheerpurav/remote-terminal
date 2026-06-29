#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Command } from "commander";
import * as pty from "node-pty";
import xtermHeadless from "@xterm/headless";
import { startNgrok } from "./ngrok.js";
import { createBridgeServer } from "./server.js";
import { clearState, getStatePath, readState } from "./state.js";
import type { RuntimeOptions } from "./types.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_TERMINAL_COLS = 120;
const DEFAULT_TERMINAL_ROWS = 140;
const { Terminal } = xtermHeadless;

loadDotEnv();

const program = new Command();

program
  .name("rmterm")
  .description("Remote monitor/control bridge for Codex and Claude Code sessions.")
  .version("0.1.0");

program
  .command("serve")
  .description("Run the monitor-only bridge in the foreground.")
  .option("--host <host>", "host to bind", process.env.RMTERM_HOST ?? "127.0.0.1")
  .option("--port <port>", "port to bind", process.env.RMTERM_PORT ?? "8787")
  .option("--token <token>", "auth token", process.env.RMTERM_TOKEN ?? "")
  .option("--ngrok-url <url>", "fixed ngrok URL", process.env.RMTERM_NGROK_URL)
  .option("--workdir <dir>", "working directory to report/use", process.env.RMTERM_WORKDIR)
  .action(async (flags) => {
    const options = getRuntimeOptions(flags);
    const ngrok = startNgrok(options.port, options.ngrokUrl);
    const bridge = await createBridgeServer(options, "monitor");

    console.log(`rmterm bridge listening on http://${options.host}:${options.port}`);
    if (options.ngrokUrl) {
      console.log(`ngrok requested for ${options.ngrokUrl}`);
    }

    await waitForExit(async () => {
      ngrok?.kill();
      await bridge.close();
    });
  });

program
  .command("start")
  .description("Start the monitor-only bridge as a background process.")
  .option("--host <host>", "host to bind", process.env.RMTERM_HOST ?? "127.0.0.1")
  .option("--port <port>", "port to bind", process.env.RMTERM_PORT ?? "8787")
  .option("--token <token>", "auth token", process.env.RMTERM_TOKEN ?? "")
  .option("--ngrok-url <url>", "fixed ngrok URL", process.env.RMTERM_NGROK_URL)
  .option("--workdir <dir>", "working directory to report/use", process.env.RMTERM_WORKDIR)
  .action(async (flags) => {
    const existing = readState();
    if (existing && isPidAlive(existing.pid)) {
      console.log(`rmterm already running on http://${existing.host}:${existing.port}`);
      return;
    }

    const args = [
      process.argv[1],
      "serve",
      "--host",
      flags.host,
      "--port",
      String(flags.port)
    ];

    if (flags.token) {
      args.push("--token", flags.token);
    }
    if (flags.ngrokUrl) {
      args.push("--ngrok-url", flags.ngrokUrl);
    }
    if (flags.workdir) {
      args.push("--workdir", flags.workdir);
    }

    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();

    await delay(500);
    const state = readState();
    if (state) {
      console.log(`rmterm started on http://${state.host}:${state.port}`);
      if (state.publicUrl) {
        console.log(`public URL: ${state.publicUrl}`);
      }
      return;
    }

    console.log("rmterm start requested, but state was not written yet");
  });

program
  .command("run")
  .description("Run Codex or Claude Code under rmterm PTY control.")
  .argument("<agent>", "codex or claude")
  .argument("[agentArgs...]", "extra args passed to the agent CLI")
  .option("--host <host>", "host to bind", process.env.RMTERM_HOST ?? "127.0.0.1")
  .option("--port <port>", "port to bind", process.env.RMTERM_PORT ?? "8787")
  .option("--token <token>", "auth token", process.env.RMTERM_TOKEN ?? "")
  .option("--ngrok-url <url>", "fixed ngrok URL", process.env.RMTERM_NGROK_URL)
  .option("--workdir <dir>", "working directory to run the agent in", process.env.RMTERM_WORKDIR)
  .option("--fresh", "start without default resume flags")
  .option("--resume <id>", "resume a specific session id/name")
  .allowUnknownOption(true)
  .action(async (agent: string, agentArgs: string[], flags) => {
    await runAgent(agent, agentArgs, flags);
  });

program
  .command("codex")
  .description("Run Codex under rmterm PTY control in the current folder.")
  .argument("[agentArgs...]", "extra args passed to Codex")
  .option("--host <host>", "host to bind", process.env.RMTERM_HOST ?? "127.0.0.1")
  .option("--port <port>", "port to bind", process.env.RMTERM_PORT ?? "8787")
  .option("--token <token>", "auth token", process.env.RMTERM_TOKEN ?? "")
  .option("--ngrok-url <url>", "fixed ngrok URL", process.env.RMTERM_NGROK_URL)
  .option("--workdir <dir>", "working directory to run Codex in", process.env.RMTERM_WORKDIR)
  .option("--fresh", "start without default resume flags")
  .option("--resume <id>", "resume a specific session id/name")
  .allowUnknownOption(true)
  .action((agentArgs: string[], flags) => runAgent("codex", agentArgs, flags));

program
  .command("claude")
  .description("Run Claude Code under rmterm PTY control in the current folder.")
  .argument("[agentArgs...]", "extra args passed to Claude Code")
  .option("--host <host>", "host to bind", process.env.RMTERM_HOST ?? "127.0.0.1")
  .option("--port <port>", "port to bind", process.env.RMTERM_PORT ?? "8787")
  .option("--token <token>", "auth token", process.env.RMTERM_TOKEN ?? "")
  .option("--ngrok-url <url>", "fixed ngrok URL", process.env.RMTERM_NGROK_URL)
  .option("--workdir <dir>", "working directory to run Claude Code in", process.env.RMTERM_WORKDIR)
  .option("--fresh", "start without default resume flags")
  .option("--resume <id>", "resume a specific session id/name")
  .allowUnknownOption(true)
  .action((agentArgs: string[], flags) => runAgent("claude", agentArgs, flags));

program
  .command("hook")
  .description("Read a hook payload from stdin and POST it to the local bridge quickly.")
  .argument("<source>", "event source, for example codex or claude")
  .option("--host <host>", "bridge host", process.env.RMTERM_HOST ?? "127.0.0.1")
  .option("--port <port>", "bridge port", process.env.RMTERM_PORT ?? "8787")
  .option("--token <token>", "auth token", process.env.RMTERM_TOKEN ?? "")
  .option("--timeout <ms>", "POST timeout in milliseconds", process.env.RMTERM_HOOK_TIMEOUT_MS ?? "75")
  .action(async (source: string, flags) => {
    const body = await readStdinWithLimit(512 * 1024);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(flags.timeout));

    try {
      await fetch(`http://${flags.host}:${flags.port}/hooks/${encodeURIComponent(source)}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(flags.token ? { authorization: `Bearer ${flags.token}` } : {})
        },
        body: body || "{}",
        signal: controller.signal
      });
    } catch {
      // Hooks must never block or fail the parent Codex/Claude workflow.
    } finally {
      clearTimeout(timeout);
    }
  });

program
  .command("init")
  .description("Print lightweight hook setup guidance for Codex/Claude configs.")
  .action(() => {
    console.log("rmterm hook command is available.");
    console.log("");
    console.log("Use this as the hook command in Codex/Claude configs:");
    console.log("  rmterm hook codex");
    console.log("  rmterm hook claude");
    console.log("");
    console.log("The hook command reads JSON from stdin, POSTs to localhost with a short timeout,");
    console.log("and exits successfully even when rmterm is not running.");
  });

program
  .command("stop")
  .description("Stop the running bridge.")
  .option("--token <token>", "auth token", process.env.RMTERM_TOKEN ?? "")
  .action(async (flags) => {
    const state = readState();
    if (!state) {
      console.log("rmterm is not running");
      return;
    }

    try {
      await fetch(`http://${state.host}:${state.port}/shutdown`, {
        method: "POST",
        headers: flags.token ? { authorization: `Bearer ${flags.token}` } : undefined
      });
      console.log("rmterm stop requested");
      return;
    } catch {
      if (isPidAlive(state.pid)) {
        process.kill(state.pid);
      }
      clearState();
      console.log("rmterm process killed");
    }
  });

program
  .command("status")
  .description("Show current bridge status.")
  .action(() => {
    const state = readState();
    if (!state || !isPidAlive(state.pid)) {
      console.log("rmterm is not running");
      if (state) {
        clearState();
      }
      return;
    }

    console.log(`mode: ${state.mode}`);
    console.log(`pid: ${state.pid}`);
    console.log(`local: http://${state.host}:${state.port}`);
    if (state.publicUrl) {
      console.log(`public: ${state.publicUrl}`);
    }
    console.log(`started: ${state.startedAt}`);
    console.log(`state: ${getStatePath()}`);
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

function getRuntimeOptions(flags: Record<string, string>): RuntimeOptions {
  return {
    host: flags.host ?? "127.0.0.1",
    port: Number(flags.port ?? 8787),
    token: flags.token ?? "",
    ngrokUrl: flags.ngrokUrl,
    cwd: resolve(flags.workdir ?? process.cwd())
  };
}

function loadDotEnv() {
  const envPath = findDotEnvPath();
  if (!envPath) {
    return;
  }

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^["']|["']$/g, "");

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function findDotEnvPath() {
  if (process.env.RMTERM_ENV_FILE && existsSync(process.env.RMTERM_ENV_FILE)) {
    return process.env.RMTERM_ENV_FILE;
  }

  const repoEnv = resolve(repoRoot, ".env");
  if (existsSync(repoEnv)) {
    return repoEnv;
  }

  const starts = [process.cwd(), process.env.INIT_CWD].filter(Boolean) as string[];
  for (const start of starts) {
    let current = resolve(start);
    while (true) {
      const candidate = resolve(current, ".env");
      if (existsSync(candidate)) {
        return candidate;
      }

      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  const packageRelative = resolve(process.cwd(), "..", ".env");
  if (existsSync(packageRelative)) {
    return packageRelative;
  }

  return null;
}

function buildAgentCommand(agent: string, resumeId: string | undefined, shouldResume: boolean, extraArgs: string[]) {
  if (agent === "codex") {
    if (!shouldResume) {
      return { file: "codex", args: ["--yolo", "--no-alt-screen", ...extraArgs] };
    }
    return { file: "codex", args: ["--yolo", "--no-alt-screen", "resume", resumeId ?? "--last", ...extraArgs] };
  }

  if (agent === "claude") {
    if (!shouldResume) {
      return { file: "claude", args: ["--dangerously-skip-permissions", ...extraArgs] };
    }
    return {
      file: "claude",
      args: resumeId
        ? ["--dangerously-skip-permissions", "--resume", resumeId, ...extraArgs]
        : ["--dangerously-skip-permissions", "--continue", ...extraArgs]
    };
  }

  throw new Error(`Unsupported agent "${agent}". Use "codex" or "claude".`);
}

async function runAgent(agent: string, agentArgs: string[], flags: Record<string, string | boolean | undefined>) {
  const options = getRuntimeOptions(flags as Record<string, string>);
  const bridge = await createBridgeServer(options, "pty");
  const ngrok = startNgrok(options.port, options.ngrokUrl);
  const commandSpec = buildAgentCommand(agent, flags.resume as string | undefined, !flags.fresh, agentArgs);

  console.log(`rmterm bridge listening on http://${options.host}:${options.port}`);
  console.log(`working directory: ${options.cwd}`);
  if (options.ngrokUrl) {
    console.log(`ngrok requested for ${options.ngrokUrl}`);
  }
  const ptyCommand = resolvePtyCommand(commandSpec.file, commandSpec.args);

  console.log(`starting: ${ptyCommand.display}`);

  let shellPty: pty.IPty;
  const terminalCols = Number(process.env.RMTERM_COLS ?? DEFAULT_TERMINAL_COLS);
  const terminalRows = Number(process.env.RMTERM_ROWS ?? DEFAULT_TERMINAL_ROWS);
  const desktopRenderer = createDesktopRenderer(terminalCols, terminalRows);
  try {
    shellPty = pty.spawn(ptyCommand.file, ptyCommand.args, {
      name: "xterm-256color",
      cols: terminalCols,
      rows: terminalRows,
      cwd: options.cwd,
      env: process.env
    });
  } catch (error) {
    bridge.broadcast({
      type: "status",
      sessionId: bridge.sessionId,
      status: "error",
      message: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString()
    });
    ngrok?.kill();
    await bridge.close();
    throw error;
  }

  bridge.setPty(shellPty);
  bridge.broadcast({
    type: "status",
    sessionId: bridge.sessionId,
    status: "running",
    at: new Date().toISOString()
  });

  shellPty.onData((data) => {
    bridge.ingestTerminal(data);
    desktopRenderer.ingest(data);
  });

  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on("data", (data) => {
    shellPty.write(data.toString());
  });

  shellPty.onExit(async ({ exitCode }) => {
    bridge.broadcast({
      type: "status",
      sessionId: bridge.sessionId,
      status: "exited",
      code: exitCode,
      at: new Date().toISOString()
    });
    ngrok?.kill();
    await bridge.close();
    process.exit(exitCode);
  });

  await waitForExit(async () => {
    shellPty.kill();
    ngrok?.kill();
    await bridge.close();
  });
}

function resolvePtyCommand(file: string, args: string[]) {
  if (process.platform !== "win32") {
    return {
      file,
      args,
      display: `${file} ${args.join(" ")}`.trim()
    };
  }

  const resolved = resolveWindowsExecutable(file);
  if (!resolved) {
    return {
      file,
      args,
      display: `${file} ${args.join(" ")}`.trim()
    };
  }

  return {
    file: resolved,
    args,
    display: `${resolved} ${args.join(" ")}`.trim()
  };
}

function resolveWindowsExecutable(file: string) {
  try {
    const output = execFileSync("where.exe", [file], { encoding: "utf8" });
    const candidates = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    return (
      candidates.find((candidate) => /\.(exe|cmd|bat)$/i.test(candidate)) ??
      candidates[0] ??
      null
    );
  } catch {
    return null;
  }
}

function createDesktopRenderer(cols: number, rows: number) {
  const mode = process.env.RMTERM_DESKTOP_RENDER ?? "viewport";
  const terminal = new Terminal({
    cols,
    rows,
    scrollback: Number(process.env.RMTERM_SCROLLBACK_LINES ?? 5000),
    allowProposedApi: true
  });
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  return {
    ingest(data: string) {
      if (mode === "raw" || !process.stdout.isTTY) {
        process.stdout.write(data);
        return;
      }

      terminal.write(data, () => {
        if (flushTimer) {
          return;
        }
        flushTimer = setTimeout(() => {
          flushTimer = null;
          renderDesktopViewport(terminal);
        }, Number(process.env.RMTERM_DESKTOP_RENDER_THROTTLE_MS ?? 50));
      });
    }
  };
}

function renderDesktopViewport(terminal: InstanceType<typeof Terminal>) {
  const visibleRows = Math.max(10, Number(process.stdout.rows ?? 30));
  const buffer = terminal.buffer.active;
  const lines: string[] = [];

  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true).replace(/[ \t]+$/g, "") ?? "");
  }

  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const visibleLines = lines.slice(-visibleRows);
  process.stdout.write(`\u001b[?25l\u001b[H\u001b[2J${visibleLines.join("\n")}\u001b[?25h`);
}

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(onExit: () => Promise<void>) {
  let closing = false;
  const close = async () => {
    if (closing) {
      return;
    }
    closing = true;
    await onExit();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void close();
  });
  process.on("SIGTERM", () => {
    void close();
  });

  await new Promise(() => {
    // Keep process alive until signal or PTY exit.
  });
}

function readStdinWithLimit(maxBytes: number): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;

    process.stdin.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes <= maxBytes) {
        chunks.push(chunk);
      }
    });

    process.stdin.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    process.stdin.on("error", () => {
      resolve("");
    });

    if (process.stdin.isTTY) {
      resolve("{}");
    } else {
      process.stdin.resume();
    }
  });
}
