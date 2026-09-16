# Mural for the web and desktop

The iPhone app, rebuilt for the browser and wrapped in Tauri for macOS, Windows and Linux.
Same conversation practice, same nine language modules and 24 themes, same learning records
(backups are interchangeable with the phone apps), same look.

Two ways to connect, both chosen in **Settings → How Mural connects**:

| Path | What you enter | Who pays |
| --- | --- | --- |
| **OpenAI API key** | A key from platform.openai.com | Your OpenAI project, per minute and per token |
| **Codex on my Mac** | The base URL and token printed by [`services/codex-proxy`](../../services/codex-proxy/README.md) | Your ChatGPT/Codex plan quota |

The app code path is identical for both: it sends the public `live/sessions` and `responses`
requests to whichever base URL is configured. With the proxy, session events arrive over a
WebSocket instead of the WebRTC data channel; the transport layer hides that.

## Run in a browser

```sh
cd apps/web
npm install
npm run dev          # http://localhost:5173
```

The microphone needs a secure context: `localhost`, HTTPS, or the desktop app. To use the browser
build from a phone over Tailscale you would need HTTPS on the dev server; the desktop app or the
native phone apps are the simpler route.

`npm test` runs the core tests, including the shared cross-platform fixture that the iPhone and
Android cores also decode. `npm run check` type-checks. `npm run build` produces `dist/`.

## Run as a desktop app

Requires Rust (stable) and the platform prerequisites from the Tauri documentation. On macOS,
Xcode Command Line Tools are enough.

```sh
npm run tauri dev    # development window with hot reload from Vite
npm run tauri build  # .app / .dmg under src-tauri/target/release/bundle
```

Development loads the Vite server (`http://localhost:5173`), so `isSecureContext` is true and the
microphone works. The production bundle serves the app from Tauri's own origin; the config sets
`macOSPrivateApi` so that origin is treated as secure. `src-tauri/Info.plist` carries the
microphone usage description macOS requires.

Backups are exported and imported through native file dialogs in the desktop app and through the
browser's download and file picker on the web.

## Layout

| Path | Contents |
| --- | --- |
| `src/core/` | Port of `apps/ios/Core/`: models, archive codec, learning engine, teaching policy, themes, languages, meaning controller, final assessment queue, captions and language detection |
| `src/services/` | API client (base URL + bearer), WebRTC transport with pluggable event channel, IndexedDB store, platform bridge (browser vs Tauri) |
| `src/app/` | `ConversationCoordinator`, the port of the iPhone coordinator, plus the React hook |
| `src/ui/` | Views: Talk, Themes, Words, Settings, Onboarding; the canvas orb; sheets, icons and shared components |
| `src-tauri/` | Tauri shell, capabilities and icons |
| `tests/` | Vitest suites |

## Differences from the iPhone app

- Mandarin pinyin uses `pinyin-pro` word segmentation instead of Apple's tokenizer; readings can
  differ in segmentation and neutral tones.
- The language redirect check uses `tinyld` instead of the system recogniser.
- Credentials live in the browser's storage for this origin, not in a hardware keychain. Backups
  never include them.
- Managed accounts, hosted minutes and purchases from the phone apps are not included.
- Through the Codex proxy: no `marin` voice (the proxy substitutes one of Codex's voices), lookups
  the voice asks for are answered by Codex on the Mac (reported as `session.delegation.created`
  with `target: "server"`, so the app only shows the "checking" state), and usage is counted in
  wall-clock seconds.
