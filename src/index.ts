import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { MediaUnderstandingProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";

const PLUGIN_ID = "gemini-transcribe";
const DEFAULT_MODEL = "gemini-3.5-transcribe";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 1000;

type ApiKeySource = { apiKey: string; source: string };
type InteractionContent = { type?: string; text?: string };
type InteractionStep = { content?: InteractionContent[] };
type InteractionPayload = { id?: string; status?: string; steps?: InteractionStep[] };
type TranscribeRequest = Parameters<NonNullable<MediaUnderstandingProviderPlugin["transcribeAudio"]>>[0];
type ProviderConfigLike = { apiKey?: unknown } | undefined;

function resolveApiKey(providerConfig?: ProviderConfigLike): ApiKeySource | null {
  const configured =
    typeof providerConfig?.apiKey === "string" ? providerConfig.apiKey.trim() : "";
  if (configured) {
    return { apiKey: configured, source: "config:models.providers.gemini-transcribe.apiKey" };
  }
  const fromGemini = process.env.GEMINI_API_KEY?.trim();
  if (fromGemini) return { apiKey: fromGemini, source: "env:GEMINI_API_KEY" };
  const fromGoogle = process.env.GOOGLE_API_KEY?.trim();
  if (fromGoogle) return { apiKey: fromGoogle, source: "env:GOOGLE_API_KEY" };
  return null;
}

function extractText(payload: InteractionPayload | undefined): string {
  const parts: string[] = [];
  for (const step of payload?.steps ?? []) {
    for (const content of step?.content ?? []) {
      if (content?.type === "text" && typeof content.text === "string" && content.text.trim()) {
        parts.push(content.text.trim());
      }
    }
  }
  return parts.join("\n");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return "";
  }
}

async function createInteraction(params: {
  apiKey: string;
  baseUrl: string;
  model: string;
  buffer: Buffer;
  mime?: string;
  language?: string;
  fetchFn?: typeof fetch;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ text: string; model: string }> {
  const root = params.baseUrl.replace(/\/+$/, "");
  const request = params.fetchFn ?? fetch;
  const body: Record<string, unknown> = {
    model: params.model,
    input: [
      {
        type: "audio",
        data: params.buffer.toString("base64"),
        mime_type: params.mime || "audio/wav",
      },
    ],
  };
  if (params.language) {
    body.generation_config = { transcription_config: { language_codes: [params.language] } };
  }

  const signals: AbortSignal[] = [];
  if (params.signal) signals.push(params.signal);
  if (Number.isFinite(params.timeoutMs) && params.timeoutMs > 0) {
    signals.push(AbortSignal.timeout(params.timeoutMs));
  }
  const combinedSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

  const response = await request(`${root}/interactions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": params.apiKey },
    body: JSON.stringify(body),
    ...(combinedSignal ? { signal: combinedSignal } : {}),
  });

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(
      `Gemini 3.5 Transcribe HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }

  let payload = (await response.json()) as InteractionPayload;
  const interactionId = payload.id;

  for (let attempt = 0; attempt < POLL_ATTEMPTS && !extractText(payload); attempt += 1) {
    if (payload.status === "failed" || payload.status === "cancelled") {
      throw new Error(`Gemini 3.5 Transcribe interaction ${payload.status}`);
    }
    if (payload.status === "completed" || !interactionId) break;
    await delay(POLL_INTERVAL_MS);
    const poll = await request(`${root}/interactions/${encodeURIComponent(interactionId)}`, {
      headers: { "x-goog-api-key": params.apiKey },
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!poll.ok) {
      throw new Error(`Gemini 3.5 Transcribe poll HTTP ${poll.status}`);
    }
    payload = (await poll.json()) as InteractionPayload;
  }

  const text = extractText(payload);
  if (!text) throw new Error("Gemini 3.5 Transcribe returned an empty transcript");
  return { text, model: params.model };
}

const provider: MediaUnderstandingProviderPlugin = {
  id: PLUGIN_ID,
  capabilities: ["audio"],
  defaultModels: { audio: DEFAULT_MODEL },
  autoPriority: { audio: 25 },
  resolveAuth(ctx) {
    const resolved = resolveApiKey(ctx.providerConfig);
    return resolved ? { kind: "api-key", apiKey: resolved.apiKey, source: resolved.source } : null;
  },
  async transcribeAudio(req: TranscribeRequest) {
    const apiKey =
      req.auth?.kind === "api-key" ? req.auth.apiKey : req.apiKey || resolveApiKey()?.apiKey;
    if (!apiKey) {
      throw new Error("Gemini 3.5 Transcribe: GEMINI_API_KEY is not configured");
    }
    return await createInteraction({
      apiKey,
      baseUrl: req.baseUrl?.trim() || DEFAULT_BASE_URL,
      model: req.model?.trim() || DEFAULT_MODEL,
      buffer: req.buffer,
      mime: req.mime,
      language: req.language,
      fetchFn: req.fetchFn,
      timeoutMs: req.timeoutMs || 120_000,
      signal: req.signal,
    });
  },
};

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Gemini 3.5 Transcribe",
  description: "Audio transcription via Gemini 3.5 Transcribe (Google Interactions API).",
  register(api) {
    api.registerMediaUnderstandingProvider(provider);
  },
});
