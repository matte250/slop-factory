import { spawn } from "node:child_process";
import { log } from "./log.ts";

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
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log.warn("git timeout, killing", { cwd, args, timeoutMs });
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5_000);
    }, timeoutMs);
    child.stdout.on("data", (b) => stdout.push(b));
    child.stderr.on("data", (b) => stderr.push(b));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
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
