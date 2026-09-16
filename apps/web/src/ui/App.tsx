import { useState } from "react";
import { AI_CONSENT_SUMMARY, type ConversationCoordinator } from "../app/coordinator";
import { useCoordinator } from "../app/useCoordinator";
import { Alert, Brand, ExternalLink, Sheet } from "./components";
import { Icon } from "./icons";
import { OnboardingView } from "./OnboardingView";
import { SettingsView } from "./SettingsView";
import { LivePanel, TalkView } from "./TalkView";
import { ThemesView } from "./ThemesView";
import { WordsView } from "./WordsView";

type Tab = "talk" | "themes" | "words";

export function App({ coordinator }: { coordinator: ConversationCoordinator }) {
  useCoordinator(coordinator);
  const [tab, setTab] = useState<Tab>("talk");
  const store = coordinator.store;
  const onboarding = !store.preferences.hasOnboarded;
  const error = coordinator.error ?? store.error;

  const sections = [["talk", "Talk", "waveform"], ["themes", "Themes", "square.grid.2x2"], ["words", "Words", "book"]] as const;

  return (
    <div className={`shell${tab === "talk" ? " shell--aside" : ""}`}>
      <aside className="sidebar">
        <Brand />
        <nav role="tablist" aria-label="Sections">
          {sections.map(([id, label, icon]) => (
            <button key={id} role="tab" className="navbtn" aria-selected={tab === id} onClick={() => setTab(id)}>
              <Icon name={icon} strokeWidth={tab === id ? 2.2 : 1.8} />
              {label}
            </button>
          ))}
        </nav>
        <button className="navbtn sidebar__settings" onClick={() => coordinator.setShowSettings(true)}>
          <Icon name="slider.horizontal.3" />
          Settings
        </button>
      </aside>
      <div className="topbar">
        <Brand />
        <button className="glass" aria-label="Settings" onClick={() => coordinator.setShowSettings(true)}>
          <Icon name="slider.horizontal.3" size={22} />
        </button>
      </div>
      <main className="page">
        <div className="page-inner">
          {tab === "talk" ? <TalkView coordinator={coordinator} /> : null}
          {tab === "themes" ? <ThemesView coordinator={coordinator} onChoose={(theme) => { coordinator.chooseTheme(theme); setTab("talk"); }} /> : null}
          {tab === "words" ? <WordsView coordinator={coordinator} /> : null}
        </div>
      </main>
      {tab === "talk" ? <aside className="side-panel"><LivePanel coordinator={coordinator} /></aside> : null}
      <div className="tabbar-wrap">
        <nav className="tabbar" role="tablist" aria-label="Sections">
          {sections.map(([id, label, icon]) => (
            <button key={id} role="tab" className="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
              <Icon name={icon} strokeWidth={tab === id ? 2.2 : 1.8} />
              {label}
            </button>
          ))}
        </nav>
      </div>

      <Sheet open={coordinator.showSettings} size="large" title="Make yourself comfortable" onClose={() => coordinator.setShowSettings(false)}
        trailing={<button className="sheet__action" onClick={() => coordinator.setShowSettings(false)}>Done</button>}>
        <SettingsView coordinator={coordinator} />
      </Sheet>

      <Sheet open={coordinator.showAIConsent} size="large" onClose={() => coordinator.declineAIConsent()} dismissible={false}>
        <div className="stack" style={{ paddingTop: 12 }}>
          <Icon name="waveform.bubble" size={36} className="muted" />
          <h2 className="title2" style={{ fontSize: 28 }}>Before we talk.</h2>
          <p className="body" style={{ margin: 0 }}>{AI_CONSENT_SUMMARY}</p>
          <p className="footnote" style={{ margin: 0, fontSize: 15 }}>Your learning record is stored in this app. Mural does not save raw audio. You can keep browsing your saved words and conversations without agreeing.</p>
          <ExternalLink href="https://mural.chat/privacy/" className="link">Privacy policy</ExternalLink>
          <button className="button-primary" onClick={() => coordinator.acceptAIConsent()}>Agree and continue</button>
          <button className="button-text" style={{ alignSelf: "center", fontSize: 15 }} onClick={() => coordinator.declineAIConsent()}>Not now</button>
        </div>
      </Sheet>

      {onboarding ? <OnboardingView coordinator={coordinator} done={() => store.updatePreferences((p) => { p.hasOnboarded = true; })} /> : null}

      {error ? <Alert title="A little interruption" message={error} actions={[{ label: "OK", onClick: () => coordinator.clearError() }]} /> : null}
    </div>
  );
}
