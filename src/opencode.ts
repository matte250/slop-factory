import { spawn } from "node:child_process";
import { writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { log } from "./log.ts";
import { killProcessGroup } from "./subprocess.ts";
import {
  describeEvent,
  isStopEvent,
  type OpenCodeEvent,
} from "./opencode-events.ts";

export type OpenCodeRunOptions = {
  sandboxDir: string;
  prompt: string;
  signal?: AbortSignal;
  /** If set, resume this opencode session instead of starting a fresh one. */
  sessionId?: string;
  /**
   * If set together with `transcriptLabel`, runOpenCode writes:
   *   <transcriptDir>/<label>.prompt.txt   — the exact prompt sent
   *   <transcriptDir>/<label>.events.jsonl — every JSON event opencode emitted
   *   <transcriptDir>/<label>.summary.json — final result metadata
   * These get bundled into the failure log if the run later fails.
   */
  transcriptDir?: string;
  transcriptLabel?: string;
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

export async function runOpenCode(opts: OpenCodeRunOptions): Promise<OpenCodeRunResult> {
  const cfg = loadConfig();
  // --format json: emit one JSON event per line on stdout (step_start, tool_use,
  //   text, step_finish). Lets us detect actual completion via step_finish/stop.
  // --dangerously-skip-permissions: headless run; no human can answer prompts.
  //   The "danger" is moot since opencode is sandboxed to opts.sandboxDir.
  // --variant is opencode's provider-specific reasoning-effort flag. For
  // gpt-oss-120b (OpenAI-compatible) we pin "high" — quality over speed for
  // the structured-output stages (design, tasks, implement). Documented at
  // https://opencode.ai/docs/cli/.
  // --thinking emits the model's chain-of-thought as `type: "reasoning"`
  // events alongside the tool-use stream. Without it, reasoning content
  // is invisible to --format json (we see only step envelopes + tool calls).
  // Confirmed empirically against vllm/gpt-oss-120b.
  const args = [
    "run",
    "--format", "json",
    "--dangerously-skip-permissions",
    "--model", cfg.OPENCODE_MODEL,
    "--variant", "high",
    "--thinking",
    "--dir", opts.sandboxDir,
    ...(opts.sessionId ? ["--session", opts.sessionId] : []),
    opts.prompt,
  ];

  log.info("opencode.run starting", {
    model: cfg.OPENCODE_MODEL,
    dir: opts.sandboxDir,
    promptLen: opts.prompt.length,
    resumingSession: opts.sessionId,
    transcript: opts.transcriptLabel,
  });

  const transcriptPaths =
    opts.transcriptDir && opts.transcriptLabel
      ? {
          prompt: join(opts.transcriptDir, `${opts.transcriptLabel}.prompt.txt`),
          events: join(opts.transcriptDir, `${opts.transcriptLabel}.events.jsonl`),
          summary: join(opts.transcriptDir, `${opts.transcriptLabel}.summary.json`),
          // Concatenated `text` events — what the model literally said in chat,
          // separate from tool calls.
          text: join(opts.transcriptDir, `${opts.transcriptLabel}.text.txt`),
          // Concatenated `reasoning` events — the model's chain-of-thought.
          // Only populated when opencode is invoked with --thinking.
          reasoning: join(opts.transcriptDir, `${opts.transcriptLabel}.reasoning.txt`),
        }
      : null;

  if (transcriptPaths) {
    // Best-effort: failures here only emit a warn; we don't want a transcript
    // disk error to take down the actual opencode run.
    try {
      await writeFile(transcriptPaths.prompt, opts.prompt, "utf-8");
      await writeFile(transcriptPaths.events, "", "utf-8");    // truncate
      await writeFile(transcriptPaths.text, "", "utf-8");      // truncate
      await writeFile(transcriptPaths.reasoning, "", "utf-8"); // truncate
    } catch (e) {
      log.warn("opencode.run: transcript pre-write failed", { error: (e as Error).message });
    }
  }

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

    const kill = (signal: "SIGTERM" | "SIGKILL") =>
      killProcessGroup(child.pid, signal, "opencode.run");

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
      const desc = describeEvent(ev);
      if (desc) log.info(desc.msg, desc.fields);
      else log.debug("opencode event", { type: ev.type });

      // Terminal event: model decided to stop. opencode 0.15+ has a regression
      // where it doesn't exit on its own (sst/opencode#3213), so we kill the
      // process group ourselves and treat the exit as success.
      if (isStopEvent(ev) && !taskCompleted) {
        taskCompleted = true;
        log.info("opencode.run task complete, killing process group", {
          elapsedMs: Date.now() - startedAt,
        });
        kill("SIGTERM");
        setTimeout(() => kill("SIGKILL"), 5_000);
        armDeadman(10_000, "task-complete");
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
        if (transcriptPaths) {
          // Fire-and-forget — order is preserved by appendFile's serialization
          // through the FS, and dropped writes only affect post-mortem logs.
          appendFile(transcriptPaths.events, line + "\n", "utf-8").catch(() => {});
        }
        let parsed: OpenCodeEvent | null = null;
        try {
          parsed = JSON.parse(line) as OpenCodeEvent;
        } catch {
          log.warn("opencode stdout non-json", { line: line.slice(0, 300) });
        }
        if (parsed) {
          // Capture the natural-language chat text the model produced, separate
          // from tool calls. Useful when debugging "model said something but
          // didn't write a file."
          if (
            transcriptPaths &&
            parsed.type === "text" &&
            typeof parsed.part?.text === "string" &&
            parsed.part.text.length > 0
          ) {
            appendFile(transcriptPaths.text, parsed.part.text, "utf-8").catch(() => {});
          }
          // Capture chain-of-thought reasoning (only present when --thinking
          // is passed; we always pass it). Separate file so reasoning doesn't
          // pollute the chat-text view.
          if (
            transcriptPaths &&
            parsed.type === "reasoning" &&
            typeof parsed.part?.text === "string" &&
            parsed.part.text.length > 0
          ) {
            appendFile(transcriptPaths.reasoning, parsed.part.text + "\n\n---\n\n", "utf-8").catch(() => {});
          }
          handleEvent(parsed);
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
      if (transcriptPaths) {
        // Best-effort write of the per-call summary. resolve() doesn't wait.
        const summary = {
          label: opts.transcriptLabel,
          model: cfg.OPENCODE_MODEL,
          variant: "high",
          startedAt: new Date(startedAt).toISOString(),
          durationMs: result.durationMs,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          taskCompleted: result.taskCompleted,
          sessionId: result.sessionId,
          stdoutLen: result.stdout.length,
          stderrLen: result.stderr.length,
          resumedSession: opts.sessionId,
        };
        writeFile(transcriptPaths.summary, JSON.stringify(summary, null, 2) + "\n", "utf-8").catch(
          (e) => log.warn("opencode.run: transcript summary write failed", { error: (e as Error).message }),
        );
      }
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
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 5_000);
      armDeadman(15_000, "hard-timeout");
    }, cfg.OPENCODE_TIMEOUT_MS);

    const onAbort = () => {
      log.warn("opencode.run aborted via signal");
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 5_000);
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
