import { spawn } from "node:child_process";
import { loadConfig } from "./config.ts";
import { log } from "./log.ts";

export type OpenCodeRunOptions = {
  sandboxDir: string;
  prompt: string;
  signal?: AbortSignal;
  /** If set, resume this opencode session instead of starting a fresh one. */
  sessionId?: string;
};

export type OpenCodeRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True if the hard OPENCODE_TIMEOUT_MS deadline killed it. */
  timedOut: boolean;
  /** True if we observed opencode emit a step_finish event with reason "stop" (real done signal). */
  taskCompleted: boolean;
  durationMs: number;
  /** Session ID observed in the event stream (first non-empty sessionID seen). */
  sessionId?: string;
};

type OpenCodeEvent = {
  type?: string;
  sessionID?: string;
  part?: {
    type?: string;
    reason?: string;
    tool?: string;
    text?: string;
    state?: { input?: Record<string, unknown>; output?: string };
    tokens?: { total?: number; input?: number; output?: number; reasoning?: number };
  };
};

export async function runOpenCode(opts: OpenCodeRunOptions): Promise<OpenCodeRunResult> {
  const cfg = loadConfig();
  // --format json: emit one JSON event per line on stdout (step_start, tool_use,
  //   text, step_finish). Lets us detect actual completion via step_finish/stop.
  // --dangerously-skip-permissions: headless run; no human can answer prompts.
  //   The "danger" is moot since opencode is sandboxed to opts.sandboxDir.
  const args = [
    "run",
    "--format", "json",
    "--dangerously-skip-permissions",
    "--model", cfg.OPENCODE_MODEL,
    "--dir", opts.sandboxDir,
    ...(opts.sessionId ? ["--session", opts.sessionId] : []),
    opts.prompt,
  ];

  log.info("opencode.run starting", {
    model: cfg.OPENCODE_MODEL,
    dir: opts.sandboxDir,
    promptLen: opts.prompt.length,
    resumingSession: opts.sessionId,
  });

  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(cfg.OPENCODE_BIN, args, {
      cwd: opts.sandboxDir,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group: opencode spawns subprocesses; killing only the parent
      // leaves orphans holding stdio open, blocking the 'close' event.
      detached: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let taskCompleted = false;
    let settled = false;
    let lastActivityAt = Date.now();
    let stdoutBuf = "";
    let stderrBuf = "";
    let deadman: NodeJS.Timeout | null = null;
    let observedSessionId: string | undefined = opts.sessionId;

    const killTree = (signal: "SIGTERM" | "SIGKILL") => {
      if (child.pid == null) return;
      try {
        process.kill(-child.pid, signal);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") {
          log.warn("opencode.run kill failed", { signal, err: String(e) });
        }
      }
    };

    const armDeadman = (graceMs: number, on: "task-complete" | "hard-timeout") => {
      deadman = setTimeout(() => {
        if (!settled) {
          log.warn("opencode.run deadman fired (close event never arrived)", { on, graceMs });
          // exit 0 if we know the task completed, else -1
          settle(buildResult(on === "task-complete" ? 0 : -1));
        }
      }, graceMs);
    };

    const handleEvent = (ev: OpenCodeEvent) => {
      if (!observedSessionId && ev.sessionID) observedSessionId = ev.sessionID;
      switch (ev.type) {
        case "step_start":
          log.info("opencode step.start", { sessionID: ev.sessionID });
          break;
        case "tool_use": {
          const inputSummary: Record<string, string> = {};
          const input = ev.part?.state?.input ?? {};
          for (const [k, v] of Object.entries(input)) {
            const s = typeof v === "string" ? v : JSON.stringify(v);
            inputSummary[k] = s.length > 80 ? s.slice(0, 80) + "…" : s;
          }
          log.info("opencode step.tool", { tool: ev.part?.tool, input: inputSummary });
          break;
        }
        case "text":
          log.info("opencode step.text", { preview: ev.part?.text?.slice(0, 200) });
          break;
        case "step_finish":
          log.info("opencode step.finish", {
            reason: ev.part?.reason,
            tokensTotal: ev.part?.tokens?.total,
            tokensOutput: ev.part?.tokens?.output,
            reasoning: ev.part?.tokens?.reasoning,
          });
          // Terminal event: model decided to stop. Session is complete.
          // opencode 0.15+ has a regression where it doesn't exit on its own
          // (https://github.com/sst/opencode/issues/3213), so we kill the
          // process group ourselves and treat the exit as success.
          if (ev.part?.reason === "stop" && !taskCompleted) {
            taskCompleted = true;
            log.info("opencode.run task complete, killing process group", {
              elapsedMs: Date.now() - startedAt,
            });
            killTree("SIGTERM");
            setTimeout(() => killTree("SIGKILL"), 5_000);
            armDeadman(10_000, "task-complete");
          }
          break;
        default:
          log.debug("opencode event", { type: ev.type });
      }
    };

    child.stdout.on("data", (b: Buffer) => {
      lastActivityAt = Date.now();
      stdoutChunks.push(b);
      stdoutBuf += b.toString("utf-8");
      let i: number;
      while ((i = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, i).trimEnd();
        stdoutBuf = stdoutBuf.slice(i + 1);
        if (!line) continue;
        try {
          handleEvent(JSON.parse(line) as OpenCodeEvent);
        } catch {
          log.warn("opencode stdout non-json", { line: line.slice(0, 300) });
        }
      }
    });

    child.stderr.on("data", (b: Buffer) => {
      lastActivityAt = Date.now();
      stderrChunks.push(b);
      stderrBuf += b.toString("utf-8");
      let i: number;
      while ((i = stderrBuf.indexOf("\n")) !== -1) {
        const line = stderrBuf.slice(0, i).trimEnd();
        stderrBuf = stderrBuf.slice(i + 1);
        if (line) log.info("opencode stderr", { line: line.slice(0, 300) });
      }
    });

    // Heartbeat for journal liveness during long reasoning gaps.
    const heartbeat = setInterval(() => {
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      const idleSec = Math.round((Date.now() - lastActivityAt) / 1000);
      log.info("opencode.run heartbeat", {
        elapsedSec,
        idleSec,
        stdoutBytes: stdoutChunks.reduce((n, b) => n + b.length, 0),
        stderrBytes: stderrChunks.reduce((n, b) => n + b.length, 0),
        taskCompleted,
      });
    }, 60_000);

    const settle = (result: OpenCodeRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (deadman) clearTimeout(deadman);
      clearInterval(heartbeat);
      opts.signal?.removeEventListener("abort", onAbort);
      log.info("opencode.run finished", {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        taskCompleted: result.taskCompleted,
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
      taskCompleted,
      durationMs: Date.now() - startedAt,
      sessionId: observedSessionId,
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      log.warn("opencode.run hard timeout, killing process group", { ms: cfg.OPENCODE_TIMEOUT_MS });
      killTree("SIGTERM");
      setTimeout(() => killTree("SIGKILL"), 5_000);
      armDeadman(15_000, "hard-timeout");
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
      if (deadman) clearTimeout(deadman);
      clearInterval(heartbeat);
      opts.signal?.removeEventListener("abort", onAbort);
      log.error("opencode.run spawn error", { err: String(err) });
      reject(err);
    });

    child.on("close", (code) => {
      // If our own SIGTERM after task-complete is what stopped opencode,
      // report exit 0 — the work was successful even though the signal made
      // the OS report the kill code.
      const exitCode = taskCompleted ? 0 : (code ?? -1);
      settle(buildResult(exitCode));
    });
  });
}
