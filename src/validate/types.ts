import type { GameMeta } from "../games-index.ts";

export type ValidationResult = {
  ok: boolean;
  errors: string[];
  meta?: GameMeta;
};
