import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MediaUnderstandingProviderPlugin,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import entry from "./index.js";

function captureProvider(): MediaUnderstandingProviderPlugin {
  let captured: MediaUnderstandingProviderPlugin | undefined;
  const api = {
    registerMediaUnderstandingProvider(provider: MediaUnderstandingProviderPlugin) {
      captured = provider;
    },
  } as unknown as OpenClawPluginApi;
  entry.register(api);
  if (!captured) throw new Error("plugin did not register a media understanding provider");
  return captured;
}

function jsonResponse(payload: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

function transcribeRequest(overrides: Record<string, unknown> = {}) {
  return {
    buffer: Buffer.from("audio-bytes"),
    fileName: "voice.ogg",
    mime: "audio/ogg",
    model: "gemini-3.5-transcribe",
    apiKey: "test-key",
    timeoutMs: 5000,
    ...overrides,
  } as Parameters<NonNullable<MediaUnderstandingProviderPlugin["transcribeAudio"]>>[0];
}

const savedGemini = process.env.GEMINI_API_KEY;
const savedGoogle = process.env.GOOGLE_API_KEY;

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedGemini === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = savedGemini;
  if (savedGoogle === undefined) delete process.env.GOOGLE_API_KEY;
  else process.env.GOOGLE_API_KEY = savedGoogle;
});

describe("gemini-transcribe", () => {
  it("registers the audio media-understanding provider", () => {
    const provider = captureProvider();
    expect(provider.id).toBe("gemini-transcribe");
    expect(provider.capabilities).toEqual(["audio"]);
    expect(provider.defaultModels).toEqual({ audio: "gemini-3.5-transcribe" });
    expect(provider.autoPriority).toEqual({ audio: 25 });
  });

  it("resolves auth from env and from provider config", () => {
    const provider = captureProvider();
    process.env.GEMINI_API_KEY = "env-key";
    delete process.env.GOOGLE_API_KEY;

    expect(provider.resolveAuth?.({ provider: "gemini-transcribe" } as never)).toMatchObject({
      kind: "api-key",
      apiKey: "env-key",
      source: "env:GEMINI_API_KEY",
    });

    expect(
      provider.resolveAuth?.({
        provider: "gemini-transcribe",
        providerConfig: { apiKey: "config-key" },
      } as never),
    ).toMatchObject({ kind: "api-key", apiKey: "config-key" });

    delete process.env.GEMINI_API_KEY;
    expect(provider.resolveAuth?.({ provider: "gemini-transcribe" } as never)).toBeNull();
  });

  it("posts inline audio to the Interactions API and returns the transcript", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        id: "interaction-1",
        status: "completed",
        steps: [{ content: [{ type: "text", text: "Hello from Gemini." }] }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = captureProvider();

    const result = await provider.transcribeAudio!(transcribeRequest());

    expect(result).toEqual({ text: "Hello from Gemini.", model: "gemini-3.5-transcribe" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("gemini-3.5-transcribe");
    expect(body.input).toEqual([
      {
        type: "audio",
        data: Buffer.from("audio-bytes").toString("base64"),
        mime_type: "audio/ogg",
      },
    ]);
  });

  it("throws on HTTP failure so provider selection stops", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { message: "bad key" } }, { ok: false, status: 401 })),
    );
    const provider = captureProvider();

    await expect(provider.transcribeAudio!(transcribeRequest())).rejects.toThrow(
      /Gemini 3\.5 Transcribe HTTP 401/,
    );
  });

  it("throws on an empty transcript", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ id: "x", status: "completed", steps: [] })),
    );
    const provider = captureProvider();

    await expect(provider.transcribeAudio!(transcribeRequest())).rejects.toThrow(/empty transcript/);
  });
});
