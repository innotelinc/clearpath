/**
 * OmniRoute is the only AI gateway this app talks to.
 *
 * OmniRoute exposes an OpenAI-compatible API, so the whole integration is one
 * POST to <base>/chat/completions with a bearer key. There is deliberately no
 * provider list, no SDK and no fallback gateway: configure OMNIROUTE_API_KEY
 * and the app has AI; leave it unset and every AI surface degrades to the
 * deterministic drafter instead of failing.
 *
 *   OMNIROUTE_API_KEY   required to enable AI
 *   OMNIROUTE_BASE_URL  optional, defaults to http://localhost:20128/v1
 *   OMNIROUTE_MODEL     optional, defaults to "auto" (OmniRoute's router)
 */

const DEFAULT_BASE_URL = "http://localhost:20128/v1";
const DEFAULT_MODEL = "auto";

export const aiApiKey = String(process.env.OMNIROUTE_API_KEY || "").trim();
export const aiBaseUrl = String(process.env.OMNIROUTE_BASE_URL || DEFAULT_BASE_URL)
  .trim()
  .replace(/\/+$/, "");
export const aiModel = String(process.env.OMNIROUTE_MODEL || DEFAULT_MODEL).trim();
export const aiConfigured = aiApiKey.length > 0;

/** Safe to show in a view: the configured model, never the key. */
export function aiLabel() {
  if (!aiConfigured) return "OmniRoute not configured";
  return `OmniRoute · ${aiModel}`;
}

export class AiError extends Error {
  constructor(message, { status = 0 } = {}) {
    super(message);
    this.name = "AiError";
    this.status = status;
  }
}

function readContent(payload) {
  const choice = payload?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("")
      .trim();
  }
  return "";
}

/**
 * One chat completion through OmniRoute.
 *
 * `messages` is the OpenAI message array; the caller decides the prompt. Errors
 * are thrown as AiError with a message that is safe to render — never the key,
 * never the raw request.
 */
export async function aiChat({
  messages,
  maxTokens = 1400,
  temperature = 0.2,
  timeoutMs = 45_000
} = {}) {
  if (!aiConfigured) {
    throw new AiError("OmniRoute is not configured. Set OMNIROUTE_API_KEY and restart.");
  }
  if (!Array.isArray(messages) || !messages.length) {
    throw new AiError("No prompt was sent to OmniRoute.");
  }

  let response;
  try {
    response = await fetch(`${aiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${aiApiKey}`,
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({ model: aiModel, messages, temperature, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new AiError("OmniRoute did not answer in time. Try again, or draft without AI.");
    }
    const code = err?.cause?.code || err?.code || "";
    throw new AiError(
      `Could not reach OmniRoute at ${aiBaseUrl}${code ? ` (${code})` : ""}. Check the gateway is running.`
    );
  }

  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json();
      detail = payload?.error?.message || payload?.message || "";
    } catch {
      /* provider sent no JSON body */
    }
    throw new AiError(
      `OmniRoute returned ${response.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}.`,
      { status: response.status }
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new AiError("OmniRoute returned a response that was not JSON.");
  }

  const text = readContent(payload);
  if (!text) throw new AiError("OmniRoute returned an empty completion.");

  return {
    text,
    model: String(payload?.model || aiModel),
    usage: payload?.usage || null
  };
}

/** Strip fences and stray prose some models add around a JSON object. */
export function parseJsonReply(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}
