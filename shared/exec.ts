import { execFile, spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const IS_WINDOWS = process.platform === "win32";

/**
 * Locates a command on PATH. Returns its full path, or null when not found.
 *
 * On Windows a command can resolve to several files (npm installs `claude`,
 * `claude.cmd` and `claude.ps1` side by side). Real executables win over batch
 * shims; extension-less sh shims and .ps1 files are not directly runnable.
 */
export async function findExecutable(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(IS_WINDOWS ? "where" : "which", [name]);
    const found = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!IS_WINDOWS) return found[0] ?? null;

    const byExt = (exts: string[]) =>
      found.find((f) => exts.includes(path.extname(f).toLowerCase()));
    return byExt([".exe", ".com"]) ?? byExt([".cmd", ".bat"]) ?? null;
  } catch {
    return null;
  }
}

// Quotes one argument for a cmd.exe command line.
function quoteForCmd(arg: string): string {
  if (arg !== "" && !/[\s"&|<>^()%!,;=]/.test(arg)) return arg;
  // Double trailing backslashes so they don't escape the closing quote.
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

interface Resolved {
  file: string;
  args: string[];
  shell: boolean;
}

/**
 * Windows can't spawn .cmd/.bat shims (how npm exposes `claude`, `npm`, `pnpm`,
 * `yarn`) without a shell, so those are run through cmd.exe as one pre-quoted
 * command line. Everything else is spawned directly.
 */
async function resolveCommand(name: string, args: string[]): Promise<Resolved> {
  if (!IS_WINDOWS) return { file: name, args, shell: false };

  const file = (await findExecutable(name)) ?? name;
  const ext = path.extname(file).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return { file, args, shell: false };

  return {
    file: [`"${file}"`, ...args.map(quoteForCmd)].join(" "),
    args: [],
    shell: true,
  };
}

/** Cross-platform `spawn` that also works for .cmd shims on Windows. */
export async function spawnCommand(
  name: string,
  args: string[],
  options: SpawnOptions = {},
): Promise<ChildProcess> {
  const r = await resolveCommand(name, args);
  return spawn(r.file, r.args, { ...options, shell: r.shell, windowsHide: true });
}

/** Cross-platform `execFile` that also works for .cmd shims on Windows. */
export async function execCommand(
  name: string,
  args: string[],
  options: { timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const r = await resolveCommand(name, args);
  return execFileAsync(r.file, r.args, {
    ...options,
    shell: r.shell,
    windowsHide: true,
  });
}

/** PIDs of the processes listening on a local TCP port. */
export async function findPidsOnPort(port: number): Promise<string[]> {
  if (!IS_WINDOWS) {
    const { stdout } = await execFileAsync("lsof", ["-ti", `tcp:${port}`]).catch(
      () => ({ stdout: "" }),
    );
    return stdout.trim().split("\n").filter(Boolean);
  }

  // "  TCP    0.0.0.0:2586    0.0.0.0:0    LISTENING    1234"
  const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "tcp"]).catch(
    () => ({ stdout: "" }),
  );
  const pids = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0] !== "TCP" || cols[3] !== "LISTENING") continue;
    if (cols[1]!.endsWith(`:${port}`) && cols[4] !== "0") pids.add(cols[4]!);
  }
  return [...pids];
}

export async function killPids(pids: string[]): Promise<void> {
  if (IS_WINDOWS) {
    await execFileAsync("taskkill", ["/F", ...pids.flatMap((pid) => ["/PID", pid])]);
  } else {
    await execFileAsync("kill", ["-9", ...pids]);
  }
}
