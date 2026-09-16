/**
 * Learning archive codec, compatible with the iPhone and Android backups (schemaVersion 2).
 * Dates are encoded as seconds since 1 January 2001 (Swift's reference date), keys are sorted,
 * and nil optionals are omitted, so a file exported here re-imports on the phone.
 */
import { LanguageRegistry } from "./languages";
import { LearningEngine } from "./learning";
import {
  defaultPreferences, EVIDENCE_KINDS, invalidateChangedAssessments, OUTCOMES,
  type Assessment, type EvidenceKind, type Fragment, type Outcome, type Preferences, type SessionRecord, type SourceLink, type TopicBrief, type WordProposal,
} from "./models";

export const REFERENCE_DATE_OFFSET_SECONDS = 978_307_200; // 2001-01-01T00:00:00Z in Unix seconds
export const MAXIMUM_ENCODED_BYTES = 30_000_000;
const MAXIMUM_SESSIONS = 10_000;

export class ArchiveError extends Error {
  kind: "tooLarge" | "unsupportedVersion" | "unsupportedLanguage" | "invalid";
  constructor(kind: ArchiveError["kind"]) {
    super({
      tooLarge: "This backup is too large to import.",
      unsupportedVersion: "This backup needs a newer version of Mural.",
      unsupportedLanguage: "This backup contains a language module that this version of Mural does not support.",
      invalid: "This backup has invalid or duplicate records.",
    }[kind]);
    this.kind = kind;
  }
}

export interface Archive {
  schemaVersion: number;
  sessions: SessionRecord[];
  preferences: Preferences;
}

export function emptyArchive(): Archive {
  return { schemaVersion: 2, sessions: [], preferences: defaultPreferences() };
}

type Json = Record<string, unknown>;

// ---- decoding --------------------------------------------------------------------------

function dateFromReference(value: unknown): Date {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ArchiveError("invalid");
  return new Date((value + REFERENCE_DATE_OFFSET_SECONDS) * 1000);
}
function str(value: unknown): string {
  if (typeof value !== "string") throw new ArchiveError("invalid");
  return value;
}
function optStr(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return str(value);
}
function num(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ArchiveError("invalid");
  return value;
}
function int(value: unknown): number {
  const n = num(value);
  if (!Number.isInteger(n)) throw new ArchiveError("invalid");
  return n;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw new ArchiveError("invalid");
  return value;
}
function obj(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ArchiveError("invalid");
  return value as Json;
}
function arr(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new ArchiveError("invalid");
  return value;
}
function oneOf<T extends string>(value: unknown, choices: readonly T[]): T {
  const text = str(value);
  if (!(choices as readonly string[]).includes(text)) throw new ArchiveError("invalid");
  return text as T;
}

function decodeFragment(raw: unknown): Fragment {
  const o = obj(raw);
  return {
    id: str(o.id),
    revision: o.revision === undefined ? 0 : int(o.revision),
    previousTexts: o.previousTexts === undefined ? [] : arr(o.previousTexts).map(str),
    speaker: oneOf(o.speaker, ["user", "assistant"] as const),
    text: str(o.text),
    startMS: int(o.startMS),
    endMS: int(o.endMS),
    receivedAt: dateFromReference(o.receivedAt),
    meaningVisible: bool(o.meaningVisible),
    typed: bool(o.typed),
  };
}
function decodeWord(raw: unknown): WordProposal {
  const o = obj(raw);
  return {
    lemma: str(o.lemma), meaning: str(o.meaning), form: str(o.form),
    kind: oneOf(o.kind, EVIDENCE_KINDS) as EvidenceKind,
    confidence: num(o.confidence), sourceIDs: arr(o.sourceIDs).map(str), quote: str(o.quote),
    language: o.language === undefined ? LanguageRegistry.defaultID : str(o.language),
  };
}
function decodeAssessment(raw: unknown): Assessment {
  const o = obj(raw);
  return {
    passageID: str(o.passageID), revisionKey: str(o.revisionKey),
    outcome: oneOf(o.outcome, OUTCOMES) as Outcome,
    suggestedLevel: int(o.suggestedLevel), nextGoal: str(o.nextGoal), capability: str(o.capability),
    words: arr(o.words).map(decodeWord), createdAt: dateFromReference(o.createdAt), context: str(o.context),
  };
}
function decodeSource(raw: unknown): SourceLink {
  const o = obj(raw);
  return { title: str(o.title), url: str(o.url) };
}
function decodeTopic(raw: unknown): TopicBrief {
  const o = obj(raw);
  return {
    id: str(o.id), languageID: str(o.languageID), query: str(o.query), text: str(o.text),
    sources: arr(o.sources).map(decodeSource), retrievedAt: dateFromReference(o.retrievedAt),
  };
}
function decodeSession(raw: unknown): SessionRecord {
  const o = obj(raw);
  const translations: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj(o.translations ?? {}))) translations[key] = str(value);
  return {
    id: str(o.id), languageID: str(o.languageID), providerID: optStr(o.providerID),
    startedAt: dateFromReference(o.startedAt), endedAt: o.endedAt === undefined || o.endedAt === null ? null : dateFromReference(o.endedAt),
    themeID: optStr(o.themeID), title: str(o.title),
    fragments: arr(o.fragments).map(decodeFragment), assessments: arr(o.assessments).map(decodeAssessment),
    translations, topics: arr(o.topics).map(decodeTopic),
    voiceSeconds: num(o.voiceSeconds), usageFinal: bool(o.usageFinal),
    inputTokens: int(o.inputTokens), outputTokens: int(o.outputTokens), searchCalls: int(o.searchCalls),
    endReason: optStr(o.endReason),
  };
}
function decodePreferences(raw: unknown): Preferences {
  const o = obj(raw);
  return {
    learningLanguageID: str(o.learningLanguageID), meaningVisible: bool(o.meaningVisible), meaningLanguage: str(o.meaningLanguage),
    sessionMinutes: int(o.sessionMinutes), hiddenWords: arr(o.hiddenWords).map(str), interests: str(o.interests),
    hasOnboarded: bool(o.hasOnboarded), aiConsentVersion: o.aiConsentVersion === undefined || o.aiConsentVersion === null ? null : int(o.aiConsentVersion),
  };
}

/** Version 1 was Norwegian-only; migration assigns that provenance once. */
function migrate(root: Json): Json {
  const version = root.schemaVersion;
  if (version !== 1 && version !== 2) throw new ArchiveError("unsupportedVersion");
  if (version === 2) return root;
  const preferences = { ...obj(root.preferences) };
  preferences.learningLanguageID = LanguageRegistry.defaultID;
  if (Array.isArray(preferences.hiddenWords)) preferences.hiddenWords = preferences.hiddenWords.map((w) => LanguageRegistry.defaultID + "|" + str(w));
  const sessions = arr(root.sessions).map((raw) => {
    const session: Json = { ...obj(raw), languageID: LanguageRegistry.defaultID };
    if (Array.isArray(session.topics)) session.topics = session.topics.map((t: unknown) => ({ ...obj(t), languageID: LanguageRegistry.defaultID }));
    return session;
  });
  return { ...root, preferences, sessions, schemaVersion: 2 };
}

function validDate(date: Date): boolean {
  return Number.isFinite(date.getTime());
}

export function validateArchive(archive: Archive): void {
  if (!LanguageRegistry.module(archive.preferences.learningLanguageID)) throw new ArchiveError("unsupportedLanguage");
  const ids = new Set(archive.sessions.map((s) => s.id));
  if (ids.size !== archive.sessions.length || archive.sessions.length > MAXIMUM_SESSIONS) throw new ArchiveError("invalid");
  if (archive.preferences.sessionMinutes < 1 || archive.preferences.sessionMinutes > 60) throw new ArchiveError("invalid");
  for (const s of archive.sessions) {
    if (!LanguageRegistry.module(s.languageID)) throw new ArchiveError("unsupportedLanguage");
    const inRange = (n: number, max: number) => Number.isFinite(n) && n >= 0 && n <= max;
    if (!inRange(s.voiceSeconds, 31_536_000) || ![s.inputTokens, s.outputTokens, s.searchCalls].every((n) => inRange(n, 1_000_000_000))) throw new ArchiveError("invalid");
    if (!validDate(s.startedAt) || (s.endedAt && !validDate(s.endedAt)) || !s.assessments.every((a) => validDate(a.createdAt))) throw new ArchiveError("invalid");
    const fragmentIDs = new Set(s.fragments.map((f) => f.id));
    if (fragmentIDs.size !== s.fragments.length) throw new ArchiveError("invalid");
    if (!s.fragments.every((f) => f.startMS >= 0 && f.endMS >= f.startMS && f.text.length <= 50_000 && f.revision >= 0 && f.revision <= 1_000_000 && validDate(f.receivedAt))) throw new ArchiveError("invalid");
    if (!s.topics.every((t) => t.languageID === s.languageID && validDate(t.retrievedAt))) throw new ArchiveError("invalid");
  }
}

export function decodeArchive(text: string): Archive {
  if (new TextEncoder().encode(text).length > MAXIMUM_ENCODED_BYTES) throw new ArchiveError("tooLarge");
  let root: Json;
  try {
    root = obj(JSON.parse(text));
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw new ArchiveError("invalid");
  }
  const migrated = migrate(root);
  const archive: Archive = {
    schemaVersion: 2,
    sessions: arr(migrated.sessions).map(decodeSession),
    preferences: decodePreferences(migrated.preferences),
  };
  validateArchive(archive);
  return archive;
}

// ---- encoding --------------------------------------------------------------------------

function referenceSeconds(date: Date): number {
  return date.getTime() / 1000 - REFERENCE_DATE_OFFSET_SECONDS;
}

function encodeSession(s: SessionRecord): Json {
  const out: Json = {
    id: s.id, languageID: s.languageID, startedAt: referenceSeconds(s.startedAt), title: s.title,
    fragments: s.fragments.map((f) => ({ id: f.id, revision: f.revision, previousTexts: f.previousTexts, speaker: f.speaker, text: f.text, startMS: f.startMS, endMS: f.endMS, receivedAt: referenceSeconds(f.receivedAt), meaningVisible: f.meaningVisible, typed: f.typed })),
    assessments: s.assessments.map((a) => ({ passageID: a.passageID, revisionKey: a.revisionKey, outcome: a.outcome, suggestedLevel: a.suggestedLevel, nextGoal: a.nextGoal, capability: a.capability, words: a.words.map((w) => ({ ...w })), createdAt: referenceSeconds(a.createdAt), context: a.context })),
    translations: { ...s.translations },
    topics: s.topics.map((t) => ({ id: t.id, languageID: t.languageID, query: t.query, text: t.text, sources: t.sources.map((l) => ({ title: l.title, url: l.url })), retrievedAt: referenceSeconds(t.retrievedAt) })),
    voiceSeconds: s.voiceSeconds, usageFinal: s.usageFinal, inputTokens: s.inputTokens, outputTokens: s.outputTokens, searchCalls: s.searchCalls,
  };
  if (s.providerID !== null) out.providerID = s.providerID;
  if (s.endedAt) out.endedAt = referenceSeconds(s.endedAt);
  if (s.themeID !== null) out.themeID = s.themeID;
  if (s.endReason !== null) out.endReason = s.endReason;
  return out;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const sorted: Json = {};
    for (const key of Object.keys(value as Json).sort()) sorted[key] = sortKeys((value as Json)[key]);
    return sorted;
  }
  return value;
}

export function encodeArchive(archive: Archive): string {
  const preferences: Json = {
    learningLanguageID: archive.preferences.learningLanguageID, meaningVisible: archive.preferences.meaningVisible, meaningLanguage: archive.preferences.meaningLanguage,
    sessionMinutes: archive.preferences.sessionMinutes, hiddenWords: archive.preferences.hiddenWords, interests: archive.preferences.interests, hasOnboarded: archive.preferences.hasOnboarded,
  };
  if (archive.preferences.aiConsentVersion !== null) preferences.aiConsentVersion = archive.preferences.aiConsentVersion;
  return JSON.stringify(sortKeys({ schemaVersion: 2, sessions: archive.sessions.map(encodeSession), preferences }), null, 2);
}

/** Reject the complete candidate before changing local history, so it remains readable on relaunch. */
export function mergeArchive(current: Archive, incoming: Archive): Archive {
  validateArchive(incoming);
  const known = new Set(current.sessions.map((s) => s.id));
  const additions = incoming.sessions.filter((s) => !known.has(s.id));
  if (additions.length > MAXIMUM_SESSIONS - current.sessions.length) throw new ArchiveError("tooLarge");
  const candidate: Archive = { ...current, sessions: [...current.sessions] };
  for (const session of additions) {
    invalidateChangedAssessments(session);
    session.assessments = session.assessments.flatMap((a) => { const v = LearningEngine.validate(a, session); return v ? [v] : []; });
    candidate.sessions.push(session);
  }
  validateArchive(candidate);
  if (new TextEncoder().encode(encodeArchive(candidate)).length > MAXIMUM_ENCODED_BYTES) throw new ArchiveError("tooLarge");
  return candidate;
}
