import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { staticChecks } from "./static.ts";
import { browserChecks } from "./browser.ts";
import type { ValidationResult } from "./types.ts";

export type { ValidationResult } from "./types.ts";
export { staticChecks } from "./static.ts";
export { browserChecks, consoleErrorCheck, type BrowserCheckOptions } from "./browser.ts";

export async function validate(sandboxDir: string): Promise<ValidationResult> {
  const sr = await staticChecks(sandboxDir);
  if (!sr.ok) return sr;

  const br = await browserChecks({ sandboxDir });
  if (!br.ok) return { ok: false, errors: br.errors, meta: sr.meta };

  return { ok: true, errors: [], meta: sr.meta };
}

const REQUIRED_DESIGN_SECTIONS = [
  "## Concept",
  "## Player",
  "## Core loop",
  "## Hazards",
  "## Score",
  "## Win and lose",
  "## Feel",
  "## Why it's fun",
];

export async function validateDesign(sandboxDir: string): Promise<ValidationResult> {
  const errors: string[] = [];
  const designPath = join(sandboxDir, "DESIGN.md");
  let content = "";
  try {
    content = await readFile(designPath, "utf-8");
  } catch {
    errors.push("Required file missing: DESIGN.md");
    return { ok: false, errors };
  }
  for (const section of REQUIRED_DESIGN_SECTIONS) {
    if (!content.includes(section)) {
      errors.push(`DESIGN.md: missing required section header "${section}"`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export type TaskItem = {
  num: number;
  /** Full text of the task line, after the leading `<num>.` */
  text: string;
};

const TASK_LINE_RE = /^\s*(\d+)\.\s*(.+?)\s*$/;
const MIN_TASKS = 5;

/**
 * Parse TASKS.md into an ordered list of tasks. A task is any line starting
 * with `<number>.`. Sub-bullets and prose between tasks are ignored.
 */
export async function parseTasks(sandboxDir: string): Promise<TaskItem[]> {
  const raw = await readFile(join(sandboxDir, "TASKS.md"), "utf-8");
  const items: TaskItem[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(TASK_LINE_RE);
    if (m) items.push({ num: Number(m[1]), text: m[2]! });
  }
  return items;
}

export async function validateTasks(sandboxDir: string): Promise<ValidationResult> {
  const errors: string[] = [];
  let items: TaskItem[];
  try {
    items = await parseTasks(sandboxDir);
  } catch {
    errors.push("Required file missing or unreadable: TASKS.md");
    return { ok: false, errors };
  }
  if (items.length < MIN_TASKS) {
    errors.push(
      `TASKS.md: parsed only ${items.length} numbered task line(s); need at least ${MIN_TASKS}. Make sure each task starts with "<number>." at the beginning of its own line.`,
    );
  }
  return { ok: errors.length === 0, errors };
}
