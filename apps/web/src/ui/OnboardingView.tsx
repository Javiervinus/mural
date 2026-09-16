import { useEffect, useState } from "react";
import { AI_CONSENT_SUMMARY, AI_CONSENT_VERSION, type ConversationCoordinator } from "../app/coordinator";
import { loadMandarin, mandarinReading, mandarinReady } from "../core/captions";
import { defaultPreferences } from "../core/models";
import { LanguageRegistry, MeaningLanguages, settingsTitle } from "../core/languages";
import { Brand, ExternalLink } from "./components";
import { Icon } from "./icons";
import { Orb } from "./Orb";

export function OnboardingView({ coordinator, done }: { coordinator: ConversationCoordinator; done: () => void }) {
  const [step, setStep] = useState(0);
  const [targetID, setTargetID] = useState(coordinator.language.id);
  const [meaningLanguage, setMeaningLanguage] = useState(coordinator.store.preferences.meaningLanguage);
  const [hasChosenMeaning, setHasChosenMeaning] = useState(coordinator.store.preferences.meaningLanguage !== defaultPreferences().meaningLanguage);
  const [greetingIndex, setGreetingIndex] = useState(0);
  const [, setReady] = useState(mandarinReady());
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const target = LanguageRegistry.module(targetID) ?? LanguageRegistry.all[0]!;
  const greeting = reduceMotion ? target.greeting : LanguageRegistry.all[greetingIndex]!.greeting;

  useEffect(() => {
    if (reduceMotion) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") setGreetingIndex((i) => (i + 1) % LanguageRegistry.all.length); }, 3800);
    return () => clearInterval(timer);
  }, [reduceMotion]);
  useEffect(() => { if (target.id === "zh" && !mandarinReady()) void loadMandarin().then(() => setReady(true)); }, [target.id]);

  const advance = () => {
    if (step === 0) {
      if (!hasChosenMeaning && meaningLanguage === target.name) {
        const preferred = navigator.languages.map((tag) => {
          const code = tag.split("-")[0]!.toLowerCase();
          if (code === "zh") return "Chinese (Simplified)";
          const module = LanguageRegistry.module(code);
          if (module) return module.name;
          try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? ""; } catch { return ""; }
        });
        setMeaningLanguage(preferred.find((name) => MeaningLanguages.all.includes(name) && name !== target.name) ?? MeaningLanguages.all.find((name) => name !== target.name) ?? "English");
      }
      setStep(1);
    } else {
      coordinator.selectLanguage(targetID);
      coordinator.selectMeaningLanguage(meaningLanguage);
      coordinator.store.updatePreferences((p) => { p.meaningVisible = true; p.aiConsentVersion = AI_CONSENT_VERSION; });
      done();
    }
  };

  const consent = (
    <div className="stack stack--tight center" style={{ alignItems: "center" }}>
      <p className="footnote" style={{ margin: 0 }}>{AI_CONSENT_SUMMARY}</p>
      <ExternalLink href="https://mural.chat/privacy/" className="link footnote">Privacy policy</ExternalLink>
    </div>
  );

  return (
    <div className="onboarding">
      <div className="onboarding__bg" aria-hidden="true" />
      <div className="onboarding__top">
        {step === 1 ? <button className="glass" style={{ width: 44, height: 44 }} aria-label="Back to learning language" onClick={() => setStep(0)}><Icon name="chevron.left" size={20} /></button> : <Brand />}
        <div className="dots" aria-label={`Step ${step + 1} of 2`}>{[0, 1].map((i) => <span key={i} className={i === step ? "on" : ""} />)}</div>
      </div>
      <div className="onboarding__scroll">
        <div className="stack" style={{ gap: step === 0 ? 22 : 18, alignItems: "stretch" }}>
          <div className="stack" style={{ gap: 4, alignItems: "center" }}>
            <Orb size={step === 0 ? 134 : 74} />
            <h1 key={greeting} className={`onboarding__greeting fade-in${step === 1 ? " onboarding__greeting--small" : ""}`}>{greeting}</h1>
          </div>
          {step === 0 ? (
            <div className="stack" style={{ gap: 18 }}>
              <h2 className="title2 center" style={{ whiteSpace: "pre-line" }}>{"What would you\nlike to speak?"}</h2>
              <div className="stack" style={{ gap: 10 }}>
                {LanguageRegistry.all.map((language) => (
                  <button key={language.id} className="language-option" aria-pressed={targetID === language.id} onClick={() => setTargetID(language.id)}>
                    <div>
                      <div className="headline">{language.nativeName}</div>
                      <div className="caption">{settingsTitle(language)}</div>
                    </div>
                    <Icon name={targetID === language.id ? "checkmark.circle.fill" : "circle"} />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="stack" style={{ gap: 22 }}>
              <div className="stack stack--tight center">
                <h2 className="title2" style={{ whiteSpace: "pre-line" }}>{"A little help,\nin your language."}</h2>
                <p className="subtitle">Mural speaks {target.name}. Choose the language you read most easily for meanings.</p>
              </div>
              <select className="select" value={meaningLanguage} onChange={(e) => { setMeaningLanguage(e.target.value); setHasChosenMeaning(true); }} aria-label="Subtitle language">
                {MeaningLanguages.all.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <div className="stack center" style={{ gap: 8, padding: "12px 0" }}>
                <div className="title2" style={{ fontWeight: 500 }}>{target.greeting}</div>
                {target.id === "zh" && mandarinReading(target.greeting) ? <div className="muted">{mandarinReading(target.greeting)}</div> : null}
                <div className="body muted">{MeaningLanguages.greeting(meaningLanguage)}</div>
                <div className="caption" style={{ paddingTop: 8 }}>Turn meanings on whenever you need a hand.</div>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="onboarding__bottom stack" style={{ gap: 12 }}>
        {step === 1 ? consent : null}
        <button className="button-primary" onClick={advance}>{step === 0 ? "Continue" : "Agree and continue"}</button>
        <p className="caption center" style={{ margin: 0 }}>{step === 0 ? "We’ll find your pace through conversation." : "You can change both languages in Settings."}</p>
      </div>
    </div>
  );
}
