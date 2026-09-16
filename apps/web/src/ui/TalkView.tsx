import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationCoordinator } from "../app/coordinator";
import { loadMandarin } from "../core/captions";
import { talkTitle } from "../core/languages";
import { MeaningLanguages } from "../core/languages";
import { meaningCacheKey } from "../core/meaning";
import { passageRevisionKey, passageText, sessionPassages, type SessionRecord } from "../core/models";
import { Markdown, PinyinHelp, Sheet, Sources } from "./components";
import { Icon } from "./icons";
import { Orb } from "./Orb";

export function TalkView({ coordinator }: { coordinator: ConversationCoordinator }) {
  const [typing, setTyping] = useState(false);
  const [transcript, setTranscript] = useState<SessionRecord | null>(null);
  const [lookup, setLookup] = useState<{ word: string; sentence: string } | null>(null);
  const levels = useCallback((listener: (i: number, o: number) => void) => coordinator.subscribeLevels(listener), [coordinator]);
  const language = coordinator.language;
  const preferences = coordinator.store.preferences;
  const assistant = coordinator.assistantPassage;
  const user = coordinator.userPassage;
  const state = coordinator.state;
  const running = coordinator.isRunning;
  const sources = coordinator.session?.topics.at(-1)?.sources ?? [];
  useEffect(() => { if (language.id === "zh") void loadMandarin(); }, [language.id]);

  const meaningText = assistant === null ? MeaningLanguages.greeting(preferences.meaningLanguage) : coordinator.meaning || (coordinator.translating ? "Finding the meaning…" : "");

  return (
    <div className="talk">
      <span className="pill">{coordinator.selectedTheme?.title ?? talkTitle(language)}</span>
      <Orb className="talk__orb" levels={levels} listening={state === "active" && !coordinator.isMuted} active={state !== "closing"} />
      <div className="talk__status" aria-live="polite">{coordinator.status}</div>

      <div className="talk__caption-area">
        <p className={`talk__caption${assistant ? " talk__caption--small" : ""}`}>
          {coordinator.captionSegments.map((segment, index) =>
            assistant && segment.lookup ? (
              <a key={index} href="#lookup" onClick={(event) => { event.preventDefault(); setLookup({ word: segment.lookup!, sentence: coordinator.caption }); }}>{segment.text}</a>
            ) : (
              <span key={index}>{segment.text}</span>
            ),
          )}
        </p>
        {language.id === "zh" ? <PinyinHelp text={coordinator.caption} /> : null}
        {preferences.meaningVisible ? (
          <>
            <p className="talk__meaning">{meaningText}</p>
            {coordinator.meaningError ? (
              <div className="center caption">
                <div>{coordinator.meaningError}</div>
                <button className="button-text" style={{ marginTop: 6 }} onClick={() => coordinator.retryMeaning()}>Try meaning again</button>
              </div>
            ) : null}
          </>
        ) : null}
        {user ? <div className="talk__you"><b>YOU</b><span>{passageText(user).slice(-160)}</span></div> : null}
        {coordinator.working ? <div className="working"><span className="spinner" />Checking that for you…</div> : null}
        {sources.length ? <button className="button-text" onClick={() => setTranscript(coordinator.session)}><Icon name="link" />Sources</button> : null}
      </div>

      <div className="talk__controls">
        <button className="talk__control" onClick={() => coordinator.toggleMeaning()} aria-pressed={preferences.meaningVisible} aria-label={preferences.meaningVisible ? "Hide meaning subtitles" : "Show meaning subtitles"}>
          <span className={`glass${preferences.meaningVisible ? " glass--tint" : ""}`}><Icon name={preferences.meaningVisible ? "captions.bubble.fill" : "captions.bubble"} /></span>
          Meaning
        </button>
        <button
          className="talk__mic"
          disabled={state === "connecting" || state === "closing"}
          aria-label={state === "active" ? (coordinator.isMuted ? "Unmute microphone" : "Mute microphone") : "Start conversation"}
          onClick={() => { if (state === "active") coordinator.toggleMute(); else if (!running) coordinator.start(); }}
        >
          {state === "connecting" || state === "closing" ? <span className="spinner" /> : <Icon name={coordinator.isMuted && state === "active" ? "mic.slash" : "mic"} strokeWidth={1.5} />}
        </button>
        <button className="talk__control" disabled={!coordinator.session} onClick={() => { if (running) coordinator.end(); else setTranscript(coordinator.session); }} aria-label={running ? "End conversation" : "Conversation transcript"}>
          <span className="glass"><Icon name={running ? "phone.down" : "text.bubble"} /></span>
          {running ? "End" : "Transcript"}
        </button>
      </div>
      <div className="talk__mic-label">{coordinator.microphoneLabel}</div>
      <div className="talk__actions">
        {state === "active" ? (
          <>
            <button className="button-text" onClick={() => setTyping(true)}><Icon name="keyboard" />Type instead</button>
            <button className="button-text" onClick={() => coordinator.help()}><Icon name="sparkles" />A little help</button>
          </>
        ) : coordinator.session === null ? (
          <span className="caption">Reply in whichever language comes to you.</span>
        ) : !running ? (
          <button className="button-text" onClick={() => coordinator.resetConversation()}><Icon name="arrow.counterclockwise" />New conversation</button>
        ) : null}
      </div>
      {coordinator.notice ? <p className="talk__notice">{coordinator.notice}</p> : null}

      <TypedReplySheet open={typing} coordinator={coordinator} onClose={() => setTyping(false)} />
      <LookupSheet item={lookup} coordinator={coordinator} onClose={() => setLookup(null)} />
      <TranscriptSheet session={transcript} meaningLanguage={preferences.meaningLanguage} onClose={() => setTranscript(null)} />
    </div>
  );
}

function TypedReplySheet({ open, coordinator, onClose }: { open: boolean; coordinator: ConversationCoordinator; onClose: () => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const send = async () => {
    setSending(true);
    await coordinator.sendTyped(text);
    setSending(false);
    setText("");
    onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} leading={<button className="sheet__action" onClick={onClose}>Close</button>}>
      <div className="stack" style={{ paddingTop: 8 }}>
        <h2 className="title2" style={{ fontSize: 28 }}>Say it your way.</h2>
        <textarea className="field" autoFocus placeholder={`Reply in ${coordinator.language.name} or another language`} value={text} onChange={(e) => setText(e.target.value)} rows={4}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) void send(); }} />
        <button className="button-primary" disabled={sending || !text.trim()} onClick={() => void send()}>
          <span className="grow" style={{ textAlign: "left" }}>{sending ? "Sending…" : "Send reply"}</span><Icon name="arrow.up" size={20} />
        </button>
      </div>
    </Sheet>
  );
}

function LookupSheet({ item, coordinator, onClose }: { item: { word: string; sentence: string } | null; coordinator: ConversationCoordinator; onClose: () => void }) {
  const [explanation, setExplanation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setExplanation(null); setError(null);
    if (!item) return;
    let cancelled = false;
    coordinator.lookup(item.word, item.sentence).then((text) => { if (!cancelled) setExplanation(text); }, (e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [item, coordinator]);
  return (
    <Sheet open={item !== null} title="A little meaning" onClose={onClose} trailing={<button className="sheet__action" onClick={onClose}>Done</button>}>
      {item ? (
        <div className="stack" style={{ gap: 20 }}>
          <h2 className="heading" style={{ margin: 0, fontSize: 36 }}>{item.word}</h2>
          {coordinator.language.id === "zh" ? <PinyinHelp text={item.word} align="left" /> : null}
          <p className="title3 muted" style={{ fontWeight: 400 }}>{item.sentence}</p>
          {explanation ? <p className="body" style={{ margin: 0 }}>{explanation}</p> : error ? <p className="muted">{error}</p> : <div className="working"><span className="spinner" />Finding the meaning…</div>}
        </div>
      ) : null}
    </Sheet>
  );
}

export function TranscriptSheet({ session, meaningLanguage, onClose }: { session: SessionRecord | null; meaningLanguage: string; onClose: () => void }) {
  return (
    <Sheet open={session !== null} size="large" title="Our conversation" onClose={onClose} trailing={<button className="sheet__action" onClick={onClose}>Done</button>}>
      {session ? <TranscriptBody session={session} meaningLanguage={meaningLanguage} /> : null}
    </Sheet>
  );
}

export function TranscriptBody({ session, meaningLanguage, editable, onEdit, compact }: { session: SessionRecord; meaningLanguage: string; editable?: boolean; onEdit?: (passageID: string, text: string) => void; compact?: boolean }) {
  const passages = sessionPassages(session);
  return (
    <div className={`stack${compact ? " transcript--compact" : ""}`}>
      {passages.map((passage) => {
        const text = passageText(passage);
        const translation = session.translations[meaningCacheKey(passageRevisionKey(passage), meaningLanguage)] ?? session.translations[passageRevisionKey(passage)];
        return (
          <div key={passage.id} className="stack--tight stack">
            <div className="row">
              <span className="caption" style={{ letterSpacing: 1 }}>{passage.speaker === "assistant" ? "MURAL" : "YOU"}</span>
              {editable && passage.speaker === "user" && session.endedAt ? <button className="button-text" style={{ marginLeft: "auto" }} onClick={() => onEdit?.(passage.id, text)}>Edit</button> : null}
            </div>
            <p className="title3" style={{ fontWeight: 400, userSelect: "text" }}>{text}</p>
            {session.languageID === "zh" ? <PinyinHelp text={text} align="left" /> : null}
            {translation ? <p className="subtitle">{translation}</p> : null}
          </div>
        );
      })}
      {session.topics.map((topic) => (
        <div key={topic.id} className="stack stack--tight">
          <Markdown text={topic.text} className="body" />
          <Sources sources={topic.sources} date={topic.retrievedAt} />
        </div>
      ))}
      {!session.fragments.length && !session.topics.length ? <p className="muted">Your conversation will appear here.</p> : null}
    </div>
  );
}

/** Desktop-only companion column: the conversation so far, following the live transcript. */
export function LivePanel({ coordinator }: { coordinator: ConversationCoordinator }) {
  const session = coordinator.session;
  const scroller = useRef<HTMLDivElement>(null);
  const count = session?.fragments.length ?? 0;
  useEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }, [count]);
  return (
    <>
      <div className="side-panel__header">
        <div className="eyebrow">Our conversation</div>
        <div className="caption">{session ? `${sessionPassages(session).length} passages · ${Math.round(session.voiceSeconds)} s` : "Nothing yet"}</div>
      </div>
      <div className="side-panel__body" ref={scroller}>
        {session ? <TranscriptBody session={session} meaningLanguage={coordinator.store.preferences.meaningLanguage} compact /> : <p className="muted">Start a conversation and your words will appear here.</p>}
      </div>
    </>
  );
}
