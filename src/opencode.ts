import { spawn } from "node:child_process";
import { loadConfig } from "./config.ts";
import { log } from "./log.ts";

export type OpenCodeRunOptions = {
  sandboxDir: string;
  prompt: string;
  signal?: AbortSignal;
};

export type OpenCodeRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
};

export async function runOpenCode(opts: OpenCodeRunOptions): Promise<OpenCodeRunResult> {
  const cfg = loadConfig();
  const args = [
    "run",
    "--model",
    cfg.OPENCODE_MODEL,
    "--dir",
    opts.sandboxDir,
    opts.prompt,
  ];

  log.info("opencode.run starting", {
    model: cfg.OPENCODE_MODEL,
    dir: opts.sandboxDir,
    promptLen: opts.prompt.length,
  });

  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(cfg.OPENCODE_BIN, args, {
      cwd: opts.sandboxDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    child.stdout.on("data", (b: Buffer) => stdoutChunks.push(b));
    child.stderr.on("data", (b: Buffer) => stderrChunks.push(b));

    const timeout = setTimeout(() => {
      timedOut = true;
      log.warn("opencode.run timeout, killing", { ms: cfg.OPENCODE_TIMEOUT_MS });
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 5_000);
    }, cfg.OPENCODE_TIMEOUT_MS);

    const onAbort = () => {
      log.warn("opencode.run aborted via signal");
      child.kill("SIGTERM");
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err) => {
      clearTimeout(timeout);
      opts.signal?.removeEventListener("abort", onAbort);
      log.error("opencode.run spawn error", { err: String(err) });
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      opts.signal?.removeEventListener("abort", onAbort);
      const result: OpenCodeRunResult = {
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        timedOut,
        durationMs: Date.now() - startedAt,
      };
      log.info("opencode.run finished", {
        exitCode: result.exitCode,
        timedOut,
        durationMs: result.durationMs,
        stdoutLen: result.stdout.length,
        stderrLen: result.stderr.length,
      });
      resolve(result);
    });
  });
}
