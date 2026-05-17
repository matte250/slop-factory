import { staticChecks } from "./static.ts";
import { browserChecks } from "./browser.ts";
import type { ValidationResult } from "./types.ts";

export type { ValidationResult } from "./types.ts";
export { staticChecks } from "./static.ts";
export { browserChecks, type BrowserCheckOptions } from "./browser.ts";

export async function validate(sandboxDir: string): Promise<ValidationResult> {
  const sr = await staticChecks(sandboxDir);
  if (!sr.ok) return sr;

  const br = await browserChecks({ sandboxDir });
  if (!br.ok) return { ok: false, errors: br.errors, meta: sr.meta };

  return { ok: true, errors: [], meta: sr.meta };
}
