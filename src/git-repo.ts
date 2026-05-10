import { spawn } from "node:child_process";
import { log } from "./log.ts";
import { killProcessGroup } from "./subprocess.ts";

export type GitResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type GitOptions = {
  /** Kill the git process if it hasn't finished in this many ms. */
  timeoutMs?: number;
};

export async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
      // Own process group so we can kill helpers (git-remote-https, askpass,
      // ssh, etc.) on timeout. Without this, SIGTERM to git's PID alone leaves
      // orphan helpers holding stdio open and 'close' never fires, hanging
      // the loop indefinitely after the timeout warning logs.
      detached: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    let deadman: NodeJS.Timeout | null = null;

    const killTree = (signal: "SIGTERM" | "SIGKILL") =>
      killProcessGroup(child.pid, signal, `git ${args.join(" ")}`);

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (deadman) clearTimeout(deadman);
      fn();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      log.warn("git timeout, killing process group", { cwd, args, timeoutMs });
      killTree("SIGTERM");
      setTimeout(() => killTree("SIGKILL"), 5_000);
      // If 'close' still doesn't fire (orphan helper keeping stdio open),
      // force-resolve so the caller can move on instead of hanging forever.
      deadman = setTimeout(() => {
        if (!settled) {
          log.error("git deadman fired after timeout (close never arrived)", { cwd, args });
          settle(() => reject(new Error(`git ${args.join(" ")} timed out after ${timeoutMs}ms (deadman)`)));
        }
      }, 15_000);
    }, timeoutMs);

    child.stdout.on("data", (b) => stdout.push(b));
    child.stderr.on("data", (b) => stderr.push(b));
    child.on("error", (err) => {
      settle(() => reject(err));
    });
    child.on("close", (code) => {
      settle(() => {
        if (timedOut) {
          reject(new Error(`git ${args.join(" ")} timed out after ${timeoutMs}ms`));
          return;
        }
        resolve({
          exitCode: code ?? -1,
          stdout: Buffer.concat(stdout).toString("utf-8"),
          stderr: Buffer.concat(stderr).toString("utf-8"),
        });
      });
    });
  });
}

export async function gitOrThrow(cwd: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  const r = await git(cwd, args, opts);
  if (r.exitCode !== 0) {
    log.error("git failed", { cwd, args, exitCode: r.exitCode, stderr: r.stderr.slice(-500) });
    throw new Error(`git ${args.join(" ")} failed (exit ${r.exitCode}): ${r.stderr.slice(-500)}`);
  }
  return r;
}

/** Embed the PAT into an https remote URL so plain `git push` works without prompting. */
export function authedRemoteUrl(remote: string, token: string): string {
  const url = new URL(remote);
  url.username = "x-access-token";
  url.password = token;
  return url.toString();
}
