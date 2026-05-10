type Level = "debug" | "info" | "warn" | "error";

// sd-daemon(3) priority prefix: journald reads <N> at the start of a line and
// stores the rest as MESSAGE with PRIORITY=N. journalctl then colors err red,
// warning yellow, and `-p err` filtering works as expected.
const PRIORITY: Record<Level, string> = {
  debug: "<7>",
  info: "<6>",
  warn: "<4>",
  error: "<3>",
};

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(fields ?? {}),
  };
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  stream.write(PRIORITY[level] + JSON.stringify(line) + "\n");
}

// ANSI bold green; survives through journald and renders when journalctl is on
// a terminal. NOTICE priority (<5>) is bold-bright in journalctl, which compounds.
const ANSI_GREEN_BOLD = "\x1b[1;32m";
const ANSI_RESET = "\x1b[0m";

function emitPhase(name: string) {
  const banner = `${ANSI_GREEN_BOLD}════════ PHASE: ${name.toUpperCase()} ════════${ANSI_RESET}`;
  process.stdout.write(`<5>${banner}\n`);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
  /** Green-bold banner marking a top-level phase boundary (self-update, ideate, design, tasks, implement, screenshot, publish, notify). */
  phase: (name: string) => emitPhase(name),
};
