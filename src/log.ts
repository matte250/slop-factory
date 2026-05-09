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

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
