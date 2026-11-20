# claude-share

Securely share your Claude Code subscription with others.

One machine runs **claude-share** to expose its Claude credentials through a local proxy. Other machines run **claude-connect** to connect and use Claude Code as if they had their own subscription.

---

## How it works

```
Receiver machine                    Sharer machine
─────────────────                   ──────────────────────────────
claude (CLI)                        claude-share
  │                                   │
  │  HTTPS_PROXY=...                  ├─ MITM proxy (intercepts Anthropic API calls)
  └──────────────────────────────────>│    injects sharer's OAuth token
                                      │
                                      ├─ Hono API (pairing, health, CA cert)
                                      │
                                      └─ bore tunnel (public URL via bore.pub)
```

- The sharer's OAuth token is read from the local Claude Code credential store (macOS Keychain, or `~/.claude/.credentials.json` on Linux and Windows) and injected per-request inside the MITM proxy — it is never written to disk or sent to the receiver.
- The receiver installs a temporary CA cert (valid only for the session) so the MITM can intercept Anthropic traffic. Non-Anthropic domains pass through as an opaque TCP tunnel — never inspected.
- Pairing uses a one-time code. Once paired, credentials are saved so reconnecting skips the pairing step.

---

## Install

```bash
npm install -g @0xpv/claude-share
```

This installs both `claude-share` and `claude-connect` binaries.

### Install this fork (from source)

The fork at [kowi90/claude-share](https://github.com/kowi90/claude-share) isn't published to npm, so build it from source. You need [Node.js](https://nodejs.org) 18+, [git](https://git-scm.com) and [Bun](https://bun.sh) (Bun is only used for the build step).

Install Bun if you don't have it:

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"
```

Then clone, build and install globally (same commands on macOS, Linux and Windows):

```bash
git clone https://github.com/kowi90/claude-share.git
cd claude-share
bun install
bun run build
npm install -g .
```

This puts `claude-share` and `claude-connect` on your PATH, just like the npm package. npm links the global install to this folder, so don't delete or move it. If you already have `@0xpv/claude-share` installed, uninstall it first (`npm uninstall -g @0xpv/claude-share`) so the two don't conflict.

To update later:

```bash
cd claude-share
git pull
bun install
bun run build
npm install -g .
```

To uninstall: `npm uninstall -g @0xpv/claude-share`.

### Platform support

| Platform | Sharer (`claude-share`) | Receiver (`claude-connect`) | bore install (internet sharing) |
| --- | --- | --- | --- |
| macOS | ✅ | ✅ | `brew install bore-cli` (or `cargo install bore-cli`) |
| Linux | ✅ | ✅ | downloaded automatically to `~/.local/bin/bore` |
| Windows 10+ | ✅ | ✅ | downloaded automatically to `%USERPROFILE%\.local\bin\bore.exe` |

On Windows, run the commands from PowerShell, Command Prompt or Windows Terminal. Claude Code can be installed either natively or through npm.

---

## Quickstart

### Sharer

```bash
claude-share
```

Requires [bore](https://github.com/ekzhang/bore) for internet sharing. If bore is not installed you'll be prompted to install it (see [Platform support](#platform-support)) — decline to share on LAN only.

The TUI shows connection URLs. Share the **Public** URL with receivers over the internet, or the **LAN** URL for local network.

**Keys:** `c` copy URL · `q` quit

### Receiver

```bash
# First time — paste the connect URL from the sharer's TUI
claude-connect --share <connect-url>

# Subsequent runs — pick from saved connections
claude-connect
```

The receiver configures Claude Code to route through the proxy and installs the session CA cert automatically. Everything is cleaned up on exit.

---

## One-time use (npx)

```bash
# Sharer
npx @0xpv/claude-share

# Receiver
npx -p @0xpv/claude-share claude-connect --share <connect-url>
```

---

## Docker server with web interface

Run an always-on share of one Claude subscription on a server. Any device can pair itself from the web page.

```bash
claude setup-token          # on your own machine; copy the sk-ant-oat… token
cp .env.docker.example .env # set ADVERTISE_HOST, CLAUDE_TOKEN and MANAGER_PASSWORD
docker compose up -d --build
```

The share starts with the container. Open `http://<server>:8080` from any machine and enter the manager password. The page shows the same view to everyone: a one-time `claudeshare://` link (run `claude-connect --share <link>` on the device to pair), a **New pairing link** button for the next device, and the paired devices with whether each one is connected right now. Devices stay paired until you **Remove** them (which also cuts their open connections) or the token expires; the share lives exactly as long as the token. **Stop share** takes it down until you start it again.

| Variable | Purpose |
| --- | --- |
| `ADVERTISE_HOST` | **Required.** IP or hostname receivers use to reach the server. Goes into the connect links and the TLS certificate. |
| `CLAUDE_TOKEN` | **Required.** Output of `claude setup-token`. Or set `CLAUDE_TOKEN_FILE` to a file holding it (e.g. a Docker secret). |
| `MANAGER_PASSWORD` | Required to open the web page. Leave it empty only on a fully trusted network: anyone who can open the page can pair a device. |
| `SHARE_NAME` | Name shown to receivers and as the page title (default `claude-share`). |
| `SHARE_PORT` | Port of the share (default `2586`). Must match the `ports:` mapping, with host port = container port. |
| `TUNNEL` | `1` also exposes the share over the internet via bore. |
| `BORE_SERVER` / `BORE_PASSWORD` | Build args for a self-hosted bore server. |
| `LOG_HOST_DIR` | Host directory for log files (default `./logs`). Must be writable by uid 1000: `mkdir -p logs && sudo chown 1000:1000 logs`. |
| `LOG_RETENTION_DAYS` | Days of old log files kept besides today's (default `1`, `0` = today only). |

Logs go to `manager-YYYY-MM-DD.log` (the web manager, plus each share's stderr and exit code) and `share-YYYY-MM-DD.log` (every share process, tagged with pid and port). A new file starts each day (UTC) and older ones are deleted. When a share fails, look up its port in `share-*.log`: the reason is logged just before `process exiting with code 1`. Tokens and pairing codes are never logged.

The share runs as a `claude-share --headless` child process. The manager hands it the token over IPC, so the token never reaches its argv, environment or disk. The manager restarts the share when it crashes (with backoff). Once the token expires the page says so and the share stays down until you set a new `CLAUDE_TOKEN`. Pairings live in memory, so after stopping the share or restarting the container every device has to pair again with a new link.

The web interface is plain HTTP and shows the connect link, which contains the pairing key. Put it behind an HTTPS reverse proxy, or only reach it over a trusted network.

---

## Requirements

- **macOS, Linux or Windows 10+** with **Node.js 18+** on both machines
- **bore** on the sharer machine for internet sharing (`brew install bore-cli` on macOS; downloaded automatically on Linux and Windows when you accept the prompt)
- The sharer must be logged in to Claude Code (`claude login`)
- The receiver must have Claude Code installed

---

## Security model

- The sharer's OAuth token is read from the macOS Keychain (or `~/.claude/.credentials.json` on Linux and Windows) and injected into requests in-memory. It is never transmitted to the receiver. In Docker it is passed to the share process over IPC and never written to disk.
- Only these Anthropic endpoints are proxied: `POST /v1/messages`, `GET /v1/models`, `/api/hello`, and OAuth flows on `platform.anthropic.com` / `platform.claude.com`.
- File upload (`/v1/files`), fine-tuning, and assistants endpoints are blocked.
- All non-Anthropic HTTPS traffic passes through as an opaque TCP tunnel — the proxy never sees the contents.
- Sessions expire after the duration chosen at startup (6h / 24h / 1 week).

---

## Development

```bash
# Sharer
bun run dev:share

# Receiver
bun run dev:connect --share <connect-url>

# Web manager (Docker server mode)
ADVERTISE_HOST=127.0.0.1 bun run dev:manager
```

Set `TUNNEL=0` to skip the bore tunnel during local development.

Build: `bun run build` — compiles both binaries and the manager into `dist/`.
