import { mkdir, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { loadConfig } from "./config.ts";

export type Sandbox = {
  slug: string;
  dir: string;
  cleanup: () => Promise<void>;
};

export async function createSandbox(slug: string): Promise<Sandbox> {
  const cfg = loadConfig();
  const suffix = randomBytes(4).toString("hex");
  const dir = join(cfg.SANDBOX_ROOT, `${slug}-${suffix}`);
  await mkdir(dir, { recursive: true });
  return {
    slug,
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
