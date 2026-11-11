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

Run claude-share on a server so several people can each start their own share from a browser.

```bash
cp .env.docker.example .env # set ADVERTISE_HOST (and MANAGER_PASSWORD)
docker compose up -d --build
```

Open `http://<server>:8080`, paste a token from `claude setup-token`, pick a duration and press **Start share**. The page shows a one-time `claudeshare://` link to send to the receiver, who runs `claude-connect --share <link>` as usual.

| Variable | Purpose |
| --- | --- |
| `ADVERTISE_HOST` | **Required.** IP or hostname receivers use to reach the server. Goes into the connect links and the TLS certificate. |
| `MANAGER_PASSWORD` | Required to create shares when set. Leave empty to let anyone who can reach the page create one. |
| `SHARE_PORT_START` / `SHARE_PORT_END` | Port range, one port per concurrent share (default `2586`–`2595`). Must match the `ports:` mapping, with host port = container port. |
| `TUNNEL` | `0` hides the bore internet tunnel option. |
| `BORE_SERVER` / `BORE_PASSWORD` | Build args for a self-hosted bore server. |

Each share runs as its own `claude-share --headless` process. The token is handed to it over IPC and never written to disk, so shares don't survive a container restart: start them again from the page. Each share is managed only from the browser that created it.

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
