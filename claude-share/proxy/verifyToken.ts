import * as p from "@clack/prompts";

import { execCommand } from "@shared/exec";
import { platform } from "@shared/platforms";
import { logger } from "../logger";
import { initToken } from "./token";

async function spawnClaudeForRefresh(): Promise<void> {
  try {
    await execCommand("claude", ["-p", "HI"], { timeout: 60_000 });
  } catch (err) {
    if ((err as { killed?: boolean }).killed) {
      throw new Error("Claude process timed out after 60s");
    }
    // Non-zero exit is acceptable — the OAuth refresh can succeed even if the
    // prompt itself fails (e.g. rate limit, no Pro plan, etc.).
  }
}

export async function verifyTokenOrExit(): Promise<void> {
  const creds = await platform().readOAuthCredentials().catch(() => null);

  if (!creds) {
    p.log.error(
      "Could not read Anthropic credentials from the credential store.\n" +
        "Please run 'claude' to log in, then restart claude-share.",
    );
    process.exit(1);
  }

  if (creds.expiresAt > Date.now()) return; // token is still valid by clock

  logger.warn("[token] access token is expired, attempting refresh via Claude");
  p.log.warn("Your Anthropic access token is expired.");

  if (!creds.refreshToken) {
    p.log.error(
      "No refresh token found — cannot refresh automatically.\n" +
        "Run 'claude' to log in again, then restart claude-share.",
    );
    process.exit(1);
  }

  const spin = p.spinner();
  spin.start("Launching Claude to refresh the token...");

  let spawnOk = false;
  try {
    await spawnClaudeForRefresh();
    spawnOk = true;
  } catch (err) {
    logger.warn("[token] claude spawn error", err);
  }

  spin.stop(spawnOk ? "Claude process exited." : "Claude process failed — checking credentials anyway.");

  // Re-read and re-cache the (hopefully refreshed) credentials.
  try {
    await initToken();
  } catch {
    p.log.error(
      "Could not read credentials after refresh attempt.\n" +
        "Check that 'claude' is working: claude -p \"hello\"\n" +
        "If it fails, re-login: claude logout && claude login",
    );
    process.exit(1);
  }

  const fresh = await platform().readOAuthCredentials().catch(() => null);
  if (!fresh || fresh.expiresAt <= Date.now()) {
    p.log.error(
      "Token is still expired after the refresh attempt.\n" +
        "Your Claude may not be working correctly.\n" +
        "Try: claude -p \"hello\"\n" +
        "If it fails, re-login: claude logout && claude login",
    );
    process.exit(1);
  }

  p.log.success("Token refreshed successfully.");
}
