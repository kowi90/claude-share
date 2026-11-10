import darwin from "./darwin";
import linux from "./linux";
import type { PlatformOps } from "./types";

const SUPPORTED = {
  darwin,
  linux,
} satisfies Partial<Record<NodeJS.Platform, PlatformOps>>;

type SupportedPlatform = keyof typeof SUPPORTED;

let _cached: PlatformOps | null = null;
let _override: Partial<PlatformOps> | null = null;

export function platform(): PlatformOps {
  if (_cached) return _cached;

  const p = process.platform as SupportedPlatform;
  if (!(p in SUPPORTED)) {
    process.stderr.write(
      `Unsupported platform: "${process.platform}". claude-share supports macOS (darwin) and Linux.\n`,
    );
    process.exit(1);
  }

  _cached = _override ? { ...SUPPORTED[p], ..._override } : SUPPORTED[p];
  return _cached;
}

/**
 * Replaces individual platform operations (e.g. credential reading in headless
 * mode, where credentials arrive over IPC instead of from the keychain).
 */
export function setPlatformOverride(ops: Partial<PlatformOps>): void {
  _override = ops;
  _cached = null;
}
