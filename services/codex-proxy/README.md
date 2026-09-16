# codex-proxy

A small local server that exposes the **public OpenAI API shape** for the two calls a
voice-learning client needs, backed by the **Codex CLI subscription** instead of an API key:

| Public endpoint | What the proxy does behind it |
| --- | --- |
| `POST /v1/live/sessions` | Starts a Codex realtime V3 session (`gpt-live-1-codex`) on an ephemeral thread and returns the WebRTC SDP answer. Audio flows **directly** between the client and OpenAI; the proxy never touches media. |
| `GET /v1/live/sessions/:id/events` (WebSocket) | Streams the session's events with the public names (`session.started`, `session.input_transcript.delta`, `session.output_transcript.delta`, `session.usage.updated`, `session.closed`, `error`) and accepts the public commands (`session.instructions.append`, `session.thinking.append`, `session.commentary.append`, `session.input_audio.mute/unmute`, `session.close`). |
| `POST /v1/responses` | Runs a Codex text turn and returns a Responses-style object: `output[]` with `message`/`output_text`, `url_citation` annotations, `web_search_call` entries and `usage`. Supports `instructions`, `input`, `reasoning.effort`, `text.format` (`json_schema`) and `tools: [{type: "web_search"}]`. |
| `GET /v1/models`, `GET /healthz` | Inventory and status. |

Everything is authenticated with one bearer token, so a client configured with
`baseURL = http://<mac>:8790/v1` and `apiKey = <token>` works with the same code path it uses
against `https://api.openai.com/v1`. The only client-side difference is *where events come
from*: the public API delivers them on the WebRTC data channel, the proxy delivers them on the
WebSocket named in the session response (`events.url`).

The proxy is generic: nothing in it is specific to Mural, so any project that speaks the public
live/responses vocabulary can reuse it.

## Requirements

- Node.js 22.6 or later (24 recommended; TypeScript runs natively, no build step).
- Codex CLI 0.153 or later, logged in with ChatGPT (`codex login status`).
- The `realtime_conversation` feature is still marked *under development* by Codex; the proxy
  enables it only for its own child process and never edits your Codex configuration.

## Run

```sh
cd services/codex-proxy
npm install
cp .env.example .env      # optional: defaults listen on 127.0.0.1:8790
npm start
```

The first start generates a bearer token, stores it in `~/.config/codex-proxy/token` and prints
it together with the base URL. To reach the proxy from a phone or another machine over Tailscale,
set `CODEX_PROXY_HOST=tailscale` (binds to this Mac's `100.x.y.z` address) and keep the Mac awake.
Set `CODEX_PROXY_HOST=0.0.0.0` only on a trusted network; the token is the only protection.

```sh
curl http://127.0.0.1:8790/healthz
curl -H "authorization: Bearer $TOKEN" http://127.0.0.1:8790/v1/models
```

`npm run check` type-checks, `npm test` runs the unit tests (no Codex needed).

## How a voice session works

```
client                         codex-proxy                     codex app-server        OpenAI
  │ POST /v1/live/sessions ──────▶│ thread/start ────────────────▶│                       │
  │   {instructions, input,       │ thread/realtime/start (sdp) ─▶│── realtime V3 ───────▶│
  │    audio.output.voice,        │◀── thread/realtime/sdp ───────│◀── SDP answer ────────│
  │◀── {session, transport.sdp, ──│                               │                       │
  │     events.url}               │                               │                       │
  │ WebRTC media + data channel ──────────────────────────────────────────────────────────▶│
  │ WS /events ──────────────────▶│◀── transcript/delta, /done ───│◀── transcripts ───────│
  │◀── session.*_transcript.delta │                               │                       │
  │ session.instructions.append ─▶│ thread/realtime/appendText ──▶│                       │
  │ session.commentary.append ───▶│ thread/realtime/appendSpeech ▶│                       │
  │ session.close ───────────────▶│ thread/realtime/stop ────────▶│                       │
  │◀── session.closed             │◀── thread/realtime/closed ────│                       │
```

The public API only speaks when the client instructs it; Codex's live model greets on its own.
The proxy appends a short preamble to the instructions asking the model to stay silent until the
first `[App instruction]` arrives, and frames every injected message so the model acts on it
aloud without reading the app text. The wording matters: with Mural's full teaching prompt a
softer framing ("follow it, never read it aloud") left the model silent, while the shipped one
produces the greeting in 3–5 s. Verified on 15 September 2026: the model stayed silent, greeted on
the first instruction, transcribed real user audio with `role: user`, spoke `commentary` verbatim
and closed on request.

### Event and command mapping

| Client sends | Proxy does | Client receives |
| --- | --- | --- |
| `session.instructions.append` | `appendText("[App instruction] …")`, prefixed with any buffered thinking context | `session.instructions.appended` |
| `session.thinking.append` | Buffered (see below) | `session.thinking.appended` |
| `session.commentary.append` | `appendSpeech(content)` — spoken verbatim | `session.commentary.appended` |
| `session.input_audio.mute` / `unmute` | Acknowledged only; mute the local track on the client | `session.input_audio.muted` / `unmuted` |
| `session.close` | `thread/realtime/stop` | `session.closed {reason, usage.seconds}` |
| anything else | rejected | `error {error.client_event_id}` |

| Codex notification | Client receives |
| --- | --- |
| `thread/realtime/started` | `session.started {session.id}` (buffered until the WebSocket attaches) |
| `thread/realtime/transcript/delta {role, delta}` | `session.input_transcript.delta` or `session.output_transcript.delta` with `event_id`, `delta`, `start_ms`, `end_ms` |
| `thread/realtime/transcript/done` | `session.input_transcript.done` / `session.output_transcript.done {text}` |
| every 15 s | `session.usage.updated {usage.seconds}` |
| `thread/realtime/error` | `error`, then the session is closed |
| `thread/realtime/closed` | `session.closed` |
| `thread/realtime/itemAdded {item.type: "handoff_request"}` | `session.delegation.created {delegation: {id, target: "server", input}}` |
| `turn/completed` of that handoff | `session.delegation.completed {delegation: {id, target: "server", status, web_searches}}` |

### Handoffs (delegation)

With the public API the live model emits `session.delegation.created` with `target: "client"`,
the client answers with its own text model and sends the result back as
`session.commentary.append`. Codex's live model does the same thing internally: it adds a
`handoff_request` item to the thread, Codex runs an agent turn on that thread and hands the
answer back to the voice. The proxy starts the session with `clientManagedHandoffs: false` and
`codexResponseHandoffMode: "commentary"` (`CODEX_PROXY_HANDOFF`), which makes the live model
speak the answer in its own words a few seconds after the turn ends. With client-managed
handoffs, or with the `thinking` mode, the answer never reaches the ear: the model says "let me
check that" and stays silent (probe 15, 15 September 2026).

Because Codex answers on the Mac, the proxy reports the delegation with `target: "server"` so
clients that implement the public flow do not answer it a second time, and follows up with
`session.delegation.completed` when the agent turn ends. The agent runs with the session's
`instructions` as context plus a short brief (target language, at most 120 words, plain prose,
web search only for current facts) on `CODEX_PROXY_TEXT_MODEL` / `TEXT_EFFORT`, read-only, with
web search enabled.

`start_ms`/`end_ms` are receipt times on the proxy clock plus an estimated spoken duration; Codex
does not expose word timing. They are good enough for grouping fragments into passages.

### Thinking context

Codex has no way to add silent context to a live session: `appendText` always makes the model
respond. `CODEX_PROXY_THINKING` chooses how `session.thinking.append` is delivered:

- `buffer` (default): kept and prepended to the next `session.instructions.append`. Context that
  is never followed by an instruction is dropped when the session ends.
- `flush-on-quiet`: additionally sent after `CODEX_PROXY_QUIET_SECONDS` without transcript
  activity; the model usually reacts with a short spoken turn.
- `immediate`: sent at once (the model replies aloud).

## Text turns

`POST /v1/responses` creates an ephemeral, read-only Codex thread per request with
`baseInstructions` set to your `instructions` (Codex's own system prompt is replaced), sends the
user text as one turn and waits for `turn/completed`. Timing measured with `gpt-5.6-luna`,
effort `low`: translation ≈ 5 s, structured assessment ≈ 10 s, web search ≈ 14 s.

- `model`: used when Codex lists it (`GET /v1/models`); otherwise `CODEX_PROXY_TEXT_MODEL`.
- `reasoning.effort`: used when the model supports it; otherwise `CODEX_PROXY_TEXT_EFFORT`.
- `text.format.type = json_schema`: passed as the turn's `outputSchema`; the answer is validated
  as JSON before it is returned.
- `tools: [{type: "web_search"}]`: enables Codex's live web search for that thread. Markdown links
  and Codex's internal citation markers both become `url_citation` annotations; each search
  becomes a `web_search_call` output item.
- `usage`: `thread/tokenUsage/updated` totals for the turn. Expect roughly 8k input tokens of
  Codex scaffolding per call; it counts against the Codex plan, not an API balance.
- Ignored: `max_output_tokens`, `store`, `tool_choice`, `max_tool_calls`, streaming.

## Known differences from the public API

- Voices: the Codex V3 backend accepts `cove`, `juniper`, `maple`, `spruce`, `ember`, `vale`,
  `breeze`, `arbor`, `sol`. `marin` and other v2 voices are substituted with
  `CODEX_PROXY_DEFAULT_VOICE`; the session object reports `voice_substituted: true`.
- Instructions cannot change after the session starts; `session.instructions.append` is delivered
  as an app message the model follows.
- Delegations are answered by Codex on the Mac, not by the client: `session.delegation.created`
  carries `target: "server"` and is followed by `session.delegation.completed`. The client's own
  `/v1/responses` delegation prompt is not used for them.
- Usage is wall-clock seconds, not billed audio seconds.
- Quota: voice consumes the Codex 5-hour window (about 1 % per 100 s on Plus in our measurement).

## Configuration

See `.env.example`. Every variable has a default.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_PROXY_HOST` | `127.0.0.1` | Bind address; `tailscale` picks the Tailscale IPv4 |
| `CODEX_PROXY_PORT` | `8790` | Port |
| `CODEX_PROXY_TOKEN` | generated | Bearer token |
| `CODEX_PROXY_CODEX_BIN` | `codex` | Codex executable |
| `CODEX_PROXY_LIVE_MODEL` | `gpt-live-1-codex` | Realtime model |
| `CODEX_PROXY_DEFAULT_VOICE` | `cove` | Voice when the requested one is unavailable |
| `CODEX_PROXY_TEXT_MODEL` / `TEXT_EFFORT` | `gpt-5.6-luna` / `low` | Text fallbacks |
| `CODEX_PROXY_THINKING` | `buffer` | See *Thinking context* |
| `CODEX_PROXY_HANDOFF` | `commentary` | How the agent's answer to a voice handoff reaches the live model; see *Handoffs* |
| `CODEX_PROXY_MAX_SESSION_MINUTES` | `60` | Hard stop per voice session |
| `CODEX_PROXY_CLIENT_GRACE_SECONDS` | `90` | Close a session whose events client never attached or went away |
| `CODEX_PROXY_CORS_ORIGINS` | `*` | Allowed browser origins |
| `CODEX_PROXY_DATA_DIR` | `~/.config/codex-proxy` | Token file and the empty workspace Codex runs in |

## What the child Codex process sees

The proxy starts `codex app-server --stdio` with the API-key environment variables removed,
`hooks`, `apps`, `computer_use`, `browser_use`, `plugins`, `multi_agent`, `image_generation`,
`skill_search`, `tool_suggest` and `goals` disabled, `notify` cleared, and every MCP server from
your `config.toml` disabled by name. Threads are ephemeral, read-only, never ask for approval, and
any tool or approval request from Codex is rejected. Your global Codex settings are not modified.
