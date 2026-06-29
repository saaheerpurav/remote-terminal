# RemoteTerminal

RemoteTerminal lets you monitor and control a local Codex or Claude Code session from an Expo mobile app. The desktop side runs the agent inside a PTY bridge, exposes a token-protected WebSocket endpoint, and streams a stable terminal snapshot to the phone. The phone can watch output live and send input back to the running session.

The CLI command is `rmterm`.

## What It Does

- Starts Codex or Claude Code in the folder where you run `rmterm`.
- Resumes the last Codex/Claude conversation by default.
- Streams terminal output to the mobile app over WebSocket.
- Lets the mobile app send messages, commands, and `Ctrl-C` to the owned PTY.
- Supports fixed ngrok URLs for remote access outside your local network.
- Uses a tall virtual terminal so long Codex/Claude responses are preserved for mobile scrollback.
- Crops the tall virtual terminal back to your visible desktop terminal height so the PC terminal does not get huge blank gaps.
- Keeps the bridge off until you explicitly run `rmterm`.

## Repository Layout

```text
bridge/   Node.js/TypeScript CLI, PTY bridge, HTTP/WebSocket server
mobile/   Expo React Native app
```

## Requirements

- Node.js and npm
- Codex CLI available as `codex`
- Claude Code CLI available as `claude`, if you want Claude support
- Expo Go or an Expo development build for the mobile app
- Optional: ngrok, if you want to connect from outside your local network

## Install

```powershell
npm install
npm run bridge:build
```

Create `.env` from `.env.example` and set a private token:

```powershell
Copy-Item .env.example .env
```

Example:

```env
RMTERM_HOST=127.0.0.1
RMTERM_PORT=8787
RMTERM_TOKEN=replace-with-a-long-random-token
RMTERM_NGROK_URL=https://your-fixed-domain.ngrok.app
RMTERM_ROWS=220
RMTERM_COLS=120
RMTERM_SCREEN_HISTORY_LINES=1200
```

Do not commit `.env`; it is ignored by Git.

## Link The CLI

To make `rmterm` callable from any folder:

```powershell
cd bridge
npm link
```

Then open any project folder and run:

```powershell
rmterm codex
rmterm claude
```

The folder where you run `rmterm` becomes the Codex/Claude working directory.

## Run Codex

```powershell
rmterm codex
```

By default this runs:

```powershell
codex --yolo --no-alt-screen resume --last
```

Start without resuming:

```powershell
rmterm codex --fresh
```

Resume a specific session:

```powershell
rmterm codex --resume <SESSION_ID>
```

## Run Claude Code

```powershell
rmterm claude
```

By default this runs:

```powershell
claude --dangerously-skip-permissions --continue
```

Start without resuming:

```powershell
rmterm claude --fresh
```

Resume a specific session:

```powershell
rmterm claude --resume <SESSION_NAME_OR_ID>
```

## Mobile App

Start Expo:

```powershell
npm run mobile:start
```

Open the app in Expo Go or an iOS simulator. The app is prefilled for the configured ngrok URL/token in this local build, but for a fresh setup use:

- URL: your `RMTERM_NGROK_URL`
- Token: your `RMTERM_TOKEN`

Tap `Connect` after `rmterm codex` or `rmterm claude` is running.

The app supports:

- live terminal viewing
- scrolling through terminal history
- input submission
- `Ctrl-C`
- dark connected terminal view
- landscape rotation only while connected

## ngrok

If you have a fixed ngrok domain, set it in `.env`:

```env
RMTERM_NGROK_URL=https://your-fixed-domain.ngrok-free.dev
```

When `rmterm codex` or `rmterm claude` starts, it also starts ngrok for the configured local port.

## Monitor-Only Mode

```powershell
rmterm start
```

This starts the bridge and ngrok without owning a Codex/Claude PTY. It is useful for hook/event ingestion, but it cannot reliably type into an already-running parent terminal. For live control from mobile, use `rmterm codex` or `rmterm claude`.

Stop the bridge:

```powershell
rmterm stop
```

Check status:

```powershell
rmterm status
```

## Hooks

`rmterm hook <source>` reads JSON from stdin and posts it to the local bridge with a short timeout. It exits successfully even when the bridge is off.

```powershell
rmterm hook codex
rmterm hook claude
```

Print hook setup guidance:

```powershell
rmterm init
```

## Terminal And Scrollback Tuning

`rmterm` runs Codex/Claude inside a taller virtual terminal than your visible desktop terminal so long responses are not truncated to the current screenful.

Useful settings:

```env
RMTERM_COLS=120
RMTERM_ROWS=220
RMTERM_SCROLLBACK_LINES=5000
RMTERM_SCREEN_HISTORY_LINES=1200
RMTERM_DESKTOP_RENDER=viewport
```

If long answers are still getting cut off, increase `RMTERM_ROWS` before starting `rmterm`:

```powershell
$env:RMTERM_ROWS="300"
rmterm codex
```

The default desktop renderer crops the tall virtual terminal back to your visible PC terminal height. To bypass that and print raw PTY output:

```powershell
$env:RMTERM_DESKTOP_RENDER="raw"
rmterm codex
```

## Scripts

```powershell
npm run bridge:build
npm run mobile:start
npm run typecheck
```

## Security Notes

- Use a long random `RMTERM_TOKEN`.
- Keep `.env` private.
- Treat your ngrok URL as sensitive while the bridge is running.
- The mobile app can send input to the PTY, so only share the URL/token with people you trust.
