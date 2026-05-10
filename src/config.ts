import { z } from "zod";

const Schema = z.object({
  VLLM_BASE_URL: z.string().url(),
  VLLM_MODEL: z.string().min(1),
  VLLM_API_KEY: z.string().min(1).default("not-needed-for-local"),

  OPENCODE_BIN: z.string().min(1).default("opencode"),
  OPENCODE_MODEL: z.string().min(1),
  OPENCODE_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),

  // Per-phase retry budget when validation fails (design / tasks). Implement
  // doesn't use this — it has its own per-task console-fix loop instead.
  STAGE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  // Per-task inner loop in the implement phase: after each task's opencode
  // run, load the page and resume the same session with any console errors
  // found, up to N times before moving to the next task.
  IMPLEMENT_CONSOLE_FIX_ITERATIONS: z.coerce.number().int().min(0).max(10).default(6),

  GAMES_REPO_PATH: z.string().min(1),
  GAMES_REPO_REMOTE: z.string().url(),
  GAMES_PAGES_BASE_URL: z.string().url(),
  GITHUB_TOKEN: z.string().min(1),

  DISCORD_WEBHOOK_URL: z.string().url(),

  SANDBOX_ROOT: z.string().min(1).default("/tmp/slop-factory-work"),
  LOOP_COOLDOWN_MS: z.coerce.number().int().nonnegative().default(1_800_000),
});

export type Config = z.infer<typeof Schema>;

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
