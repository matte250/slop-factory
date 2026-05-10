import { mkdir, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { loadConfig } from "./config.ts";

export type Sandbox = {
  slug: string;
  /** Working directory the LLM sees (via opencode --dir) */
  dir: string;
  /** Sibling directory for snapshots between refinement stages — hidden from the LLM */
  snapshotsDir: string;
  /**
   * Directory for opencode transcripts (prompt + JSONL event stream + per-call
   * summary). Lives inside `dir` so it gets preserved alongside the work when
   * the sandbox is preserved on failure. Hidden behind a leading dot so the
   * model is unlikely to read it back.
   */
  transcriptsDir: string;
  cleanup: () => Promise<void>;
};

export async function createSandbox(slug: string): Promise<Sandbox> {
  const cfg = loadConfig();
  const suffix = randomBytes(4).toString("hex");
  const dir = join(cfg.SANDBOX_ROOT, `${slug}-${suffix}`);
  const snapshotsDir = join(cfg.SANDBOX_ROOT, `${slug}-${suffix}.snapshots`);
  const transcriptsDir = join(dir, ".transcripts");
  await mkdir(dir, { recursive: true });
  await mkdir(snapshotsDir, { recursive: true });
  await mkdir(transcriptsDir, { recursive: true });
  return {
    slug,
    dir,
    snapshotsDir,
    transcriptsDir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
      await rm(snapshotsDir, { recursive: true, force: true });
    },
  };
}
