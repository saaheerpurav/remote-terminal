export type BridgeMode = "monitor" | "pty";

export type BridgeEvent =
  | {
      type: "hello";
      mode: BridgeMode;
      sessionId: string;
      cwd: string;
      startedAt: string;
      hasPty: boolean;
    }
  | {
      type: "terminal";
      sessionId: string;
      data: string;
      at: string;
    }
  | {
      type: "screen";
      sessionId: string;
      text: string;
      lines: string[];
      cols: number;
      rows: number;
      at: string;
    }
  | {
      type: "status";
      sessionId: string;
      status: "starting" | "running" | "exited" | "error";
      message?: string;
      code?: number;
      at: string;
    }
  | {
      type: "hook";
      sessionId: string;
      source: string;
      payload: unknown;
      at: string;
    };

export type ClientMessage =
  | {
      type: "input";
      data: string;
    }
  | {
      type: "submit";
      data: string;
      key?: "enter" | "enhancedEnter" | "ctrlEnter";
    }
  | {
      type: "resize";
      cols: number;
      rows: number;
    }
  | {
      type: "ping";
    };

export interface RuntimeOptions {
  host: string;
  port: number;
  token: string;
  ngrokUrl?: string;
  cwd: string;
}
