import { bootstrapSite } from "../bootstrap_site.ts";
import { loadConfig } from "../config.ts";

const cfg = loadConfig();
process.stdout.write(`Bootstrapping ${cfg.GAMES_REPO_PATH} -> ${cfg.GAMES_REPO_REMOTE}\n`);

const r = await bootstrapSite();
process.stdout.write(`done. pushed=${r.pushed}\n`);
process.stdout.write(`\nNext: enable GitHub Pages on the repo (Settings -> Pages -> Deploy from branch -> main / root)\n`);
process.stdout.write(`Site will be live at: ${cfg.GAMES_PAGES_BASE_URL}\n`);
