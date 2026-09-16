import { useState } from "react";
import type { ConversationCoordinator } from "../app/coordinator";
import { LanguageRegistry, MeaningLanguages, settingsTitle } from "../core/languages";
import { isTauri, pickTextFile, saveTextFile } from "../services/platform";
import { normaliseProxyURL, validateOpenAIKey } from "../services/storage";
import { Alert, ExternalLink, Sheet, Toggle } from "./components";
import { Icon } from "./icons";
import { THIRD_PARTY_NOTICES } from "./notices";

const VOICE_RATE_USD_PER_MINUTE = 0.05;

export function SettingsView({ coordinator }: { coordinator: ConversationCoordinator }) {
  const store = coordinator.store;
  const preferences = store.preferences;
  const running = coordinator.isRunning;
  const [message, setMessage] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [notices, setNotices] = useState(false);
  const totalVoiceSeconds = store.sessions.reduce((sum, s) => sum + s.voiceSeconds, 0);
  const searchCalls = store.sessions.reduce((sum, s) => sum + s.searchCalls, 0);

  const exportBackup = async () => {
    try {
      const ok = await saveTextFile("Mural-learning-backup.json", store.exportData());
      setMessage(ok ? "Your backup has been saved." : null);
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
  };
  const importBackup = async () => {
    try {
      const text = await pickTextFile();
      if (text === null) return;
      store.importData(text);
      setMessage("Your backup has been imported.");
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div style={{ paddingBottom: 12 }}>
      <Section header="Just your pace" footer={running ? "End this conversation to switch languages. Each language keeps its own words and progress." : "Each language keeps its own words and progress. Mural finds your pace through conversation."}>
        <Row label="Learning language">
          <select className="select" disabled={running} value={coordinator.language.id} onChange={(e) => coordinator.selectLanguage(e.target.value)}>
            {LanguageRegistry.all.map((l) => <option key={l.id} value={l.id}>{settingsTitle(l)}</option>)}
          </select>
        </Row>
        <Row label="Meaning subtitles"><Toggle checked={preferences.meaningVisible} label="Meaning subtitles" onChange={() => coordinator.toggleMeaning()} /></Row>
        <Row label="Meaning language">
          <select className="select" value={preferences.meaningLanguage} onChange={(e) => coordinator.selectMeaningLanguage(e.target.value)}>
            {MeaningLanguages.all.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </Row>
        <Row label="Corrections"><span className="form-row__value">Gently, as we talk</span></Row>
        <div className="form-row form-row--column">
          <span>A few things you enjoy</span>
          <input className="field" value={preferences.interests} placeholder="Music, hiking, cooking…" onChange={(e) => store.updatePreferences((p) => { p.interests = e.target.value.slice(0, 500); })} />
        </div>
      </Section>

      <ConnectionSection coordinator={coordinator} setMessage={setMessage} />
      {message ? <p className="form-section__footer">{message}</p> : null}

      <Section header="Keep it comfortable" footer={`Voice estimate uses $${VOICE_RATE_USD_PER_MINUTE.toFixed(2)}/min as of 11 September 2026 for the OpenAI API. Through Codex the same time counts against your plan’s window instead. Translation, teaching and search cost extra. The time limit is local, not a billing cap.`}>
        <Row label="Conversation limit">
          <select className="select" value={preferences.sessionMinutes} onChange={(e) => store.updatePreferences((p) => { p.sessionMinutes = Number(e.target.value); })}>
            {[5, 10, 15, 20, 30, 60].map((m) => <option key={m} value={m}>{m} minutes</option>)}
          </select>
        </Row>
        <Row label="Recorded voice time"><span className="form-row__value">{Math.floor(totalVoiceSeconds / 60)} min {Math.floor(totalVoiceSeconds) % 60} sec</span></Row>
        <Row label="Voice estimate"><span className="form-row__value">${((totalVoiceSeconds / 60) * VOICE_RATE_USD_PER_MINUTE).toFixed(2)} USD</span></Row>
        <Row label="Search calls recorded"><span className="form-row__value">{searchCalls}</span></Row>
        <Row label={<ExternalLink href="https://platform.openai.com/usage" className="link">OpenAI usage and billing</ExternalLink>} />
      </Section>

      <Section header="Your words belong to you" footer="Backups include transcripts and learning evidence, never your key or proxy token. Import adds conversations with new IDs. Existing conversations stay unchanged. There is no cloud sync.">
        <Row label={<button className="button-inline row" onClick={() => void exportBackup()}><Icon name="square.and.arrow.up" />Export learning backup</button>} />
        <Row label={<button className="button-inline row" disabled={running} onClick={() => void importBackup()}><Icon name="square.and.arrow.down" />Import learning backup</button>} />
        <Row label={<button className="button-inline button-inline--danger" disabled={running} onClick={() => setDeleting(true)}>Delete all conversations and learning</button>} />
      </Section>

      <Section header="Help and privacy">
        <Row label={<ExternalLink href="https://mural.chat/privacy/" className="link">Privacy policy</ExternalLink>} />
        <Row label={<ExternalLink href="https://mural.chat/terms/" className="link">Terms of use</ExternalLink>} />
        <Row label={<ExternalLink href="https://mural.chat/support/" className="link">Contact support</ExternalLink>} />
      </Section>

      <Section header="About">
        <Row label={<span className="footnote">Mural web 0.1 · {isTauri() ? "Desktop build" : "Browser build"} · {window.isSecureContext ? "microphone available" : "insecure page: microphone unavailable"}</span>} />
        <Row label={<span className="footnote">Voice: GPT-Live-1 · Teacher: GPT-5.6 Luna · via {coordinator.connectionSettings.mode === "codex" ? "Codex proxy" : "OpenAI API"}</span>} />
        <Row label={<ExternalLink href="https://developers.openai.com/api/docs/guides/your-data" className="link">OpenAI data controls</ExternalLink>} />
        <Row label={<span className="footnote">Audio and selected text go to OpenAI while you practise. Requests disable provider storage where supported; abuse-monitoring retention may still apply. Raw audio is not saved by Mural.</span>} />
        <Row label={<button className="button-inline" onClick={() => setNotices(true)}>Open-source notices</button>} />
      </Section>

      <Sheet open={notices} size="large" title="Open-source notices" onClose={() => setNotices(false)} trailing={<button className="sheet__action" onClick={() => setNotices(false)}>Done</button>}>
        <pre className="footnote" style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{THIRD_PARTY_NOTICES}</pre>
      </Sheet>
      {deleting ? (
        <Alert title="Delete all learning data in this app?" message="This removes conversations, vocabulary and progress. Export a backup first if you want to keep them. Your connection settings and preferences remain." actions={[
          { label: "Delete all learning data", kind: "danger", onClick: () => { coordinator.deleteLearningData(); setDeleting(false); } },
          { label: "Cancel", onClick: () => setDeleting(false) },
        ]} />
      ) : null}
    </div>
  );
}

function ConnectionSection({ coordinator, setMessage }: { coordinator: ConversationCoordinator; setMessage: (m: string | null) => void }) {
  const settings = coordinator.connectionSettings;
  const running = coordinator.isRunning;
  const [key, setKey] = useState("");
  const [proxyURL, setProxyURL] = useState(settings.proxyURL);
  const [proxyToken, setProxyToken] = useState(settings.proxyToken);
  const [checking, setChecking] = useState(false);
  const [health, setHealth] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(settings.proxyURL && settings.proxyToken ? `Saved: ${settings.proxyURL}` : null);

  const saveKey = () => {
    try {
      const value = validateOpenAIKey(key);
      coordinator.updateConnection((s) => { s.openaiKey = value; s.mode = "openai"; });
      setKey(""); setMessage("Saved. Start a conversation to connect.");
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
  };
  // The proxy fields save themselves as soon as both are filled, so closing the sheet never loses them.
  const applyProxy = (url: string, token: string) => {
    setProxyURL(url); setProxyToken(token);
    const trimmedToken = token.trim();
    if (!url.trim() || !trimmedToken) { setSaved(null); return; }
    try {
      const normalised = normaliseProxyURL(url);
      coordinator.updateConnection((s) => { s.proxyURL = normalised; s.proxyToken = trimmedToken; s.mode = "codex"; });
      setSaved(`Saved: ${normalised}`);
    } catch (e) { setSaved(e instanceof Error ? e.message : String(e)); }
  };
  const checkProxy = async () => {
    setChecking(true); setHealth(null);
    try {
      const url = normaliseProxyURL(proxyURL);
      const response = await fetch(url.replace(/\/v1$/, "") + "/healthz", { signal: AbortSignal.timeout(8000) });
      const data = (await response.json()) as { ok?: boolean; codex?: { account?: { type?: string; planType?: string } } };
      if (!data.ok) throw new Error("The proxy answered but is not ready.");
      const account = data.codex?.account;
      setHealth(account?.type === "chatgpt" ? `Connected. Codex is logged in with ChatGPT${account.planType ? ` (${account.planType})` : ""}.` : "Connected, but Codex is not logged in with ChatGPT on that Mac.");
    } catch (e) { setHealth(e instanceof Error ? `Could not reach the proxy: ${e.message}` : "Could not reach the proxy."); }
    setChecking(false);
  };

  return (
    <Section header="How Mural connects" footer={settings.mode === "codex"
      ? "Your Mac runs codex-proxy and lends its Codex subscription to this app. Voice audio still goes straight to OpenAI; the token stays in this app and is sent only to your proxy."
      : "Your OpenAI account pays for usage. The key stays in this app’s storage and is sent only to OpenAI."}>
      <div className="form-row form-row--column">
        <div className="mode-picker" role="radiogroup" aria-label="Connection mode">
          <button role="radio" aria-pressed={settings.mode === "openai"} aria-checked={settings.mode === "openai"} disabled={running} onClick={() => coordinator.updateConnection((s) => { s.mode = "openai"; })}>OpenAI API key</button>
          <button role="radio" aria-pressed={settings.mode === "codex"} aria-checked={settings.mode === "codex"} disabled={running} onClick={() => coordinator.updateConnection((s) => { s.mode = "codex"; })}>Codex on my Mac</button>
        </div>
      </div>
      {settings.mode === "openai" ? (
        <>
          {settings.openaiKey ? <Row label={<span className="row"><Icon name="checkmark.shield" />Your key is saved in this app</span>} /> : null}
          <div className="form-row form-row--column">
            <input className="field" type="password" autoComplete="off" spellCheck={false} placeholder={settings.openaiKey ? "Replace OpenAI key" : "OpenAI API key"} value={key} onChange={(e) => setKey(e.target.value)} />
            <div className="row">
              <button className="button-inline" disabled={!key || running} onClick={saveKey}>{settings.openaiKey ? "Save replacement key" : "Save key"}</button>
              <span className="grow" />
              {settings.openaiKey ? <button className="button-inline button-inline--danger" disabled={running} onClick={() => { coordinator.updateConnection((s) => { s.openaiKey = ""; }); setMessage("Your key has been removed."); }}>Remove key</button> : null}
            </div>
          </div>
          <Row label={<ExternalLink href="https://platform.openai.com/api-keys" className="link">Open OpenAI API keys</ExternalLink>} />
        </>
      ) : (
        <>
          <div className="form-row form-row--column">
            <span className="caption">Proxy base URL (from the proxy’s startup message)</span>
            <input className="field" autoComplete="off" spellCheck={false} placeholder="http://100.x.y.z:8790/v1" value={proxyURL} disabled={running} onChange={(e) => applyProxy(e.target.value, proxyToken)} />
            <span className="caption">Proxy token</span>
            <input className="field" type="password" autoComplete="off" spellCheck={false} placeholder="Token" value={proxyToken} disabled={running} onChange={(e) => applyProxy(proxyURL, e.target.value)} />
            <div className="row">
              <span className="caption grow">{saved ?? "Enter the URL and the token; they save automatically."}</span>
              <button className="button-inline" disabled={checking || !proxyURL.trim()} onClick={() => void checkProxy()}>{checking ? "Checking…" : "Check connection"}</button>
            </div>
            {health ? <span className="caption">{health}</span> : null}
          </div>
          <Row label={<span className="footnote">Start it on your Mac with <code>npm start</code> in <code>services/codex-proxy</code>. Over Tailscale, set <code>CODEX_PROXY_HOST=tailscale</code>.</span>} />
        </>
      )}
    </Section>
  );
}

function Section({ header, footer, children }: { header: string; footer?: string; children: React.ReactNode }) {
  return (
    <section className="form-section">
      <div className="form-section__header">{header}</div>
      <div className="form-group">{children}</div>
      {footer ? <p className="form-section__footer">{footer}</p> : null}
    </section>
  );
}

function Row({ label, children }: { label: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="form-row">
      <div className="form-row__label">{label}</div>
      {children}
    </div>
  );
}
