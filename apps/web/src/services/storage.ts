/**
 * Port of apps/ios/App/Storage.swift.
 *
 * The learning archive lives in IndexedDB as one JSON document (the phone keeps one SwiftData
 * record with the same payload). Connection settings live in localStorage; they are never part
 * of a backup.
 */
import { decodeArchive, emptyArchive, encodeArchive, mergeArchive, type Archive } from "../core/archive";
import { LearningEngine, type LearnerState } from "../core/learning";
import { LanguageRegistry, type LanguageModule } from "../core/languages";
import { cloneSession, correctFragment, sessionPassages, type Preferences, type SessionRecord } from "../core/models";
import { DEFAULT_LIVE_MODEL, DEFAULT_TEXT_MODEL, DEFAULT_VOICE, OPENAI_BASE_URL, type Connection } from "./api";

const DB_NAME = "mural";
const STORE = "documents";
const KEY = "mural-v1";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB unavailable"));
  });
}

async function readDocument(): Promise<string | null> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
      request.onsuccess = () => resolve(typeof request.result === "string" ? request.result : null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function writeDocument(payload: string): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put(payload, KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export type Listener = () => void;

export class LearningStore {
  private archive: Archive = emptyArchive();
  error: string | null = null;
  onSessionInvalidation: ((id: string) => void) | null = null;
  private listeners = new Set<Listener>();
  private persisting: Promise<void> = Promise.resolve();
  private version = 0;

  static async open(): Promise<LearningStore> {
    const store = new LearningStore();
    try {
      const payload = await readDocument();
      if (payload) store.archive = decodeArchive(payload);
    } catch (error) {
      store.error = "Mural couldn’t open its learning record. Your existing data has not been replaced.";
      console.error(error);
    }
    let touched = false;
    for (const session of store.archive.sessions) {
      if (!session.endedAt) { session.endedAt = new Date(); session.endReason = "App closed before finalization"; touched = true; }
    }
    if (touched) store.persist();
    return store;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private notify() {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
  get revision(): number {
    return this.version;
  }

  get preferences(): Preferences {
    return this.archive.preferences;
  }
  get language(): LanguageModule {
    return LanguageRegistry.module(this.archive.preferences.learningLanguageID) ?? LanguageRegistry.all[0]!;
  }
  get sessions(): SessionRecord[] {
    return [...this.archive.sessions].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  }
  get learningSessions(): SessionRecord[] {
    return this.sessions.filter((s) => s.languageID === this.language.id);
  }
  get learner(): LearnerState {
    return LearningEngine.project(this.archive.sessions, this.language.id, this.archive.preferences.hiddenWords);
  }
  session(id: string): SessionRecord | undefined {
    return this.archive.sessions.find((s) => s.id === id);
  }

  selectLanguage(id: string): void {
    if (!LanguageRegistry.module(id)) return;
    this.archive.preferences.learningLanguageID = id;
    this.persist();
  }
  updatePreferences(change: (preferences: Preferences) => void): void {
    change(this.archive.preferences);
    this.persist();
  }
  save(session: SessionRecord): void {
    const copy = cloneSession(session);
    const index = this.archive.sessions.findIndex((s) => s.id === session.id);
    if (index >= 0) this.archive.sessions[index] = copy;
    else this.archive.sessions.push(copy);
    this.persist();
  }
  deleteSession(id: string): void {
    this.onSessionInvalidation?.(id);
    this.archive.sessions = this.archive.sessions.filter((s) => s.id !== id);
    this.persist();
  }
  hideWord(id: string): void {
    this.archive.preferences.hiddenWords.push(id);
    this.persist();
  }
  correctPassage(sessionID: string, passageID: string, text: string): void {
    const session = this.archive.sessions.find((s) => s.id === sessionID);
    if (!session) return;
    const passage = sessionPassages(session).find((p) => p.id === passageID && p.speaker === "user");
    if (!passage) return;
    passage.fragments.forEach((fragment, offset) => correctFragment(session, fragment.id, offset === 0 ? text.slice(0, 10_000) : ""));
    this.onSessionInvalidation?.(sessionID);
    this.persist();
  }
  deleteAll(): void {
    for (const session of this.archive.sessions) this.onSessionInvalidation?.(session.id);
    this.archive.sessions = [];
    this.archive.preferences.hiddenWords = [];
    this.persist();
  }
  exportData(): string {
    return encodeArchive(this.archive);
  }
  importData(text: string): void {
    const imported = decodeArchive(text);
    this.archive = mergeArchive(this.archive, imported);
    this.persist();
  }
  private persist(): void {
    let payload: string;
    try {
      payload = encodeArchive(this.archive);
    } catch {
      this.error = "Mural couldn’t save your progress. Please export a backup and try again.";
      this.notify();
      return;
    }
    this.persisting = this.persisting.then(() => writeDocument(payload)).then(
      () => { if (this.error) { this.error = null; this.notify(); } },
      (error) => { console.error(error); this.error = "Mural couldn’t save your progress. Please export a backup and try again."; this.notify(); },
    );
    this.notify();
  }
  flush(): Promise<void> {
    return this.persisting;
  }
}

// ---- connection settings (never exported in a backup) ---------------------------------------

const SETTINGS_KEY = "mural.connection";

export interface ConnectionSettings {
  mode: "openai" | "codex";
  openaiKey: string;
  proxyURL: string;
  proxyToken: string;
}

export function defaultConnectionSettings(): ConnectionSettings {
  return { mode: "openai", openaiKey: "", proxyURL: "", proxyToken: "" };
}

export function loadConnectionSettings(): ConnectionSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultConnectionSettings();
    const parsed = JSON.parse(raw) as Partial<ConnectionSettings>;
    return {
      mode: parsed.mode === "codex" ? "codex" : "openai",
      openaiKey: typeof parsed.openaiKey === "string" ? parsed.openaiKey : "",
      proxyURL: typeof parsed.proxyURL === "string" ? parsed.proxyURL : "",
      proxyToken: typeof parsed.proxyToken === "string" ? parsed.proxyToken : "",
    };
  } catch {
    return defaultConnectionSettings();
  }
}

export function saveConnectionSettings(settings: ConnectionSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* private mode or blocked storage */ }
}

export function validateOpenAIKey(key: string): string {
  const value = key.trim();
  if (!value.startsWith("sk-") || value.length < 20 || /\s/.test(value)) throw new Error("Enter a valid OpenAI API key.");
  return value;
}

export function normaliseProxyURL(url: string): string {
  const value = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(value)) throw new Error("Enter the proxy base URL, for example http://100.64.0.2:8790/v1.");
  try {
    new URL(value);
  } catch {
    throw new Error("Enter a valid proxy URL.");
  }
  return value.endsWith("/v1") ? value : value + "/v1";
}

/** The active connection, or null when the selected mode has no credentials yet. */
export function connectionFromSettings(settings: ConnectionSettings): Connection | null {
  if (settings.mode === "codex") {
    if (!settings.proxyURL || !settings.proxyToken) return null;
    return { mode: "codex", baseURL: settings.proxyURL, token: settings.proxyToken, liveModel: DEFAULT_LIVE_MODEL, textModel: DEFAULT_TEXT_MODEL, voice: DEFAULT_VOICE };
  }
  if (!settings.openaiKey) return null;
  return { mode: "openai", baseURL: OPENAI_BASE_URL, token: settings.openaiKey, liveModel: DEFAULT_LIVE_MODEL, textModel: DEFAULT_TEXT_MODEL, voice: DEFAULT_VOICE };
}
