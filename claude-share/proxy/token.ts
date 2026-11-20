import { platform } from "@shared/platforms";
import type { OAuthCredentials } from "@shared/platforms";
import { logger } from "../logger";

// In-memory only — token never written to disk
let cached: OAuthCredentials | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

// Claude Code manages the OAuth refresh cycle on the sharer's machine and writes
// the updated token back to its credential store. We re-read before expiry so
// we're never caught with a stale token.
function scheduleTokenReread(creds: OAuthCredentials): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  // Capped: setTimeout fires immediately for delays over 2^31-1 ms (~24.8 days),
  // which a year-long `claude setup-token` token would otherwise hit in a loop
  const msUntilReread = Math.min(
    Math.max(creds.expiresAt - Date.now() - 5 * 60 * 1000, 60_000),
    24 * 60 * 60 * 1000,
  );
  refreshTimer = setTimeout(async () => {
    try {
      cached = await platform().readOAuthCredentials();
      scheduleTokenReread(cached);
    } catch (err) {
      logger.error("[token] credential re-read failed", err);
      refreshTimer = setTimeout(() => scheduleTokenReread(creds), 60_000);
      refreshTimer.unref();
    }
  }, msUntilReread);
  refreshTimer.unref();
}

export async function initToken(): Promise<void> {
  cached = await platform().readOAuthCredentials();
  scheduleTokenReread(cached);
}

export function getAccessToken(): string {
  if (!cached)
    throw new Error("Token not initialized — call initToken() first");
  return cached.accessToken;
}

export function getSubscriptionType(): string {
  return cached?.subscriptionType ?? "unknown";
}

export function stopTokenRefresh(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  cached = null;
}
