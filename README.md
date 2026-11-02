# Gemini 3.5 Transcribe for OpenClaw

Registers `gemini-3.5-transcribe` as an OpenClaw audio media-understanding provider.
OpenClaw's bundled Google audio provider only calls `:generateContent`, which the
dedicated Transcribe model does not serve; this plugin uses the Google Interactions
API instead.

## Auth

`GEMINI_API_KEY` (or `GOOGLE_API_KEY`) in the Gateway environment, or
`models.providers.gemini-transcribe.apiKey`.

## Config

```json5
{
  tools: {
    media: {
      models: [
        { provider: "gemini-transcribe", model: "gemini-3.5-transcribe", capabilities: ["audio"] },
        { type: "cli", command: "whisper", args: ["--model", "base", "{{AttachmentPath}}"], capabilities: ["audio"] }
      ],
      audio: { enabled: true, preferredModel: "gemini-transcribe/gemini-3.5-transcribe" }
    }
  }
}
```

## Development

```bash
npm install
npm run build     # tsc -> dist/index.js
npm test          # vitest (registration, auth, request shape, errors)
```

Install locally with `openclaw plugins install . --force`. Provider plugins are
validated at runtime by `openclaw plugins doctor`; `openclaw plugins validate`
and `plugins build` only cover tool/feature authoring metadata and intentionally
do not apply to media-understanding providers.
