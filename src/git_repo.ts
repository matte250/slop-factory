import { spawn } from "node:child_process";
import { log } from "./log.ts";

export type GitResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export async function git(cwd: string, args: string[]): Promise<GitResult> {
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
    child.stdout.on("data", (b) => stdout.push(b));
    child.stderr.on("data", (b) => stderr.push(b));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf-8"),
        stderr: Buffer.concat(stderr).toString("utf-8"),
      });
    });
  });
}

export async function gitOrThrow(cwd: string, args: string[]): Promise<GitResult> {
  const r = await git(cwd, args);
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
