# Codex Live voice smoke test

## Verified result

On 15 September 2026, the locally installed Codex CLI **0.153.4** successfully
created a **V3 WebRTC** session requesting **`gpt-live-1-codex`**, using saved
**ChatGPT authentication**. No OpenAI API key was supplied. The subprocess
explicitly removes `OPENAI_API_KEY`, `CODEX_API_KEY`, and `CODEX_ACCESS_TOKEN`
from its environment and checks that `account/read` reports `chatgpt`.

The test received real audio and the matching transcript:

> Hola Javier, la conexión de voz funciona.

- WebRTC connected: 2.084 seconds after test startup.
- First decoded audio: 2.834 seconds after test startup.
- Received 254 resampled audio frames, including 37,394 samples above the
  test's amplitude threshold.
- Explicit realtime closure was confirmed with reason `requested`.
- Total test duration, including cleanup: 8.348 seconds.

Evidence: `result/result.json`, `result/events.json`, and `result/received.wav`.
The WAV contains only synthetic test output. The test does not open a microphone.

## Run again

Requires Python 3.10+, a compatible Codex CLI, and an existing ChatGPT login
(`codex login status`). Run from this directory:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python smoke.py
```

Each run makes a real, short voice call using the account's available access
and overwrites the files in `result/`. It enables `realtime_conversation` only
for the child app-server process, opts into its experimental protocol, and
uses an ephemeral thread. It does not edit the user's Codex configuration or
read/copy authentication files. Codex itself manages the saved authentication.

The client sends a silent audio track, creates the `oai-events` data channel,
and passes its SDP offer to `thread/realtime/start` with:

```json
{
  "version": "v3",
  "model": "gpt-live-1-codex",
  "outputModality": "audio",
  "includeStartupContext": false,
  "clientManagedHandoffs": true,
  "transport": {"type": "webrtc", "sdp": "<generated offer>"}
}
```

It applies the answer from `thread/realtime/sdp`, decodes incoming audio, and
requests `thread/realtime/stop` before closing the peer and child process.
The SDP and credentials are not included in the saved evidence.

## Scope

This establishes account access, custom voice instructions, WebRTC negotiation,
audio reception, matching transcript events, and explicit session closure on
this Mac. It does not yet test microphone recognition, interruption, a remote
phone, Tailscale routing, prolonged calls, or Mural's teaching/delegation flow.
It does not establish general access to the public `gpt-live-1` API or that the
Codex variant is identical to that model.

For Mural, the next integration would relay SDP and session controls between
the native app and an app-server on the Mac. Tailscale can carry that control
connection; media routing must be verified separately. The phone still needs
an installed native build: this project does not use Expo or Metro.

No Mural application source or persistent Codex settings were changed for this test.
