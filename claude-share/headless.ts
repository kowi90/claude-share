// Headless mode: claude-share runs without a TTY, driven by a parent process
// (the web manager) over the Node IPC channel. Credentials arrive over IPC so
// they are never written to disk or put in the environment.

import { setPlatformOverride, type OAuthCredentials } from "@shared/platforms";
import { getSession, regeneratePairingCode } from "./session/manager";

export interface HeadlessMachine {
  id: string;
  name: string;
  pairedAt: string;
  lastActiveAt: string;
  active: boolean;
  sessions: number;
}

export interface HeadlessStatus {
  port: number;
  publicUrl: string | null;
  lanUrl: string | null;
  /** Full pairing code — only ever sent to the parent over IPC, never over HTTP by this process */
  pairingCode: string;
  pairingCodeUsed: boolean;
  sharedUntil: string;
  tunnelDown: boolean;
  machines: HeadlessMachine[];
}

export type ParentMessage =
  | { type: "init"; credentials: OAuthCredentials; systemName?: string }
  | { type: "regenerate" }
  | { type: "stop" };

export type ChildMessage =
  | { type: "status"; status: HeadlessStatus }
  | { type: "fatal"; message: string };

export const HEADLESS = process.argv.includes("--headless");

function send(msg: ChildMessage): void {
  if (process.send && process.connected) process.send(msg);
}

/** Reports a fatal error to the parent (and stderr), then exits. */
export async function headlessFail(message: string): Promise<never> {
  process.stderr.write(`claude-share: ${message}\n`);
  if (process.send && process.connected) {
    await new Promise<void>((resolve) =>
      process.send!({ type: "fatal", message } satisfies ChildMessage, () =>
        resolve(),
      ),
    );
  }
  process.exit(1);
}

/** Reads a flag value given as `--name=value` or `--name value`. */
export function flagValue(name: string): string | null {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = argv.indexOf(name);
  return idx !== -1 ? (argv[idx + 1] ?? null) : null;
}

/**
 * Waits for the parent's `init` message and installs its credentials as the
 * platform credential source. Resolves with the optional display name.
 */
export async function receiveInit(): Promise<{ systemName?: string }> {
  if (!process.send) {
    return headlessFail(
      "--headless must be launched by the manager (no IPC channel available)",
    );
  }

  const init = await new Promise<Extract<ParentMessage, { type: "init" }> | null>(
    (resolve) => {
      const timer = setTimeout(() => resolve(null), 30_000);
      const onMessage = (msg: ParentMessage) => {
        if (msg?.type !== "init") return;
        clearTimeout(timer);
        process.off("message", onMessage);
        resolve(msg);
      };
      process.on("message", onMessage);
    },
  );
  if (!init) return headlessFail("timed out waiting for credentials");

  const creds = init.credentials;
  if (!creds?.accessToken) return headlessFail("no access token provided");
  if (creds.expiresAt <= Date.now()) {
    return headlessFail("the provided Claude token has already expired");
  }

  setPlatformOverride({
    readOAuthCredentials: async () => creds,
    credentialsExist: async () => true,
  });
  return { systemName: init.systemName };
}

/**
 * Sends status to the parent every second and handles its commands.
 * Exits via `onStop` when told to stop or when the parent goes away, so no
 * orphaned instances keep running.
 */
export function startHeadlessReporting(
  getStatus: () => Omit<HeadlessStatus, "pairingCode" | "pairingCodeUsed" | "machines">,
  onStop: () => void,
): void {
  const report = () => {
    const session = getSession();
    if (!session) return;
    send({
      type: "status",
      status: {
        ...getStatus(),
        pairingCode: session.pairingCode,
        pairingCodeUsed: session.pairingCodeUsed,
        machines: [...session.machines.values()].map((m) => {
          const sessions = [...m.sessions.values()];
          const last = sessions.reduce(
            (latest, s) => (s.lastActiveAt > latest ? s.lastActiveAt : latest),
            m.pairedAt,
          );
          return {
            id: m.id,
            name: m.name,
            pairedAt: m.pairedAt.toISOString(),
            lastActiveAt: last.toISOString(),
            active: sessions.some((s) => s.active),
            sessions: sessions.length,
          };
        }),
      },
    });
  };

  report();
  setInterval(report, 1000);

  process.on("message", (msg: ParentMessage) => {
    if (msg?.type === "regenerate") {
      const session = getSession();
      if (session) regeneratePairingCode(session);
      report();
    } else if (msg?.type === "stop") {
      onStop();
    }
  });
  process.on("disconnect", onStop);
}
