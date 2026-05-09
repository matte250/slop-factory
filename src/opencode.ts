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
      // Put opencode in its own process group so we can kill the whole tree
      // (opencode spawns subprocesses; a SIGTERM to the parent alone leaves
      // orphans holding stdio open, which prevents the 'close' event from
      // firing and hangs the loop forever).
      detached: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    child.stdout.on("data", (b: Buffer) => stdoutChunks.push(b));
    child.stderr.on("data", (b: Buffer) => stderrChunks.push(b));

    const killTree = (signal: "SIGTERM" | "SIGKILL") => {
      if (child.pid == null) return;
      try {
        process.kill(-child.pid, signal);
      } catch (e) {
        // ESRCH = group already gone, fine
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") {
          log.warn("opencode.run kill failed", { signal, err: String(e) });
        }
      }
    };

    const settle = (result: OpenCodeRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(deadman);
      opts.signal?.removeEventListener("abort", onAbort);
      log.info("opencode.run finished", {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        stdoutLen: result.stdout.length,
        stderrLen: result.stderr.length,
      });
      resolve(result);
    };

    const buildResult = (exitCode: number): OpenCodeRunResult => ({
      exitCode,
      stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
      stderr: Buffer.concat(stderrChunks).toString("utf-8"),
      timedOut,
      durationMs: Date.now() - startedAt,
    });

    let deadman: NodeJS.Timeout = setTimeout(() => {}, 0);
    clearTimeout(deadman);

    const timeout = setTimeout(() => {
      timedOut = true;
      log.warn("opencode.run timeout, killing process group", { ms: cfg.OPENCODE_TIMEOUT_MS });
      killTree("SIGTERM");
      setTimeout(() => killTree("SIGKILL"), 5_000);
      // Last-resort: if 'close' never fires (orphan process holding stdio),
      // force-resolve so the loop can retry instead of hanging forever.
      deadman = setTimeout(() => {
        if (!settled) {
          log.error("opencode.run deadman fired (close event never arrived)", {
            graceMs: 15_000,
          });
          settle(buildResult(-1));
        }
      }, 15_000);
    }, cfg.OPENCODE_TIMEOUT_MS);

    const onAbort = () => {
      log.warn("opencode.run aborted via signal");
      killTree("SIGTERM");
      setTimeout(() => killTree("SIGKILL"), 5_000);
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(deadman);
      opts.signal?.removeEventListener("abort", onAbort);
      log.error("opencode.run spawn error", { err: String(err) });
      reject(err);
    });

    child.on("close", (code) => {
      settle(buildResult(code ?? -1));
    });
  });
}
