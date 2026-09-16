/**
 * Port of apps/ios/Core/Models.swift. Dates are JS Dates in memory; the archive codec in
 * archive.ts converts them to Swift reference-date seconds so backups stay interchangeable.
 */
import { defaultTitle, LanguageRegistry } from "./languages";

export type Speaker = "user" | "assistant";
export type EvidenceKind = "exposure" | "understanding" | "assisted" | "independent" | "lapse";
export type Outcome = "success" | "partial" | "breakdown" | "uncertain";

export const EVIDENCE_KINDS: readonly EvidenceKind[] = ["exposure", "understanding", "assisted", "independent", "lapse"];
export const OUTCOMES: readonly Outcome[] = ["success", "partial", "breakdown", "uncertain"];

/** Uppercase UUID, matching Swift's `UUID().uuidString`. */
export function uuid(): string {
  return crypto.randomUUID().toUpperCase();
}

export interface Fragment {
  id: string;
  revision: number;
  previousTexts: string[];
  speaker: Speaker;
  text: string;
  startMS: number;
  endMS: number;
  receivedAt: Date;
  meaningVisible: boolean;
  typed: boolean;
}

export function makeFragment(partial: Partial<Fragment> & Pick<Fragment, "speaker" | "text" | "startMS" | "endMS">): Fragment {
  return {
    id: partial.id ?? uuid(),
    revision: partial.revision ?? 0,
    previousTexts: partial.previousTexts ?? [],
    speaker: partial.speaker,
    text: partial.text,
    startMS: partial.startMS,
    endMS: partial.endMS,
    receivedAt: partial.receivedAt ?? new Date(),
    meaningVisible: partial.meaningVisible ?? false,
    typed: partial.typed ?? false,
  };
}

export interface Passage {
  id: string;
  speaker: Speaker;
  fragments: Fragment[];
}

export function passageText(passage: Passage): string {
  return passage.fragments.map((f) => f.text).join("");
}
export function passageRevisionKey(passage: Passage): string {
  return passage.fragments.map((f) => `${f.id}:${f.revision}`).join(",");
}
export function passageStartMS(passage: Passage): number {
  return passage.fragments[0]?.startMS ?? 0;
}
export function passageEndMS(passage: Passage): number {
  return passage.fragments.reduce((max, f) => Math.max(max, f.endMS), 0);
}

export const TRANSCRIPT_GAP_MS = 2200;

/** Presentation grouping only: neither the gap nor the arrival of another speaker proves a completed turn. */
export function passages(fragments: Fragment[]): Passage[] {
  const result: Passage[] = [];
  const indexed = fragments.map((fragment, offset) => ({ fragment, offset })).sort((a, b) =>
    a.fragment.startMS === b.fragment.startMS ? a.offset - b.offset : a.fragment.startMS - b.fragment.startMS,
  );
  for (const { fragment } of indexed) {
    let index = -1;
    for (let i = result.length - 1; i >= 0; i -= 1) {
      if (result[i]!.speaker === fragment.speaker) { index = i; break; }
    }
    const previous = index >= 0 ? result[index]! : null;
    if (previous && fragment.startMS - passageEndMS(previous) <= TRANSCRIPT_GAP_MS && !fragment.typed && !(previous.fragments[previous.fragments.length - 1]?.typed ?? false)) {
      previous.fragments.push(fragment);
    } else {
      result.push({ id: fragment.id, speaker: fragment.speaker, fragments: [fragment] });
    }
  }
  return result.sort((a, b) => passageStartMS(a) - passageStartMS(b));
}

export interface WordProposal {
  lemma: string;
  meaning: string;
  form: string;
  kind: EvidenceKind;
  confidence: number;
  sourceIDs: string[];
  quote: string;
  language: string;
}

export function wordKey(word: WordProposal): string {
  return word.language + "|" + word.lemma.trim().toLowerCase() + "|" + word.meaning.toLowerCase();
}

export interface Assessment {
  passageID: string;
  revisionKey: string;
  outcome: Outcome;
  suggestedLevel: number;
  nextGoal: string;
  capability: string;
  words: WordProposal[];
  createdAt: Date;
  context: string;
}

export interface SourceLink {
  title: string;
  url: string;
}

export function safeURL(source: SourceLink): URL | null {
  try {
    const url = new URL(source.url);
    if (url.protocol !== "https:" || !url.hostname || url.username) return null;
    return url;
  } catch {
    return null;
  }
}

export interface TopicBrief {
  id: string;
  languageID: string;
  query: string;
  text: string;
  sources: SourceLink[];
  retrievedAt: Date;
}

export function makeTopicBrief(languageID: string, query: string, text: string, sources: SourceLink[]): TopicBrief {
  return { id: uuid(), languageID, query, text, sources, retrievedAt: new Date() };
}

export function topicIsFresh(topic: TopicBrief, now = new Date()): boolean {
  return now.getTime() - topic.retrievedAt.getTime() < 6 * 3600 * 1000;
}

export interface SessionRecord {
  id: string;
  languageID: string;
  providerID: string | null;
  startedAt: Date;
  endedAt: Date | null;
  themeID: string | null;
  title: string;
  fragments: Fragment[];
  assessments: Assessment[];
  translations: Record<string, string>;
  topics: TopicBrief[];
  voiceSeconds: number;
  usageFinal: boolean;
  inputTokens: number;
  outputTokens: number;
  searchCalls: number;
  endReason: string | null;
}

export function makeSession(languageID: string = LanguageRegistry.defaultID, themeID: string | null = null, title: string | null = null): SessionRecord {
  return {
    id: uuid(),
    languageID,
    providerID: null,
    startedAt: new Date(),
    endedAt: null,
    themeID,
    title: title ?? (LanguageRegistry.module(languageID) ? defaultTitle(LanguageRegistry.module(languageID)!) : "A conversation"),
    fragments: [],
    assessments: [],
    translations: {},
    topics: [],
    voiceSeconds: 0,
    usageFinal: false,
    inputTokens: 0,
    outputTokens: 0,
    searchCalls: 0,
    endReason: null,
  };
}

export function sessionPassages(session: SessionRecord): Passage[] {
  return passages(session.fragments);
}

/** Appends a fragment unless its id is already present, then drops assessments whose passage changed. Mutates. */
export function appendFragment(session: SessionRecord, fragment: Fragment): void {
  if (session.fragments.some((f) => f.id === fragment.id)) return;
  session.fragments.push(fragment);
  invalidateChangedAssessments(session);
}

export function invalidateChangedAssessments(session: SessionRecord): void {
  const current = new Map(sessionPassages(session).map((p) => [p.id, passageRevisionKey(p)]));
  session.assessments = session.assessments.filter((a) => current.get(a.passageID) === a.revisionKey);
}

export function correctFragment(session: SessionRecord, id: string, text: string): void {
  const fragment = session.fragments.find((f) => f.id === id);
  if (!fragment) return;
  fragment.previousTexts.push(fragment.text);
  fragment.text = text;
  fragment.revision += 1;
  session.translations = {};
  invalidateChangedAssessments(session);
}

export interface Preferences {
  learningLanguageID: string;
  meaningVisible: boolean;
  meaningLanguage: string;
  sessionMinutes: number;
  hiddenWords: string[];
  interests: string;
  hasOnboarded: boolean;
  aiConsentVersion: number | null;
}

export function defaultPreferences(): Preferences {
  return {
    learningLanguageID: LanguageRegistry.defaultID,
    meaningVisible: true,
    meaningLanguage: "English",
    sessionMinutes: 15,
    hiddenWords: [],
    interests: "",
    hasOnboarded: false,
    aiConsentVersion: null,
  };
}

/** Deep copy so a late asynchronous result never mutates a session the UI already replaced. */
export function cloneSession(session: SessionRecord): SessionRecord {
  return {
    ...session,
    startedAt: new Date(session.startedAt),
    endedAt: session.endedAt ? new Date(session.endedAt) : null,
    fragments: session.fragments.map((f) => ({ ...f, previousTexts: [...f.previousTexts], receivedAt: new Date(f.receivedAt) })),
    assessments: session.assessments.map((a) => ({ ...a, createdAt: new Date(a.createdAt), words: a.words.map((w) => ({ ...w, sourceIDs: [...w.sourceIDs] })) })),
    translations: { ...session.translations },
    topics: session.topics.map((t) => ({ ...t, retrievedAt: new Date(t.retrievedAt), sources: t.sources.map((s) => ({ ...s })) })),
  };
}
