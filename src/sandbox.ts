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
  cleanup: () => Promise<void>;
};

export async function createSandbox(slug: string): Promise<Sandbox> {
  const cfg = loadConfig();
  const suffix = randomBytes(4).toString("hex");
  const dir = join(cfg.SANDBOX_ROOT, `${slug}-${suffix}`);
  const snapshotsDir = join(cfg.SANDBOX_ROOT, `${slug}-${suffix}.snapshots`);
  await mkdir(dir, { recursive: true });
  await mkdir(snapshotsDir, { recursive: true });
  return {
    slug,
    dir,
    snapshotsDir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
      await rm(snapshotsDir, { recursive: true, force: true });
    },
  };
}
