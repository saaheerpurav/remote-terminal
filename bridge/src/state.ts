import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface BridgeState {
  pid: number;
  host: string;
  port: number;
  mode: "monitor" | "pty";
  startedAt: string;
  ngrokPid?: number;
  publicUrl?: string;
}

const statePath = join(homedir(), ".remote-terminal", "state.json");

export function getStatePath() {
  return statePath;
}

export function readState(): BridgeState | null {
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as BridgeState;
  } catch {
    return null;
  }
}

export function writeState(state: BridgeState) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function clearState() {
  rmSync(statePath, { force: true });
}

