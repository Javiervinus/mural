import { useState } from "react";
import type { ConversationCoordinator } from "../app/coordinator";
import { wordExplanation, wordLabel, type WordState } from "../core/learning";
import type { SessionRecord } from "../core/models";
import type { LearningStore } from "../services/storage";
import { Alert, formatDate, PageHeading, PinyinHelp, RecallBars, Sheet } from "./components";
import { Icon } from "./icons";
import { TranscriptBody } from "./TalkView";

export function WordsView({ coordinator }: { coordinator: ConversationCoordinator }) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<WordState | null>(null);
  const [history, setHistory] = useState(false);
  const learner = coordinator.learner;
  const language = coordinator.language;
  const query = search.trim().toLowerCase();
  const words = learner.words.filter((w) => !query || w.lemma.toLowerCase().includes(query) || w.meaning.toLowerCase().includes(query));

  return (
    <div className="stack">
      <label className="search" style={{ marginBottom: 0 }}>
        <Icon name="magnifyingglass" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a word" aria-label="Find a word" />
      </label>
      <PageHeading eyebrow={`Little by little · ${language.name}`} title="Your words." subtitle="Familiar words, ready for another conversation." />
      {words.length === 0 ? (
        <div className="card card--sage stack" style={{ gap: 18 }}>
          <Icon name="leaf" size={34} strokeWidth={1.3} />
          <h2 className="title2" style={{ fontWeight: 500 }}>{query ? "No matching words yet." : "They’ll grow from here."}</h2>
          <p className="subtitle">{query ? `Try another ${language.name} word or English meaning.` : "As we talk, useful words and phrases find a home here. Their strength grows when you recall them over time."}</p>
        </div>
      ) : (
        <div>
          {words.map((word) => (
            <button key={word.id} className="word-row" onClick={() => setSelected(word)}>
              <div>
                <p className="word-row__lemma">{word.lemma}</p>
                <p className="word-row__meaning">{word.meaning}</p>
              </div>
              <div className="word-row__right">
                <RecallBars count={word.bars} />
                <span className="caption2">{wordLabel(word)}</span>
              </div>
            </button>
          ))}
        </div>
      )}
      <div className="legend"><span>1 · Fragile</span><span>2 · Growing</span><span>3 · Steady</span></div>
      <p className="footnote" style={{ marginTop: -12 }}>The bars estimate spoken recall, not permanent mastery. Using a word with visible meanings counts as supported practice.</p>
      {learner.capabilities.length ? (
        <div className="card card--butter stack stack--tight">
          <h3 className="title3">Finding your voice</h3>
          {learner.capabilities.map((c) => <p key={c} className="subtitle" style={{ color: "var(--ink)" }}>{c}</p>)}
          <p className="footnote">Observed across conversations. These are provisional, not formal level certificates.</p>
        </div>
      ) : null}
      <button className="button-text" style={{ fontSize: 15, padding: "8px 0" }} onClick={() => setHistory(true)}><Icon name="clock.arrow.circlepath" />Past conversations</button>

      <WordDetailSheet word={selected} store={coordinator.store} onClose={() => setSelected(null)} />
      <SessionHistorySheet open={history} store={coordinator.store} meaningLanguage={coordinator.store.preferences.meaningLanguage} onClose={() => setHistory(false)} />
    </div>
  );
}

function WordDetailSheet({ word, store, onClose }: { word: WordState | null; store: LearningStore; onClose: () => void }) {
  return (
    <Sheet open={word !== null} onClose={onClose} trailing={<button className="sheet__action" onClick={onClose}>Done</button>}>
      {word ? (
        <div className="stack">
          <h2 className="heading" style={{ margin: 0, fontSize: 36, fontWeight: 500 }}>{word.lemma}</h2>
          {store.language.id === "zh" ? <PinyinHelp text={word.lemma} align="left" /> : null}
          <p className="title3 muted" style={{ fontWeight: 400 }}>{word.meaning}</p>
          <div className="row"><RecallBars count={word.bars} /><span style={{ fontSize: 15 }}>{wordLabel(word)}</span></div>
          <p className="body" style={{ margin: 0 }}>{wordExplanation(word)}</p>
          <div className="card card--peach title3" style={{ fontWeight: 400 }}>“{word.example}”</div>
          <p className="footnote">{word.independentCount} independent uses · Last seen {formatDate(word.lastSeen)}</p>
          <button className="button-text" style={{ color: "#b8432c", fontSize: 13 }} onClick={() => { store.hideWord(word.id); onClose(); }}>Remove from my words</button>
        </div>
      ) : null}
    </Sheet>
  );
}

function SessionHistorySheet({ open, store, meaningLanguage, onClose }: { open: boolean; store: LearningStore; meaningLanguage: string; onClose: () => void }) {
  const [selectedID, setSelectedID] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SessionRecord | null>(null);
  const sessions = store.learningSessions;
  return (
    <Sheet open={open} size="large" title="Past conversations" onClose={onClose} trailing={<button className="sheet__action" onClick={onClose}>Done</button>}>
      {!sessions.length ? <p className="muted">Your {store.language.name} conversations will appear here.</p> : null}
      {sessions.map((session) => (
        <div key={session.id} className="list-row">
          <button style={{ textAlign: "left", flex: 1 }} onClick={() => setSelectedID(session.id)}>
            <div className="headline">{session.title}</div>
            <div className="caption">{formatDate(session.startedAt, true)}</div>
          </button>
          <button className="glass" style={{ width: 40, height: 40, color: "#b8432c" }} aria-label="Delete conversation" disabled={!session.endedAt} onClick={() => setDeleting(session)}><Icon name="trash" size={18} /></button>
        </div>
      ))}
      <EditableTranscriptSheet sessionID={selectedID} store={store} meaningLanguage={meaningLanguage} onClose={() => setSelectedID(null)} />
      {deleting ? (
        <Alert title="Delete this conversation and its learning evidence?" actions={[
          { label: "Delete conversation", kind: "danger", onClick: () => { store.deleteSession(deleting.id); setDeleting(null); } },
          { label: "Cancel", onClick: () => setDeleting(null) },
        ]} />
      ) : null}
    </Sheet>
  );
}

function EditableTranscriptSheet({ sessionID, store, meaningLanguage, onClose }: { sessionID: string | null; store: LearningStore; meaningLanguage: string; onClose: () => void }) {
  const [editing, setEditing] = useState<{ passageID: string; text: string } | null>(null);
  const session = sessionID ? store.session(sessionID) : undefined;
  return (
    <Sheet open={sessionID !== null} size="large" title="Our conversation" onClose={onClose} trailing={<button className="sheet__action" onClick={onClose}>Done</button>}>
      {session ? <TranscriptBody session={session} meaningLanguage={meaningLanguage} editable onEdit={(passageID, text) => setEditing({ passageID, text })} /> : <p className="muted">This conversation is no longer available.</p>}
      <Sheet open={editing !== null} title="What you said" onClose={() => setEditing(null)}
        leading={<button className="sheet__action" onClick={() => setEditing(null)}>Cancel</button>}
        trailing={<button className="sheet__action" onClick={() => { if (editing && sessionID) store.correctPassage(sessionID, editing.passageID, editing.text); setEditing(null); }}>Save</button>}>
        {editing ? (
          <div className="stack" style={{ gap: 16 }}>
            <textarea className="field" rows={5} value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
            <p className="footnote">Correct a misheard phrase. Learning evidence from the old wording will be removed; the original remains in your backup history.</p>
          </div>
        ) : null}
      </Sheet>
    </Sheet>
  );
}
