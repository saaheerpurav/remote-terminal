import { spawn, type ChildProcess } from "node:child_process";

export function startNgrok(port: number, publicUrl?: string): ChildProcess | null {
  if (!publicUrl) {
    return null;
  }

  const args = ["http", "--url", publicUrl, `http://127.0.0.1:${port}`];
  const child = spawn("ngrok", args, {
    detached: false,
    stdio: "ignore",
    windowsHide: true
  });

  child.on("error", () => {
    // The bridge remains usable on localhost if ngrok is unavailable.
  });

  return child;
}
