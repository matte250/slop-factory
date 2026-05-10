import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { loadConfig } from "./config.ts";
import { gitOrThrow } from "./git-repo.ts";
import { log } from "./log.ts";
import type { GameIdea } from "./ideate.ts";

// ============================================================================
// Types
// ============================================================================

export type PublishFailureLogInput = {
  idea: GameIdea;
  sandboxDir: string;
  sandboxTranscriptsDir: string;
  failedPhase: string;
  errors: string[];
  /** Number of tasks if the tasks phase completed. */
  taskCount?: number;
  /** Reference example pick if the pick-example phase completed. */
  examplePick?: { name: string; reason: string };
};

export type PublishFailureLogResult = {
  logSlug: string;
  liveUrl: string;
  commit: string;
};

export const LogIndexEntrySchema = z.object({
  logSlug: z.string(),
  slug: z.string(),
  title: z.string(),
  concept: z.string(),
  failedPhase: z.string(),
  failedAt: z.string(),
  errorPreview: z.string(),
  taskCount: z.number().optional(),
  exampleName: z.string().optional(),
});
export type LogIndexEntry = z.infer<typeof LogIndexEntrySchema>;
const LogIndexSchema = z.array(LogIndexEntrySchema);

const MAX_LOG_INDEX_ENTRIES = 200;

// ============================================================================
// Entry point
// ============================================================================

export async function publishFailureLog(
  input: PublishFailureLogInput,
): Promise<PublishFailureLogResult> {
  const cfg = loadConfig();
  const failedAt = new Date();
  const logSlug = `${input.idea.slug}-${stamp(failedAt)}`;
  const logDir = join(cfg.GAMES_REPO_PATH, "logs", logSlug);

  await mkdir(logDir, { recursive: true });

  // 1. Copy whatever artefacts exist in the sandbox.
  const copied = await copyArtifacts(input.sandboxDir, logDir);

  // 2. Copy transcripts (best-effort — directory may not exist on very early failures).
  const transcripts = await copyTranscripts(input.sandboxTranscriptsDir, logDir);

  // 3. Write the structured failure summary.
  const failureJson = {
    logSlug,
    slug: input.idea.slug,
    title: input.idea.title,
    concept: input.idea.concept,
    failedPhase: input.failedPhase,
    failedAt: failedAt.toISOString(),
    errors: input.errors,
    taskCount: input.taskCount,
    examplePick: input.examplePick,
    artefacts: copied,
    transcripts: transcripts,
  };
  await writeFile(join(logDir, "failure.json"), JSON.stringify(failureJson, null, 2) + "\n", "utf-8");

  // 4. Generate the per-failure HTML viewer (self-contained). Lives at
  //    index.html so navigating to logs/<slug>/ goes here by default; the
  //    actual failed game (renamed to failed.html in copyArtifacts) is
  //    linked from inside the viewer.
  const viewerHtml = await renderFailureViewer({
    failure: failureJson,
    designContent: copied.includes("DESIGN.md") ? await readSafe(join(logDir, "DESIGN.md")) : null,
    tasksContent: copied.includes("TASKS.md") ? await readSafe(join(logDir, "TASKS.md")) : null,
    failedHtmlContent: copied.includes("failed.html") ? await readSafe(join(logDir, "failed.html")) : null,
    metaJsonContent: copied.includes("meta.json") ? await readSafe(join(logDir, "meta.json")) : null,
    transcripts,
    transcriptsDir: join(logDir, "transcripts"),
  });
  await writeFile(join(logDir, "index.html"), viewerHtml, "utf-8");

  // 5. Update logs-index.json (append entry, sort desc by failedAt, cap at N).
  const indexEntry: LogIndexEntry = {
    logSlug,
    slug: input.idea.slug,
    title: input.idea.title,
    concept: input.idea.concept,
    failedPhase: input.failedPhase,
    failedAt: failedAt.toISOString(),
    errorPreview: input.errors[0]?.slice(0, 240) ?? "",
    taskCount: input.taskCount,
    exampleName: input.examplePick?.name,
  };
  const existing = await readLogsIndex(cfg.GAMES_REPO_PATH);
  const next = [indexEntry, ...existing.filter((e) => e.logSlug !== logSlug)]
    .sort((a, b) => b.failedAt.localeCompare(a.failedAt))
    .slice(0, MAX_LOG_INDEX_ENTRIES);
  await writeFile(
    join(cfg.GAMES_REPO_PATH, "logs-index.json"),
    JSON.stringify(next, null, 2) + "\n",
    "utf-8",
  );

  // 6. Generate the gallery (logs/index.html).
  await writeFile(
    join(cfg.GAMES_REPO_PATH, "logs", "index.html"),
    renderGallery(next),
    "utf-8",
  );

  log.info("publish-log: files written", { logSlug, logDir });

  // 7. Commit + push.
  await gitOrThrow(cfg.GAMES_REPO_PATH, ["add", `logs/`, "logs-index.json"]);
  const status = await gitOrThrow(cfg.GAMES_REPO_PATH, ["status", "--porcelain"]);
  if (!status.stdout.trim()) {
    log.warn("publish-log: nothing to commit", { logSlug });
  } else {
    await gitOrThrow(cfg.GAMES_REPO_PATH, [
      "commit",
      "-m",
      `log: ${input.idea.title} (${logSlug}) failed at ${input.failedPhase}`,
    ]);
  }
  await gitOrThrow(cfg.GAMES_REPO_PATH, ["push", "origin", "HEAD"]);

  const headRev = (await gitOrThrow(cfg.GAMES_REPO_PATH, ["rev-parse", "HEAD"])).stdout.trim();
  const base = cfg.GAMES_PAGES_BASE_URL.replace(/\/$/, "");
  const liveUrl = `${base}/logs/${logSlug}/`;
  log.info("publish-log: pushed", { logSlug, commit: headRev, liveUrl });

  return { logSlug, liveUrl, commit: headRev };
}

// ============================================================================
// Helpers — file ops
// ============================================================================

/**
 * Files to copy from the sandbox into the log directory. We rename
 * `index.html` to `failed.html` so it doesn't get served as the directory
 * default — our viewer takes the `index.html` slot instead.
 */
const ARTEFACT_FILES: { src: string; dst: string }[] = [
  { src: "DESIGN.md", dst: "DESIGN.md" },
  { src: "TASKS.md", dst: "TASKS.md" },
  { src: "index.html", dst: "failed.html" },
  { src: "meta.json", dst: "meta.json" },
];

async function copyArtifacts(sandboxDir: string, logDir: string): Promise<string[]> {
  const copied: string[] = [];
  for (const { src, dst } of ARTEFACT_FILES) {
    const srcPath = join(sandboxDir, src);
    try {
      await stat(srcPath);
      await copyFile(srcPath, join(logDir, dst));
      copied.push(dst);
    } catch {
      // file just doesn't exist — earlier-than-implement failure may not have produced it
    }
  }
  return copied;
}

type TranscriptEntry = {
  label: string;
  promptFile?: string;
  eventsFile?: string;
  summaryFile?: string;
};

async function copyTranscripts(
  sandboxTranscriptsDir: string,
  logDir: string,
): Promise<TranscriptEntry[]> {
  const dst = join(logDir, "transcripts");
  let entries: string[];
  try {
    entries = await readdir(sandboxTranscriptsDir);
  } catch {
    return [];
  }
  if (entries.length === 0) return [];
  await mkdir(dst, { recursive: true });

  // Group by label (the part before .prompt.txt / .events.jsonl / .summary.json).
  const byLabel = new Map<string, TranscriptEntry>();
  for (const name of entries) {
    let label: string | null = null;
    let kind: keyof TranscriptEntry | null = null;
    if (name.endsWith(".prompt.txt")) {
      label = name.slice(0, -".prompt.txt".length);
      kind = "promptFile";
    } else if (name.endsWith(".events.jsonl")) {
      label = name.slice(0, -".events.jsonl".length);
      kind = "eventsFile";
    } else if (name.endsWith(".summary.json")) {
      label = name.slice(0, -".summary.json".length);
      kind = "summaryFile";
    }
    if (!label || !kind) continue;

    await copyFile(join(sandboxTranscriptsDir, name), join(dst, name));
    const entry = byLabel.get(label) ?? { label };
    (entry as Record<string, string>)[kind] = name;
    byLabel.set(label, entry);
  }
  return [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label));
}

async function readSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function readLogsIndex(repoPath: string): Promise<LogIndexEntry[]> {
  const path = join(repoPath, "logs-index.json");
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = LogIndexSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    log.warn("publish-log: failed to read logs-index.json, starting fresh", {
      error: (err as Error).message,
    });
    return [];
  }
}

function stamp(d: Date): string {
  // Compact ISO without separators for filesystem-safe timestamps.
  // 2026-05-10T12:34:56Z -> 20260510T123456Z
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// ============================================================================
// HTML rendering
// ============================================================================

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SHARED_STYLE = `
  body { margin: 0; background: #0a0a0f; color: #e6e6f0; font-family: ui-sans-serif, system-ui, sans-serif; line-height: 1.5; }
  a { color: #7df9ff; }
  a:hover { color: #a3ffff; }
  header.page-header { padding: 16px 24px; border-bottom: 1px solid #1d1d2a; }
  header.page-header h1 { margin: 0; font-size: 20px; color: #ff52ae; letter-spacing: 0.04em; }
  header.page-header .crumb { margin-top: 4px; color: #a5a5b8; font-size: 13px; }
  main { padding: 16px 24px 64px; max-width: 1100px; margin: 0 auto; }
  section { margin: 24px 0; }
  section h2 { font-size: 15px; color: #7df9ff; text-transform: uppercase; letter-spacing: 0.08em; margin: 0 0 8px; }
  pre { background: #11121a; border: 1px solid #1d1d2a; padding: 12px; overflow-x: auto; font-size: 12px; line-height: 1.45; color: #d8d8e6; max-height: 480px; }
  details { background: #11121a; border: 1px solid #1d1d2a; margin: 8px 0; }
  details > summary { cursor: pointer; padding: 8px 12px; color: #c8c8d8; }
  details > summary:hover { background: #161725; }
  details[open] > summary { border-bottom: 1px solid #1d1d2a; }
  details > pre { border: 0; max-height: 720px; }
  .errors { background: #2a1015; border: 1px solid #4a1d24; padding: 12px; color: #ffb0b0; }
  .errors li { margin-bottom: 6px; }
  .meta-grid { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; font-size: 13px; }
  .meta-grid dt { color: #a5a5b8; }
  .meta-grid dd { margin: 0; color: #e6e6f0; word-break: break-word; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; background: #1c2030; color: #7df9ff; border: 1px solid #2a2f44; }
  .pill.fail-implement { background: #2a1015; color: #ff8c8c; border-color: #4a1d24; }
  .gallery-row { display: flex; gap: 16px; padding: 12px; border: 1px solid #1d1d2a; margin-bottom: 8px; align-items: baseline; flex-wrap: wrap; }
  .gallery-row a.title { color: #ff52ae; font-weight: 600; font-size: 16px; text-decoration: none; }
  .gallery-row .right { margin-left: auto; color: #a5a5b8; font-size: 12px; }
  .gallery-row .preview { color: #c8c8d8; font-size: 13px; flex-basis: 100%; margin-top: 4px; }
`.trim();

function renderGallery(entries: LogIndexEntry[]): string {
  const rows = entries.map((e) => {
    return `
      <div class="gallery-row">
        <a class="title" href="${escapeHtml(e.logSlug)}/">${escapeHtml(e.title)}</a>
        <span class="pill fail-${escapeHtml(e.failedPhase)}">failed: ${escapeHtml(e.failedPhase)}</span>
        ${e.taskCount != null ? `<span class="pill">${e.taskCount} tasks</span>` : ""}
        ${e.exampleName ? `<span class="pill">example: ${escapeHtml(e.exampleName)}</span>` : ""}
        <span class="right">${escapeHtml(e.failedAt)}</span>
        <div class="preview">${escapeHtml(e.errorPreview || "(no error preview)")}</div>
      </div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Slop Factory · Failure logs</title>
<style>${SHARED_STYLE}</style>
</head>
<body>
<header class="page-header">
  <h1>FAILURE LOGS</h1>
  <div class="crumb"><a href="../">← back to gallery</a> · ${entries.length} entries (most recent first)</div>
</header>
<main>
  ${entries.length === 0 ? '<p style="color:#a5a5b8">No failures logged yet.</p>' : rows}
</main>
</body>
</html>
`;
}

type ViewerInput = {
  failure: {
    logSlug: string;
    slug: string;
    title: string;
    concept: string;
    failedPhase: string;
    failedAt: string;
    errors: string[];
    taskCount?: number;
    examplePick?: { name: string; reason: string };
    artefacts: string[];
    transcripts: TranscriptEntry[];
  };
  designContent: string | null;
  tasksContent: string | null;
  failedHtmlContent: string | null;
  metaJsonContent: string | null;
  transcripts: TranscriptEntry[];
  transcriptsDir: string;
};

async function renderFailureViewer(v: ViewerInput): Promise<string> {
  const f = v.failure;

  const errorsHtml = f.errors.length === 0
    ? "<p>(no errors recorded — odd)</p>"
    : `<ul class="errors">${f.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>`;

  const transcriptsHtml = await renderTranscripts(v.transcripts, v.transcriptsDir);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(f.title)} — failure log</title>
<style>${SHARED_STYLE}</style>
</head>
<body>
<header class="page-header">
  <h1>${escapeHtml(f.title)}</h1>
  <div class="crumb"><a href="../">← all failures</a> · <code>${escapeHtml(f.logSlug)}</code></div>
</header>
<main>

<section>
  <h2>Summary</h2>
  <dl class="meta-grid">
    <dt>Slug</dt><dd>${escapeHtml(f.slug)}</dd>
    <dt>Concept</dt><dd>${escapeHtml(f.concept)}</dd>
    <dt>Failed at phase</dt><dd><span class="pill fail-${escapeHtml(f.failedPhase)}">${escapeHtml(f.failedPhase)}</span></dd>
    <dt>Failed at</dt><dd>${escapeHtml(f.failedAt)}</dd>
    ${f.taskCount != null ? `<dt>Tasks planned</dt><dd>${f.taskCount}</dd>` : ""}
    ${f.examplePick ? `<dt>Example chosen</dt><dd>${escapeHtml(f.examplePick.name)} — <em>${escapeHtml(f.examplePick.reason)}</em></dd>` : ""}
  </dl>
</section>

<section>
  <h2>Errors</h2>
  ${errorsHtml}
</section>

${v.designContent ? `<section>
  <h2>DESIGN.md</h2>
  <details><summary>show</summary><pre>${escapeHtml(v.designContent)}</pre></details>
</section>` : ""}

${v.tasksContent ? `<section>
  <h2>TASKS.md</h2>
  <details open><summary>show</summary><pre>${escapeHtml(v.tasksContent)}</pre></details>
</section>` : ""}

${v.metaJsonContent ? `<section>
  <h2>meta.json</h2>
  <details><summary>show</summary><pre>${escapeHtml(v.metaJsonContent)}</pre></details>
</section>` : ""}

${v.failedHtmlContent ? `<section>
  <h2>index.html (partial — failed before final validation passed)</h2>
  <p><a href="failed.html">▶ open the broken game in a new tab</a> — may crash or behave incorrectly.</p>
  <details><summary>show source (${v.failedHtmlContent.length.toLocaleString()} chars)</summary><pre>${escapeHtml(v.failedHtmlContent)}</pre></details>
</section>` : ""}

<section>
  <h2>Transcripts (per opencode call)</h2>
  ${transcriptsHtml || "<p>(no transcripts captured)</p>"}
</section>

</main>
</body>
</html>
`;
}

async function renderTranscripts(transcripts: TranscriptEntry[], transcriptsDir: string): Promise<string> {
  if (transcripts.length === 0) return "";
  const blocks: string[] = [];
  for (const t of transcripts) {
    const summary = t.summaryFile ? await readSafe(join(transcriptsDir, t.summaryFile)) : null;
    const prompt = t.promptFile ? await readSafe(join(transcriptsDir, t.promptFile)) : null;
    const events = t.eventsFile ? await readSafe(join(transcriptsDir, t.eventsFile)) : null;
    blocks.push(`
<details>
  <summary>${escapeHtml(t.label)}</summary>
  ${summary ? `<pre>${escapeHtml(summary)}</pre>` : ""}
  ${prompt ? `<details><summary>prompt (${prompt.length.toLocaleString()} chars)</summary><pre>${escapeHtml(prompt)}</pre></details>` : ""}
  ${events ? `<details><summary>events (${events.split("\n").length - 1} lines)</summary><pre>${escapeHtml(events)}</pre></details>` : ""}
</details>`);
  }
  return blocks.join("\n");
}
