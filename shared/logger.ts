// File logger with daily rotation.
//
// Each logger writes to `<LOG_DIR>/<name>-YYYY-MM-DD.log` (UTC date). Files
// older than LOG_RETENTION_DAYS are deleted when the date rolls over, at
// startup, and hourly while the process runs.
//
// Env:
//   CLAUDE_SHARE_LOG_DIR     directory for log files (default ~/.claude-share/logs)
//   CLAUDE_SHARE_LOG_RETENTION_DAYS  days of old files to keep besides today
//                            (default 1: today + yesterday; 0: today only)
//
// Writes are synchronous so lines logged right before process.exit() land.
// Never log tokens, credentials or the full pairing code.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";

export const LOG_DIR =
  process.env.CLAUDE_SHARE_LOG_DIR?.trim() ||
  path.join(os.homedir(), ".claude-share", "logs");

const RETENTION_DAYS = (() => {
  const n = parseInt(process.env.CLAUDE_SHARE_LOG_RETENTION_DAYS ?? "", 10);
  return Number.isInteger(n) && n >= 0 ? n : 1;
})();

const DATED_FILE = /^.+-(\d{4}-\d{2}-\d{2})\.log$/;
const DAY_MS = 24 * 60 * 60 * 1000;

type Level = "DEBUG" | "INFO" | "WARN" | "ERROR";

let dirReady = false;
let warnedUnwritable = false;
let lastPrunedDate = "";
let pruneTimer: NodeJS.Timeout | null = null;

const today = () => new Date().toISOString().slice(0, 10);

/** Deletes dated log files older than the retention window. */
export function pruneOldLogs(): void {
  lastPrunedDate = today();
  const cutoff = Date.parse(lastPrunedDate) - RETENTION_DAYS * DAY_MS;
  let entries: string[];
  try {
    entries = fs.readdirSync(LOG_DIR);
  } catch {
    return;
  }
  for (const name of entries) {
    const m = DATED_FILE.exec(name);
    if (!m) continue;
    const fileDay = Date.parse(m[1]);
    if (Number.isFinite(fileDay) && fileDay < cutoff) {
      // Other processes may prune the same file concurrently
      try {
        fs.rmSync(path.join(LOG_DIR, name), { force: true });
      } catch {}
    }
  }
}

function formatExtra(extra: unknown): string {
  if (extra === undefined) return "";
  if (extra instanceof Error) return " " + (extra.stack ?? extra.message);
  if (typeof extra === "string") return " " + extra;
  // inspect handles circular refs and non-JSON values (unlike JSON.stringify)
  return " " + inspect(extra, { depth: 4, breakLength: Infinity });
}

function write(name: string, tag: string, level: Level, message: string, extra?: unknown): void {
  try {
    if (!dirReady) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      dirReady = true;
    }
    const date = today();
    if (date !== lastPrunedDate) pruneOldLogs();
    if (!pruneTimer) {
      pruneTimer = setInterval(pruneOldLogs, 60 * 60 * 1000);
      pruneTimer.unref();
    }
    const line = `${new Date().toISOString()} [${level}] [${tag}] ${message}${formatExtra(extra)}\n`;
    fs.appendFileSync(path.join(LOG_DIR, `${name}-${date}.log`), line);
  } catch (err) {
    // Logging must never crash the app, but say once why nothing is logged
    if (!warnedUnwritable) {
      warnedUnwritable = true;
      try {
        process.stderr.write(
          `warning: cannot write logs to ${LOG_DIR}: ${(err as Error).message}\n`,
        );
      } catch {}
    }
  }
}

export interface Logger {
  debug: (msg: string, extra?: unknown) => void;
  info: (msg: string, extra?: unknown) => void;
  warn: (msg: string, extra?: unknown) => void;
  error: (msg: string, extra?: unknown) => void;
}

/**
 * @param name file prefix, e.g. "share" → share-2026-11-20.log
 * @param tag  per-line tag; defaults to the pid so lines from concurrent
 *             processes sharing a file can be told apart
 */
export function createLogger(name: string, tag: string = `pid ${process.pid}`): Logger {
  const base = name.replace(/\.log$/, "");
  return {
    debug: (msg, extra) => write(base, tag, "DEBUG", msg, extra),
    info: (msg, extra) => write(base, tag, "INFO", msg, extra),
    warn: (msg, extra) => write(base, tag, "WARN", msg, extra),
    error: (msg, extra) => write(base, tag, "ERROR", msg, extra),
  };
}
