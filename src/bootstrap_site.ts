import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { authedRemoteUrl, git, gitOrThrow } from "./git_repo.ts";
import { log } from "./log.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = join(here, "..", "assets", "site");

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Bootstrap the public games repo at GAMES_REPO_PATH:
 *   - clone if not present
 *   - configure remote with PAT auth + a committer identity
 *   - copy gallery templates (index.html, styles.css, README.md, .nojekyll)
 *   - ensure games-index.json exists (empty array)
 *   - commit + push
 *
 * Idempotent: re-running just brings the repo up to date.
 */
export async function bootstrapSite(): Promise<{ pushed: boolean }> {
  const cfg = loadConfig();
  const repoDir = cfg.GAMES_REPO_PATH;
  const authedRemote = authedRemoteUrl(cfg.GAMES_REPO_REMOTE, cfg.GITHUB_TOKEN);

  if (!(await exists(join(repoDir, ".git")))) {
    log.info("bootstrap: cloning games repo", { repoDir });
    await mkdir(dirname(repoDir), { recursive: true });
    const cloned = await git(process.cwd(), ["clone", authedRemote, repoDir]);
    if (cloned.exitCode !== 0) {
      // Empty repo on GitHub: clone may succeed but with a warning, OR it may fail.
      // Fall back to init + add remote.
      log.warn("bootstrap: clone failed, initializing fresh", {
        stderr: cloned.stderr.slice(-300),
      });
      await mkdir(repoDir, { recursive: true });
      await gitOrThrow(repoDir, ["init", "-b", "main"]);
      await gitOrThrow(repoDir, ["remote", "add", "origin", authedRemote]);
    }
  } else {
    log.info("bootstrap: games repo already cloned", { repoDir });
  }

  // Ensure remote URL has the token (fixes drift if the user manually cloned earlier).
  await gitOrThrow(repoDir, ["remote", "set-url", "origin", authedRemote]);

  // Committer identity (avoids "please tell me who you are" prompts).
  await gitOrThrow(repoDir, ["config", "user.email", "slop-factory@local"]);
  await gitOrThrow(repoDir, ["config", "user.name", "Slop Factory"]);

  // Pull latest if remote has commits (ignore if repo is empty).
  await git(repoDir, ["pull", "--ff-only", "origin", "main"]);

  // Copy gallery files.
  await copyFile(join(ASSETS_DIR, "index.html"), join(repoDir, "index.html"));
  await copyFile(join(ASSETS_DIR, "styles.css"), join(repoDir, "styles.css"));

  // Tell GitHub Pages not to run Jekyll (prevents underscore-prefixed paths from being hidden).
  await writeFile(join(repoDir, ".nojekyll"), "", "utf-8");

  // Ensure games-index.json exists.
  const indexPath = join(repoDir, "games-index.json");
  if (!(await exists(indexPath))) {
    await writeFile(indexPath, "[]\n", "utf-8");
  }

  // Ensure games dir exists with a placeholder so `git add games/` doesn't error later.
  await mkdir(join(repoDir, "games"), { recursive: true });
  const keepPath = join(repoDir, "games", ".gitkeep");
  if (!(await exists(keepPath))) {
    await writeFile(keepPath, "", "utf-8");
  }

  // Stage + commit + push.
  await gitOrThrow(repoDir, ["add", "index.html", "styles.css", ".nojekyll", "games-index.json", "games/.gitkeep"]);
  const status = await gitOrThrow(repoDir, ["status", "--porcelain"]);
  if (!status.stdout.trim()) {
    log.info("bootstrap: nothing to commit");
    return { pushed: false };
  }

  await gitOrThrow(repoDir, ["commit", "-m", "bootstrap: gallery scaffolding"]);
  await gitOrThrow(repoDir, ["push", "-u", "origin", "main"]);
  log.info("bootstrap: pushed initial scaffolding");
  return { pushed: true };
}
