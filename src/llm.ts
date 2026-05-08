import { loadConfig } from "./config.ts";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatOptions = {
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "text" | "json_object";
  signal?: AbortSignal;
};

export async function chat(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  const cfg = loadConfig();
  const url = `${cfg.VLLM_BASE_URL.replace(/\/$/, "")}/chat/completions`;

  const body: Record<string, unknown> = {
    model: cfg.VLLM_MODEL,
    messages,
    temperature: opts.temperature ?? 0.8,
  };
  if (opts.maxTokens != null) body.max_tokens = opts.maxTokens;
  if (opts.responseFormat === "json_object") {
    body.response_format = { type: "json_object" };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.VLLM_API_KEY}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "<unreadable>");
    throw new Error(`vLLM ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error(`vLLM response missing choices[0].message.content: ${JSON.stringify(json).slice(0, 500)}`);
  }
  return content;
}
