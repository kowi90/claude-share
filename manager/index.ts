#!/usr/bin/env node
// claude-share manager: runs one always-on share of the Claude token configured
// on this server (CLAUDE_TOKEN / CLAUDE_TOKEN_FILE) and serves a web page where
// anyone with the manager password can see it, see which paired devices are
// online and request a fresh pairing link. The share is a separate
// `claude-share --headless` child process driven over the Node IPC channel.

import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { createLogger, LOG_DIR } from "@shared/logger";
import type { OAuthCredentials } from "@shared/platforms";
import type {
  ChildMessage,
  HeadlessStatus,
  ParentMessage,
} from "../claude-share/headless";
import uiHtml from "./ui.html" with { type: "text" };

// ── Logging ─────────────────────────────────────────────────────────────────
// Everything goes to stdout/stderr (docker logs) and to the daily log file.

const fileLog = createLogger("manager", "manager");

function log(msg: string, extra?: unknown): void {
  process.stdout.write(`${new Date().toISOString()} ${msg}\n`);
  fileLog.info(msg, extra);
}

function logError(msg: string, extra?: unknown): void {
  const detail = extra instanceof Error ? ` ${extra.stack ?? extra.message}` : extra !== undefined ? ` ${String(extra)}` : "";
  process.stderr.write(`${new Date().toISOString()} ERROR ${msg}${detail}\n`);
  fileLog.error(msg, extra);
}

/** Logs a fatal startup/config problem and exits with code 1. */
function die(msg: string): never {
  logError(msg);
  process.exit(1);
}

process.on("uncaughtException", (err) => {
  logError("uncaught exception", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  logError("unhandled rejection", reason);
  process.exit(1);
});
process.on("exit", (code) => {
  fileLog[code === 0 ? "info" : "error"](`manager exiting with code ${code}`);
});

log(`manager starting (node ${process.version}), logs in ${LOG_DIR}`);

// ── Config ──────────────────────────────────────────────────────────────────

const MANAGER_PORT = parseInt(process.env.MANAGER_PORT ?? "8080", 10);
const SHARE_PORT = parseInt(process.env.SHARE_PORT ?? process.env.SHARE_PORT_START ?? "2586", 10);
const ADVERTISE_HOST = process.env.ADVERTISE_HOST?.trim() || null;
const MANAGER_PASSWORD = process.env.MANAGER_PASSWORD ?? "";
const TUNNEL_ENABLED = process.env.TUNNEL === "1" || process.env.TUNNEL === "true";
const SHARE_NAME = process.env.SHARE_NAME?.trim().slice(0, 64) || "claude-share";

const SETUP_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_DURATION_MS = 365 * 24 * 60 * 60 * 1000;

if (!Number.isInteger(SHARE_PORT) || SHARE_PORT < 1 || SHARE_PORT > 65534) {
  die(`SHARE_PORT is invalid (${process.env.SHARE_PORT ?? process.env.SHARE_PORT_START})`);
}
if (!ADVERTISE_HOST) {
  logError(
    "warning: ADVERTISE_HOST is not set — connect links will use the container's " +
      "internal IP and won't be reachable from other machines.",
  );
}
if (!MANAGER_PASSWORD) {
  logError(
    "warning: MANAGER_PASSWORD is not set — anyone who can reach the web page " +
      "can get a pairing link and use the shared subscription.",
  );
}

const here = path.dirname(fileURLToPath(import.meta.url));
const SHARE_ENTRY = [
  path.join(here, "../claude-share/index.js"),
  path.join(here, "../claude-share/index.ts"),
].find((f) => fs.existsSync(f));
if (!SHARE_ENTRY) die(`could not find the claude-share entry point next to ${here}`);

// ── Credentials ─────────────────────────────────────────────────────────────

// OAuth tokens are URL-safe base64-ish; anything else would be rejected by
// Node as an HTTP header value and crash the share on its first request
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]+$/;

/**
 * Accepts either a long-lived token from `claude setup-token` (recommended) or
 * the JSON credentials blob Claude Code stores (`claudeAiOauth`). The JSON
 * form's access token expires within hours and is not refreshed here.
 */
function parseCredentials(input: string): OAuthCredentials | { error: string } {
  const raw = input.trim();
  if (raw.startsWith("{")) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const c = (obj.claudeAiOauth ?? obj) as Partial<OAuthCredentials>;
      if (typeof c.accessToken !== "string" || typeof c.expiresAt !== "number") {
        return { error: "JSON must contain claudeAiOauth.accessToken and expiresAt" };
      }
      const accessToken = c.accessToken.replace(/\s+/g, "");
      if (!TOKEN_RE.test(accessToken)) {
        return { error: "accessToken contains invalid characters" };
      }
      return {
        accessToken,
        refreshToken: c.refreshToken ?? "",
        expiresAt: c.expiresAt,
        scopes: c.scopes ?? [],
        subscriptionType: c.subscriptionType ?? "unknown",
        rateLimitTier: c.rateLimitTier,
      };
    } catch {
      return { error: "credentials are not valid JSON" };
    }
  }
  // A long token copied from a terminal often has line breaks where it wrapped
  const token = raw.replace(/\s+/g, "");
  if (token.startsWith("sk-ant-oat")) {
    if (!TOKEN_RE.test(token)) {
      return { error: "the token contains invalid characters — use only the sk-ant-oat… token" };
    }
    return {
      accessToken: token,
      refreshToken: "",
      expiresAt: Date.now() + SETUP_TOKEN_LIFETIME_MS,
      scopes: ["user:inference"],
      subscriptionType: "unknown",
    };
  }
  if (token.startsWith("sk-ant-api")) {
    return { error: "API keys are not supported — use a token from `claude setup-token`" };
  }
  return { error: "unrecognised token — use the output of `claude setup-token`" };
}

/** Reads the token from CLAUDE_TOKEN or the file in CLAUDE_TOKEN_FILE (Docker secrets). */
function loadCredentials(): OAuthCredentials {
  let raw = process.env.CLAUDE_TOKEN ?? "";
  const file = process.env.CLAUDE_TOKEN_FILE;
  if (!raw.trim() && file) {
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      die(`could not read CLAUDE_TOKEN_FILE ${file}: ${(err as Error).message}`);
    }
  }
  // Keep the token out of the environment so it never reaches a child process
  delete process.env.CLAUDE_TOKEN;
  if (!raw.trim()) {
    die("no Claude token configured — set CLAUDE_TOKEN (or CLAUDE_TOKEN_FILE) to the output of `claude setup-token`");
  }
  const creds = parseCredentials(raw);
  if ("error" in creds) die(`CLAUDE_TOKEN: ${creds.error}`);
  if (creds.expiresAt <= Date.now()) die("CLAUDE_TOKEN has already expired");
  return creds;
}

const credentials = loadCredentials();

// ── Share process ───────────────────────────────────────────────────────────

type ShareState = "starting" | "running" | "restarting" | "stopped" | "expired" | "failed";

const share = {
  state: "starting" as ShareState,
  error: null as string | null,
  status: null as HeadlessStatus | null,
  child: null as ChildProcess | null,
  startedAt: new Date(),
  restartAt: null as Date | null,
};

const label = `share :${SHARE_PORT}`;
let restartTimer: NodeJS.Timeout | null = null;
let failures = 0;
let shuttingDown = false;
/** Set by "Stop share": the share stays down until started again */
let stopRequested = false;

const tokenExpired = () => credentials.expiresAt <= Date.now();

function markExpired(): void {
  share.state = "expired";
  share.error = "The Claude token has expired — set a new CLAUDE_TOKEN and restart the container.";
  share.restartAt = null;
  logError(`${label} not restarting: token expired`);
}

function scheduleRestart(delayMs: number): void {
  if (shuttingDown || stopRequested) return;
  if (tokenExpired()) return markExpired();
  share.restartAt = new Date(Date.now() + delayMs);
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startShare();
  }, delayMs);
}

function startShare(): void {
  if (tokenExpired()) return markExpired();
  stopRequested = false;
  // The share lives exactly as long as the token; devices are removed by hand
  const durationMs = Math.min(credentials.expiresAt - Date.now(), MAX_DURATION_MS);
  const args = [
    SHARE_ENTRY!,
    "--headless",
    "--accept-terms",
    `--port=${SHARE_PORT}`,
    `--duration-ms=${Math.max(1, Math.floor(durationMs))}`,
  ];
  if (TUNNEL_ENABLED) args.push("--tunnel");

  const env = { ...process.env };
  delete env.MANAGER_PASSWORD;
  delete env.CLAUDE_TOKEN;
  delete env.CLAUDE_TOKEN_FILE;

  share.state = "starting";
  share.error = null;
  share.status = null;
  share.startedAt = new Date();
  share.restartAt = null;

  const child = spawn(process.execPath, args, {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env,
  });
  share.child = child;
  log(`${label} spawned (pid ${child.pid}, tunnel=${TUNNEL_ENABLED}, duration=${durationMs}ms)`);

  child.on("error", (err) => logError(`${label} process error`, err));

  // Keep a tail for the UI error message and log every stderr line
  let stderrTail = "";
  let partial = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stderrTail = (stderrTail + text).slice(-2000);
    const lines = (partial + text).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) logError(`${label} stderr: ${line}`);
  });
  child.stderr?.on("end", () => {
    if (partial.trim()) logError(`${label} stderr: ${partial}`);
    partial = "";
  });

  child.on("message", (msg: ChildMessage) => {
    if (share.child !== child) return;
    if (msg?.type === "status") {
      share.status = msg.status;
      if (share.state === "starting") {
        share.state = "running";
        log(`${label} running`);
      }
    } else if (msg?.type === "fatal") {
      share.error = msg.message;
      logError(`${label} reported fatal error: ${msg.message}`);
    }
  });

  child.on("exit", (code, signal) => {
    if (share.child !== child) return;
    share.child = null;
    share.status = null;
    const how = signal ? `killed by ${signal}` : `exited with code ${code}`;
    if (shuttingDown) return;
    if (stopRequested) {
      share.state = "stopped";
      share.error = null;
      log(`${label} ${how}, stopped on request`);
    } else if (code === 0) {
      // Session ran out (token expiry) or a restart was requested
      log(`${label} ${how}, starting a new session`);
      failures = 0;
      share.state = "restarting";
      scheduleRestart(1000);
    } else {
      share.error ??= stderrTail.trim().split("\n").pop() || how;
      // Reset the backoff if it had been running for a while
      if (Date.now() - share.startedAt.getTime() > 5 * 60_000) failures = 0;
      failures++;
      const delay = Math.min(5000 * 2 ** (failures - 1), 5 * 60_000);
      share.state = "failed";
      logError(`${label} ${how}: ${share.error} (see share-*.log), retrying in ${delay / 1000}s`);
      scheduleRestart(delay);
    }
  });

  // Credentials go over IPC only — never argv, env or disk
  child.send({
    type: "init",
    credentials,
    systemName: SHARE_NAME,
  } satisfies ParentMessage);
}

function sendToChild(msg: ParentMessage): void {
  if (share.child?.connected) share.child.send(msg);
}

function connectUrl(base: string | null, code: string): string | null {
  return base ? `claudeshare://${base.replace(/^https?:\/\//, "")}/connect/${code}` : null;
}

function serialize() {
  const s = share.status;
  const live = share.state === "running" && s;
  // The connect link embeds the pairing code (the session's private key). It is
  // only shown behind the manager password, and only while still unused.
  const showLink = live && !s.pairingCodeUsed;
  return {
    name: SHARE_NAME,
    state: share.state,
    error: share.error,
    port: SHARE_PORT,
    tunnel: TUNNEL_ENABLED,
    startedAt: share.startedAt.toISOString(),
    restartAt: share.restartAt?.toISOString() ?? null,
    tokenExpiresAt: new Date(credentials.expiresAt).toISOString(),
    sharedUntil: s?.sharedUntil ?? null,
    tunnelDown: s?.tunnelDown ?? false,
    pairingCodeUsed: s?.pairingCodeUsed ?? false,
    connect: {
      lan: showLink ? connectUrl(s.lanUrl, s.pairingCode) : null,
      public: showLink ? connectUrl(s.publicUrl, s.pairingCode) : null,
    },
    machines: live ? s.machines : [],
  };
}

// ── HTTP API ────────────────────────────────────────────────────────────────

const app = new Hono();

app.use("/api/*", bodyLimit({ maxSize: 64 * 1024 }));

app.get("/", (c) => c.html(uiHtml));

// Not gated: tells the page whether to ask for a password
app.get("/api/config", (c) => c.json({ passwordRequired: MANAGER_PASSWORD !== "" }));

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest();
const safeEqual = (a: string, b: string) => crypto.timingSafeEqual(sha256(a), sha256(b));

// Slows down password guessing: after too many wrong attempts in a minute,
// everyone is locked out until the window passes.
const MAX_FAILURES_PER_MINUTE = 10;
let failureWindowStart = 0;
let failureCount = 0;

app.use("/api/share/*", async (c, next) => {
  if (!MANAGER_PASSWORD) return next();
  const now = Date.now();
  if (now - failureWindowStart > 60_000) {
    failureWindowStart = now;
    failureCount = 0;
  }
  if (failureCount >= MAX_FAILURES_PER_MINUTE) {
    return c.json({ error: "Too many wrong passwords — try again in a minute" }, 429);
  }
  if (!safeEqual(c.req.header("x-manager-password") ?? "", MANAGER_PASSWORD)) {
    failureCount++;
    if (failureCount === MAX_FAILURES_PER_MINUTE) logError("too many wrong manager passwords, locking for a minute");
    return c.json({ error: "Wrong manager password" }, 401);
  }
  return next();
});

app.get("/api/share", (c) => c.json(serialize()));

app.post("/api/share/regenerate", (c) => {
  if (share.state !== "running") return c.json({ error: "The share is not running" }, 409);
  log(`${label} new pairing link requested`);
  sendToChild({ type: "regenerate" });
  return c.json({ ok: true });
});

app.post("/api/share/machines/:id/remove", (c) => {
  if (share.state !== "running") return c.json({ error: "The share is not running" }, 409);
  const id = c.req.param("id");
  const machine = share.status?.machines.find((m) => m.id === id);
  if (!machine) return c.json({ error: "No such device" }, 404);
  log(`${label} removing device "${machine.name}"`);
  sendToChild({ type: "unpair", machineId: id });
  // Drop it from the cached status right away so the page updates immediately
  share.status!.machines = share.status!.machines.filter((m) => m.id !== id);
  return c.json({ ok: true });
});

function stopChild(): void {
  const child = share.child;
  if (!child) return;
  sendToChild({ type: "stop" });
  setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 5000).unref();
}

// Stops the share and keeps it down. All pairings are lost.
app.post("/api/share/stop", (c) => {
  log(`${label} stop requested`);
  stopRequested = true;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  share.restartAt = null;
  if (share.child) stopChild();
  else share.state = "stopped";
  return c.json({ ok: true });
});

app.post("/api/share/start", (c) => {
  if (share.child) return c.json({ error: "The share is already running" }, 409);
  if (tokenExpired()) return c.json({ error: "The Claude token has expired" }, 409);
  log(`${label} start requested`);
  failures = 0;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  startShare();
  return c.json({ ok: true });
});

const server = serve({ fetch: app.fetch, port: MANAGER_PORT, hostname: "0.0.0.0" }, () => {
  log(`claude-share manager listening on :${MANAGER_PORT}`);
  log(`share "${SHARE_NAME}" on port ${SHARE_PORT}, advertised as ${ADVERTISE_HOST ?? "(auto)"}${ADVERTISE_HOST && !isIP(ADVERTISE_HOST) ? " (hostname)" : ""}`);
  startShare();
});

server.on("error", (err) => {
  logError(`manager HTTP server error on :${MANAGER_PORT}`, err);
  process.exit(1);
});

function shutdown(signal: string) {
  log(`received ${signal}, stopping the share`);
  shuttingDown = true;
  if (restartTimer) clearTimeout(restartTimer);
  sendToChild({ type: "stop" });
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
