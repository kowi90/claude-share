#!/usr/bin/env node
// claude-share manager: a small web app that lets people start their own
// claude-share instance on this server. Each instance is a separate
// `claude-share --headless` child process with its own public port, driven
// over the Node IPC channel.

import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { OAuthCredentials } from "@shared/platforms";
import type {
  ChildMessage,
  HeadlessStatus,
  ParentMessage,
} from "../claude-share/headless";
import uiHtml from "./ui.html" with { type: "text" };

// ── Config ──────────────────────────────────────────────────────────────────

const MANAGER_PORT = parseInt(process.env.MANAGER_PORT ?? "8080", 10);
const PORT_START = parseInt(process.env.SHARE_PORT_START ?? "2586", 10);
const PORT_END = parseInt(process.env.SHARE_PORT_END ?? String(PORT_START + 9), 10);
const ADVERTISE_HOST = process.env.ADVERTISE_HOST?.trim() || null;
const MANAGER_PASSWORD = process.env.MANAGER_PASSWORD ?? "";
const TUNNEL_ENABLED = process.env.TUNNEL !== "0" && process.env.TUNNEL !== "false";

const DURATIONS_H = [6, 24, 168] as const;
const SETUP_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

if (!Number.isInteger(PORT_START) || !Number.isInteger(PORT_END) || PORT_END < PORT_START) {
  process.stderr.write("SHARE_PORT_START / SHARE_PORT_END are invalid\n");
  process.exit(1);
}
if (!ADVERTISE_HOST) {
  process.stderr.write(
    "warning: ADVERTISE_HOST is not set — connect links will use the container's " +
      "internal IP and won't be reachable from other machines.\n",
  );
}

const here = path.dirname(fileURLToPath(import.meta.url));
const SHARE_ENTRY = [
  path.join(here, "../claude-share/index.js"),
  path.join(here, "../claude-share/index.ts"),
].find((f) => fs.existsSync(f));
if (!SHARE_ENTRY) {
  process.stderr.write("could not find the claude-share entry point\n");
  process.exit(1);
}

// ── Instances ───────────────────────────────────────────────────────────────

type InstanceState = "starting" | "running" | "stopped" | "failed";

interface Instance {
  id: string;
  ownerKeyHash: Buffer;
  name: string;
  port: number;
  tunnel: boolean;
  createdAt: Date;
  tokenExpiresAt: number;
  state: InstanceState;
  error: string | null;
  status: HeadlessStatus | null;
  child: ChildProcess | null;
}

const instances = new Map<string, Instance>();

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest();

function safeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function allocatePort(): number | null {
  const used = new Set(
    [...instances.values()].filter((i) => i.child).map((i) => i.port),
  );
  for (let port = PORT_START; port <= PORT_END; port++) {
    if (!used.has(port)) return port;
  }
  return null;
}

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
      return {
        accessToken: c.accessToken,
        refreshToken: c.refreshToken ?? "",
        expiresAt: c.expiresAt,
        scopes: c.scopes ?? [],
        subscriptionType: c.subscriptionType ?? "unknown",
        rateLimitTier: c.rateLimitTier,
      };
    } catch {
      return { error: "Credentials are not valid JSON" };
    }
  }
  if (raw.startsWith("sk-ant-oat")) {
    return {
      accessToken: raw,
      refreshToken: "",
      expiresAt: Date.now() + SETUP_TOKEN_LIFETIME_MS,
      scopes: ["user:inference"],
      subscriptionType: "unknown",
    };
  }
  if (raw.startsWith("sk-ant-api")) {
    return { error: "API keys are not supported — use a token from `claude setup-token`" };
  }
  return { error: "Unrecognised token — paste the output of `claude setup-token`" };
}

function startInstance(
  inst: Instance,
  credentials: OAuthCredentials,
  durationMs: number,
): void {
  const args = [
    SHARE_ENTRY!,
    "--headless",
    "--accept-terms",
    `--port=${inst.port}`,
    `--duration-ms=${durationMs}`,
  ];
  if (inst.tunnel) args.push("--tunnel");

  const env = { ...process.env };
  delete env.MANAGER_PASSWORD;

  const child = spawn(process.execPath, args, {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env,
  });
  inst.child = child;

  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000);
  });

  child.on("message", (msg: ChildMessage) => {
    if (msg?.type === "status") {
      inst.status = msg.status;
      if (inst.state === "starting") inst.state = "running";
    } else if (msg?.type === "fatal") {
      inst.error = msg.message;
    }
  });

  child.on("exit", (code) => {
    inst.child = null;
    if (code === 0) {
      inst.state = "stopped";
    } else {
      inst.state = "failed";
      inst.error ??= stderrTail.trim().split("\n").pop() || `exited with code ${code}`;
    }
    log(`instance ${inst.id.slice(0, 8)} on :${inst.port} exited (${code})`);
  });

  // Credentials go over IPC only — never argv, env or disk
  child.send({
    type: "init",
    credentials,
    systemName: inst.name,
  } satisfies ParentMessage);
}

function sendToChild(inst: Instance, msg: ParentMessage): void {
  if (inst.child?.connected) inst.child.send(msg);
}

function connectUrl(base: string | null, code: string): string | null {
  return base ? `claudeshare://${base.replace(/^https?:\/\//, "")}/connect/${code}` : null;
}

function serialize(inst: Instance) {
  const s = inst.status;
  const live = inst.state === "running" && s;
  // The connect link embeds the pairing code (the session's private key). It is
  // only handed to the instance owner, and only while the code is still unused.
  const showLink = live && !s.pairingCodeUsed;
  return {
    id: inst.id,
    name: inst.name,
    state: inst.state,
    error: inst.error,
    port: inst.port,
    tunnel: inst.tunnel,
    createdAt: inst.createdAt.toISOString(),
    tokenExpiresAt: new Date(inst.tokenExpiresAt).toISOString(),
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

function log(msg: string): void {
  process.stdout.write(`${new Date().toISOString()} ${msg}\n`);
}

// ── HTTP API ────────────────────────────────────────────────────────────────

const app = new Hono();

app.use("/api/*", bodyLimit({ maxSize: 64 * 1024 }));

app.get("/", (c) => c.html(uiHtml));

app.get("/api/config", (c) =>
  c.json({
    passwordRequired: MANAGER_PASSWORD !== "",
    tunnelAvailable: TUNNEL_ENABLED,
    advertiseHost: ADVERTISE_HOST,
    durationsHours: DURATIONS_H,
    freeSlots: PORT_END - PORT_START + 1 -
      [...instances.values()].filter((i) => i.child).length,
  }),
);

app.post("/api/instances", async (c) => {
  if (MANAGER_PASSWORD && !safeEqual(c.req.header("x-manager-password") ?? "", MANAGER_PASSWORD)) {
    return c.json({ error: "Wrong manager password" }, 401);
  }

  const body = await c.req
    .json<{
      name?: string;
      token?: string;
      durationHours?: number;
      tunnel?: boolean;
      acceptTerms?: boolean;
    }>()
    .catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  if (body.acceptTerms !== true) {
    return c.json({ error: "You must accept the terms" }, 400);
  }
  const name = (body.name ?? "").trim().slice(0, 64);
  if (!name) return c.json({ error: "Name is required" }, 400);
  const hours = body.durationHours as (typeof DURATIONS_H)[number];
  if (!DURATIONS_H.includes(hours)) {
    return c.json({ error: "Invalid duration" }, 400);
  }

  const creds = parseCredentials(body.token ?? "");
  if ("error" in creds) return c.json({ error: creds.error }, 400);
  if (creds.expiresAt <= Date.now()) {
    return c.json({ error: "This token has already expired" }, 400);
  }

  const port = allocatePort();
  if (port === null) return c.json({ error: "No free ports — all share slots are in use" }, 503);

  const ownerKey = crypto.randomBytes(32).toString("base64url");
  const inst: Instance = {
    id: crypto.randomUUID(),
    ownerKeyHash: sha256(ownerKey),
    name,
    port,
    tunnel: TUNNEL_ENABLED && body.tunnel === true,
    createdAt: new Date(),
    tokenExpiresAt: creds.expiresAt,
    state: "starting",
    error: null,
    status: null,
    child: null,
  };
  instances.set(inst.id, inst);
  startInstance(inst, creds, hours * 60 * 60 * 1000);
  log(`instance ${inst.id.slice(0, 8)} started on :${port}`);

  return c.json({ id: inst.id, ownerKey }, 201);
});

// Every per-instance route requires the owner key returned at creation.
// Unknown id and wrong key look identical so ids can't be probed.
function ownedInstance(id: string, key: string | undefined): Instance | null {
  const inst = instances.get(id);
  if (!inst || !crypto.timingSafeEqual(sha256(key ?? ""), inst.ownerKeyHash)) return null;
  return inst;
}
const NOT_FOUND = { error: "Not found" } as const;

app.get("/api/instances/:id", (c) => {
  const inst = ownedInstance(c.req.param("id"), c.req.header("x-owner-key"));
  return inst ? c.json(serialize(inst)) : c.json(NOT_FOUND, 404);
});

app.post("/api/instances/:id/regenerate", (c) => {
  const inst = ownedInstance(c.req.param("id"), c.req.header("x-owner-key"));
  if (!inst) return c.json(NOT_FOUND, 404);
  if (inst.state !== "running") return c.json({ error: "Instance is not running" }, 409);
  sendToChild(inst, { type: "regenerate" });
  return c.json({ ok: true });
});

app.post("/api/instances/:id/stop", (c) => {
  const inst = ownedInstance(c.req.param("id"), c.req.header("x-owner-key"));
  if (!inst) return c.json(NOT_FOUND, 404);
  sendToChild(inst, { type: "stop" });
  return c.json({ ok: true });
});

app.delete("/api/instances/:id", (c) => {
  const inst = ownedInstance(c.req.param("id"), c.req.header("x-owner-key"));
  if (!inst) return c.json(NOT_FOUND, 404);
  sendToChild(inst, { type: "stop" });
  const child = inst.child;
  if (child) setTimeout(() => child.kill("SIGKILL"), 5000).unref();
  instances.delete(inst.id);
  return c.json({ ok: true });
});

serve({ fetch: app.fetch, port: MANAGER_PORT, hostname: "0.0.0.0" }, () => {
  log(`claude-share manager listening on :${MANAGER_PORT}`);
  log(`share ports ${PORT_START}-${PORT_END}, advertised as ${ADVERTISE_HOST ?? "(auto)"}${ADVERTISE_HOST && !isIP(ADVERTISE_HOST) ? " (hostname)" : ""}`);
  if (!MANAGER_PASSWORD) log("MANAGER_PASSWORD is not set — anyone who can reach this page can create shares");
});

function shutdown() {
  for (const inst of instances.values()) sendToChild(inst, { type: "stop" });
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
