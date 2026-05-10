/**
 * One JSON event per line in opencode's --format json stdout stream.
 * Schema reverse-engineered from observed output (no formal docs).
 */
export type OpenCodeEvent = {
  type?: string;
  sessionID?: string;
  part?: {
    type?: string;
    reason?: string;
    tool?: string;
    text?: string;
    state?: { input?: Record<string, unknown>; output?: string };
    tokens?: { total?: number; input?: number; output?: number; reasoning?: number };
  };
};

/**
 * The terminal event: model decided to stop, agent loop ends. Distinct from
 * `step_finish` with `reason: "tool-calls"` (which means "this step done,
 * starting next").
 */
export function isStopEvent(ev: OpenCodeEvent): boolean {
  return ev.type === "step_finish" && ev.part?.reason === "stop";
}

/**
 * Render an event as a (msg, fields) pair for the structured logger. Returns
 * null for events we don't want in the journal at info level (caller can log
 * them at debug instead).
 */
export function describeEvent(
  ev: OpenCodeEvent,
): { msg: string; fields: Record<string, unknown> } | null {
  switch (ev.type) {
    case "step_start":
      return { msg: "opencode step.start", fields: { sessionID: ev.sessionID } };
    case "tool_use": {
      const inputSummary: Record<string, string> = {};
      const input = ev.part?.state?.input ?? {};
      for (const [k, v] of Object.entries(input)) {
        const s = typeof v === "string" ? v : JSON.stringify(v);
        inputSummary[k] = s.length > 80 ? s.slice(0, 80) + "…" : s;
      }
      return { msg: "opencode step.tool", fields: { tool: ev.part?.tool, input: inputSummary } };
    }
    case "text":
      return { msg: "opencode step.text", fields: { preview: ev.part?.text?.slice(0, 200) } };
    case "reasoning":
      return {
        msg: "opencode step.reasoning",
        fields: {
          chars: ev.part?.text?.length ?? 0,
          preview: ev.part?.text?.slice(0, 200),
        },
      };
    case "step_finish":
      return {
        msg: "opencode step.finish",
        fields: {
          reason: ev.part?.reason,
          tokensTotal: ev.part?.tokens?.total,
          tokensOutput: ev.part?.tokens?.output,
          reasoning: ev.part?.tokens?.reasoning,
        },
      };
    default:
      return null;
  }
}
