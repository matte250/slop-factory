import { log } from "./log.ts";

/**
 * Send `signal` to the entire process group of `pid` (negative pid = group).
 * Used so subprocesses spawned by long-running commands (opencode helpers,
 * git's git-remote-https / askpass, etc.) actually die when we kill the parent.
 *
 * Requires the parent to have been spawned with `detached: true` so it leads
 * its own process group. ESRCH (group already gone) is silenced; other errors
 * are logged but not thrown — kill is best-effort.
 */
export function killProcessGroup(
  pid: number | null | undefined,
  signal: "SIGTERM" | "SIGKILL",
  context?: string,
): void {
  if (pid == null) return;
  try {
    process.kill(-pid, signal);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") {
      log.warn("killProcessGroup failed", { signal, context, err: String(e) });
    }
  }
}
