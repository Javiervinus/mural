import { useState } from "react";
import type { ConversationCoordinator } from "../app/coordinator";
import type { TopicBrief } from "../core/models";
import type { ConversationTheme } from "../core/themes";
import { Markdown, PageHeading, Sheet, Sources } from "./components";
import { Icon } from "./icons";

export function ThemesView({ coordinator, onChoose }: { coordinator: ConversationCoordinator; onChoose: (theme: ConversationTheme | null) => void }) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [current, setCurrent] = useState(false);
  const all = coordinator.themes;
  const categories = all.reduce<string[]>((list, t) => (list.includes(t.category) ? list : [...list, t.category]), ["All"]);
  const query = search.trim().toLowerCase();
  const themes = all.filter((t) => (category === "All" || t.category === category) && (!query || t.title.toLowerCase().includes(query) || t.category.toLowerCase().includes(query)));

  return (
    <div className="stack">
      <label className="search" style={{ marginBottom: 0 }}>
        <Icon name="magnifyingglass" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a conversation" aria-label="Find a conversation" />
      </label>
      <PageHeading eyebrow="A place to begin" title={"What’s on\nyour mind?"} subtitle="Same friend. Somewhere new." />
      <button className="card row" style={{ fontWeight: 600, fontSize: 17 }} onClick={() => onChoose(null)}>
        <Icon name="waveform" size={22} />
        <span className="grow" style={{ textAlign: "left" }}>Just talk</span>
        <Icon name="arrow.up.right" size={22} />
      </button>
      <div className="chips" role="group" aria-label="Categories">
        {categories.map((c) => <button key={c} className="chip" aria-pressed={category === c} onClick={() => setCategory(c)}>{c}</button>)}
      </div>
      <div className="theme-grid">
        {themes.map((theme) => (
          <button key={theme.id} className={`theme-card panel-${theme.colorIndex}`} onClick={() => { if (theme.id === "today") setCurrent(true); else onChoose(theme); }}>
            <Icon name={theme.symbol} strokeWidth={1.4} />
            <div>
              <p className="theme-card__title">{theme.title}</p>
              <p className="theme-card__subtitle">{theme.subtitle}</p>
            </div>
          </button>
        ))}
      </div>
      {!themes.length ? <p className="muted center">No conversations match “{search}”.</p> : null}
      <CurrentTopicSheet open={current} coordinator={coordinator} onClose={() => setCurrent(false)} onSelected={() => { onChoose(coordinator.selectedTheme); }} />
    </div>
  );
}

function CurrentTopicSheet({ open, coordinator, onClose, onSelected }: { open: boolean; coordinator: ConversationCoordinator; onClose: () => void; onSelected: () => void }) {
  const [query, setQuery] = useState("");
  const [brief, setBrief] = useState<TopicBrief | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const find = async () => {
    setLoading(true); setError(null);
    try { setBrief(await coordinator.currentTopic(query.trim())); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setLoading(false);
  };
  return (
    <Sheet open={open} size="large" onClose={onClose} leading={<button className="sheet__action" onClick={onClose}>Close</button>}>
      <div className="stack" style={{ gap: 22 }}>
        <PageHeading eyebrow="The world today" title="A fresh conversation." subtitle="What would you like to talk about?" />
        <textarea className="field" rows={2} placeholder={coordinator.language.topicPlaceholder} value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="button-row" disabled={loading || !query.trim()} onClick={() => void find()}>
          <span>{loading ? "Finding something interesting…" : "Find a topic"}</span>
          {loading ? <span className="spinner" /> : <Icon name="sparkle.magnifyingglass" size={20} />}
        </button>
        {error ? <p className="footnote">{error}</p> : null}
        {brief ? (
          <>
            <Markdown text={brief.text} className="body" />
            <Sources sources={brief.sources} date={brief.retrievedAt} />
            <button className="button-primary" onClick={() => { coordinator.discuss(brief); onSelected(); onClose(); }}><Icon name="waveform" size={20} />Talk about this</button>
          </>
        ) : null}
        <p className="footnote">Search uses your OpenAI account or your Codex quota. Sources stay attached to the topic.</p>
      </div>
    </Sheet>
  );
}
