# AGENTS.md — Slop Factory manager

A map for agents (and humans) working on this codebase. Read this before grepping.

## What this is

A continuous content factory: a long-running service that drives a local **GPT-OSS 120B** (served by **vLLM**, orchestrated through **OpenCode**) to autonomously produce small browser games and publish them to a public GitHub Pages gallery.

This repo is **the manager only** — the runtime LLM never sees this code.

## Two-repo / three-directory layout

```
ThinkStation (user: test)
├── /home/test/slop-factory/                     ← THIS repo (private to manager)
├── /home/test/slop-factory-site/                ← public games + gallery (Pages)
└── /tmp/slop-factory-work/<slug>-<rand>/        ← per-game sandbox
    ├── CONVENTIONS.md                           ← contract written by us each time
    ├── DESIGN.md                                ← produced by design stage
    ├── index.html, meta.json                    ← produced by implement stage
    └── (.snapshots/ sibling — restore points)
```

**Isolation guarantee:** `opencode run --dir <sandbox>` is the only thing the LLM sees. Never the manager repo, never the games repo, never `.env`.

## Per-game pipeline (one tick)

```
ideate          (direct vLLM call — 1-2 sentence concept)
   ↓
design          (opencode → DESIGN.md, mandatory sections, no code yet)
   ↓
implement       (opencode → index.html + meta.json; iterative console-fix sub-loop)
   ↓
critique        (opencode → re-trace, mandatory analysis comment block)
   ↓
polish          (opencode → juice; preserves critique block)        [skipped if REFINE_STAGES < 3]
   ↓
screenshot      (Playwright → thumbnail.png in sandbox)
   ↓
publish         (copy 3 files into games repo, update games-index.json, git push)
   ↓
notify          (Discord webhook embed)
   ↓
sandbox cleanup, cooldown, repeat
```

After each successful stage we snapshot index.html + meta.json. If a later stage's retries all fail, we restore the prior snapshot — so quality never regresses, only stays flat or improves.

## Module map (`src/`)

| File | Role |
|---|---|
| `main.ts` | Entrypoint. `--once` for single tick, otherwise `runForever`. |
| `loop.ts` | Outer loop: `runOnce`, deadlines, retries, `selfUpdateAndMaybeExit` (git pull + bun install + `process.exit(2)` so systemd restarts on new code). |
| `config.ts` | Zod-validated env. |
| `log.ts` | Structured stdout logger; sd-daemon priority prefixes for journalctl coloring. |
| `deadline.ts` | `withDeadline(label, ms, promise)` — used everywhere risky. |
| `llm.ts` | Direct vLLM HTTP wrapper. Used **only** by `ideate.ts`. |
| `ideate.ts` | Picks a fresh game idea (avoids slug collision against `games-index.json`). |
| `sandbox.ts` | Creates `/tmp/slop-factory-work/<slug>-<rand>/` and a sibling `.snapshots/`. |
| `conventions.ts` | Writes `CONVENTIONS.md.tmpl` into the sandbox with `{SLUG}` substituted. |
| `examples.ts` | Picks a structural reference game (snake / asteroids / breakout) by keyword and renders it as a prompt prelude. |
| `opencode.ts` | Wraps the `opencode run --format json --dangerously-skip-permissions` CLI. Streams JSONL events; kills process group on `step_finish/stop` (workaround for [sst/opencode#3213](https://github.com/sst/opencode/issues/3213)). |
| `validate.ts` | All gameplay validation: static HTML/meta checks, headless Playwright canvas check, runtime playtest exercising `window.__game`. Three exported variants for different stages. |
| `generate.ts` | The per-game pipeline orchestrator. Defines stages, runs them, snapshots, restores. |
| `screenshot.ts` | Playwright thumbnail (600×400 PNG, `canvas.toDataURL` resized in-page). |
| `git_repo.ts` | `git` subprocess wrapper with PAT-embedded remote URLs and process-group kill on timeout. |
| `publish.ts` | Copies game files into games repo, updates `games-index.json`, commits, pushes. |
| `notify.ts` | Discord webhook embed. Best-effort — failures don't break the tick. |
| `bootstrap_site.ts` | One-shot setup: clone games repo + drop in gallery templates + push. Idempotent. |
| `games_index.ts` | `games-index.json` reader, `slugify`, collision-avoiding `uniqueSlug`. |

`src/scripts/*.ts` — manual smoke tests (`smoke-llm`, `smoke-opencode`, `smoke-validate`, `smoke-generate`, `smoke-publish`, `smoke-notify`) plus `bootstrap-site`.

## Prompts (`prompts/`)

- `CONVENTIONS.md.tmpl` — the contract the LLM follows. Single substitution `{SLUG}`. Written into each sandbox.
- Stage prompts (TODO: currently inline in `generate.ts`; planned `prompts/{design,implement,critique,polish,retry}.md`).
- `examples/<name>/{index.html,meta.json}` — reference games shown to the LLM as a structural template. `wordle/` exists but isn't yet listed in `EXAMPLES` in `examples.ts`.

## The `window.__game` contract

Every published game **must** expose `window.__game = { state, score, player: {x, y, visible}, objective }` from the first frame. This is what the runtime playtest reads to decide whether the game is actually playable. Without it, the game fails validation. See CONVENTIONS for the full schema.

## Conventions

- **Stack:** Bun + TypeScript. No Node, no npm, no pnpm. `bun run`, `bun install`, `bunx tsc --noEmit`.
- **Filenames:** kebab-case for multi-word, single-word for one. (`bootstrap_site.ts`, `games_index.ts`, `git_repo.ts` are pre-rename holdouts.)
- **Imports:** explicit `.ts` extension (`allowImportingTsExtensions: true`).
- **Comments:** only when *why* is non-obvious. Don't restate the code.
- **Validation is truth.** OpenCode's exit code is a hint; the files on disk are reality. Always validate after every opencode run.
- **Long-running subprocesses (opencode, git, playwright) MUST:**
  1. Run in their own process group (`detached: true`)
  2. Kill the group, not just the parent (`process.kill(-pid, signal)`)
  3. Have a hard timeout
  4. Have a deadman fallback that resolves the promise even if `close` never fires
- **Risky awaits (Playwright, network, git, opencode) are wrapped in `withDeadline(label, ms, promise)`.** Catch the rejection where it makes sense to recover.

## Runtime quirks worth knowing

- **opencode 0.15+ doesn't exit cleanly** after the model says it's done. We watch the JSONL event stream for `step_finish` with `part.reason === "stop"` and kill the process group ourselves. See `src/opencode.ts`.
- **`--format json` and `--dangerously-skip-permissions` are required.** Without them opencode hangs in headless mode. The "danger" of skip-permissions is moot since the LLM is sandboxed to `--dir`.
- **Browsers block autoplay audio.** CONVENTIONS tells generated games to lazy-init `AudioContext` on first input — a game that calls `new AudioContext()` at load time will throw and fail validation.
- **Playwright `page.evaluate` can hang** if the page has an infinite sync loop. Always wrap in `withDeadline`.

## Deploy / operate

| | |
|---|---|
| Service unit | `systemd/slop-factory.service` (User=test) |
| Status | `sudo systemctl status slop-factory` |
| Logs | `sudo journalctl -u slop-factory -f` |
| Config | `/home/test/slop-factory/.env` |
| Sandboxes | `/tmp/slop-factory-work/<slug>-<rand>/` (preserved on failure for inspection) |
| Public site | `https://matte250.github.io/slop-factory-site/` |
| Self-update | between ticks: `git fetch origin` → `git pull --ff-only` → `bun install` → `process.exit(2)` so systemd restarts on new code |

## Testing & iteration

- **Local typecheck:** `bunx tsc --noEmit` (run on every change).
- **Smoke a single piece:** `bun run smoke:opencode`, `smoke:validate <sandbox>`, `smoke:generate`, etc.
- **One full tick on the ThinkStation:** `bun run once` (skips the loop, runs through publish + notify).
- **The dev box and the ThinkStation are different machines.** Code lives on the dev box, runs on the ThinkStation. Sync is via `git pull` (the manager repo is public on github.com/matte250/slop-factory).

## When something hangs

The pattern is always the same: a subprocess (opencode / git / playwright) didn't propagate a kill signal to its children, so `close` never fires, so the awaiting promise never resolves. Symptoms:
- journal goes silent after a "kill" warning
- service still shows `active`, no new ticks
- `pkill -9 bun` recovers it

Fix: ensure that subprocess wrapper has process-group kill + deadman. We've already retrofitted `opencode.ts` and `git_repo.ts`; if you add a new subprocess wrapper, copy that pattern.
