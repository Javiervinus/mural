/** Port of apps/ios/Core/LearningEngine.swift: evidence validation and recall projection. */
import { LanguageRegistry } from "./languages";
import { passageEndMS, passageStartMS, passageText, passageRevisionKey, sessionPassages, wordKey, type Assessment, type SessionRecord, type WordProposal } from "./models";

export interface WordState {
  id: string;
  lemma: string;
  meaning: string;
  form: string;
  example: string;
  bars: number;
  understandingCount: number;
  independentCount: number;
  lastSeen: Date;
  dueAt: Date;
}

export function wordLabel(word: WordState): string {
  return ["New", "Fragile", "Growing", "Steady"][Math.min(3, Math.max(0, word.bars))]!;
}
export function wordExplanation(word: WordState): string {
  if (word.independentCount === 0) return "Heard or used with support. Try using it in your own words.";
  if (word.bars === 1) return "Used independently. We’ll bring it back soon.";
  if (word.bars === 2) return "Recalled on different days. Still worth revisiting.";
  return "Recalled across days and contexts. Strength can fade with time.";
}

export interface LearnerState {
  challenge: number;
  observationCount: number;
  nextGoal: string;
  capabilities: string[];
  words: WordState[];
}
export function levelLabel(state: LearnerState): string {
  return state.observationCount < 4 ? "Getting to know you" : "Finding your pace";
}

const DAY = 86_400_000;

function containsCI(haystack: string, needle: string): boolean {
  return haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

/** Local-calendar start of day, mirroring Calendar.startOfDay in the iOS core. */
export function startOfDay(date: Date): number {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy.getTime();
}

export const LearningEngine = {
  validate(proposal: Assessment, session: SessionRecord): Assessment | null {
    if (!LanguageRegistry.module(session.languageID)) return null;
    const passagesList = sessionPassages(session);
    const passage = passagesList.find((p) => p.id === proposal.passageID && p.speaker === "user");
    if (!passage || passageRevisionKey(passage) !== proposal.revisionKey) return null;
    if (proposal.suggestedLevel < 0 || proposal.suggestedLevel > 5 || proposal.words.length > 12) return null;
    const allowed = new Set(passage.fragments.map((f) => f.id));
    const text = passageText(passage);
    const words: WordProposal[] = [];
    for (const word of proposal.words) {
      if (word.language !== session.languageID) continue;
      if (!word.sourceIDs.length || !word.sourceIDs.every((id) => allowed.has(id))) continue;
      if (!Number.isFinite(word.confidence) || word.confidence < 0.8 || word.confidence > 1) continue;
      if (!word.lemma || word.lemma.length >= 100 || !word.meaning || word.meaning.length >= 180) continue;
      if (!word.form || !word.quote) continue;
      if (!containsCI(text, word.quote) || !containsCI(word.quote, word.form)) continue;
      const refs = passage.fragments.filter((f) => word.sourceIDs.includes(f.id)).map((f) => f.text).join("");
      if (!containsCI(refs, word.quote)) continue;
      const result = { ...word, sourceIDs: [...word.sourceIDs] };
      if (result.kind === "independent") {
        // A visible meaning or immediate imitation is supporting evidence, never independent recall.
        const start = passageStartMS(passage);
        const recentlyModeled = passagesList.some((p) => p.speaker === "assistant" && passageStartMS(p) <= start && start - passageEndMS(p) < 90_000 && containsCI(passageText(p), word.form));
        if (passage.fragments.some((f) => f.meaningVisible || f.typed) || recentlyModeled) result.kind = "assisted";
      }
      words.push(result);
    }
    return { ...proposal, nextGoal: proposal.nextGoal.slice(0, 300), capability: proposal.capability.slice(0, 160), words };
  },

  project(sessions: SessionRecord[], languageID: string = LanguageRegistry.defaultID, hiddenWords: string[] = [], now: Date = new Date()): LearnerState {
    let level = 0, count = 0, successes = 0;
    let nextGoal = "Start with a greeting and one small question. Adjust from what the learner actually says.";
    const capabilityEvidence = new Map<string, Set<string>>();
    const events = new Map<string, Array<[WordProposal, Date, string]>>();
    const hidden = new Set(hiddenWords);
    const ordered = sessions.filter((s) => s.languageID === languageID).sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    for (const session of ordered) {
      const seen = new Set<string>();
      const assessments = [...session.assessments].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      for (const raw of assessments) {
        if (seen.has(raw.passageID)) continue;
        seen.add(raw.passageID);
        const a = LearningEngine.validate(raw, session);
        if (!a) continue;
        count += 1;
        if (a.outcome === "breakdown") { level = Math.max(0, level - 1); successes = 0; }
        else if (a.outcome === "success") {
          successes += 1;
          if (successes >= 2) { level = Math.min(5, Math.max(level, Math.min(level + 1, a.suggestedLevel))); successes = 0; }
        } else successes = 0;
        if (a.nextGoal) nextGoal = a.nextGoal;
        if (a.outcome === "success" && a.capability) {
          let set = capabilityEvidence.get(a.capability);
          if (!set) { set = new Set(); capabilityEvidence.set(a.capability, set); }
          set.add(`${startOfDay(a.createdAt)}|${a.context}`);
        }
        const seenWords = new Set<string>();
        for (const word of a.words) {
          const key = wordKey(word);
          if (hidden.has(key) || seenWords.has(key)) continue;
          seenWords.add(key);
          let list = events.get(key);
          if (!list) { list = []; events.set(key, list); }
          list.push([word, a.createdAt, a.context]);
        }
      }
    }
    const words: WordState[] = [];
    for (const [key, observations] of events) {
      const last = observations[observations.length - 1];
      if (!last) continue;
      const independent = observations.filter((o) => o[0].kind === "independent");
      const days = new Set(independent.map((o) => startOfDay(o[1]))).size;
      const contexts = new Set(independent.map((o) => o[2])).size;
      const lastRecall = independent.length ? independent[independent.length - 1]![1] : null;
      let bars = independent.length ? 1 : 0;
      if (days >= 2) bars = 2;
      if (days >= 3 && contexts >= 2 && independent[independent.length - 1]![1].getTime() - independent[0]![1].getTime() >= 7 * DAY) bars = 3;
      const interval = [1, 1, 4, 14][bars]! * DAY;
      const due = new Date((lastRecall ?? last[1]).getTime() + interval);
      if (now.getTime() > due.getTime() && bars > 1) bars -= 1;
      let lapse: [WordProposal, Date, string] | undefined;
      for (let i = observations.length - 1; i >= 0; i -= 1) { if (observations[i]![0].kind === "lapse") { lapse = observations[i]; break; } }
      if (lapse && lapse[1].getTime() > (lastRecall?.getTime() ?? -Infinity)) bars = Math.min(bars, 1);
      words.push({
        id: key, lemma: last[0].lemma, meaning: last[0].meaning, form: last[0].form, example: last[0].quote, bars,
        understandingCount: observations.filter((o) => o[0].kind === "understanding").length,
        independentCount: independent.length, lastSeen: last[1], dueAt: due,
      });
    }
    words.sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime());
    const capabilities = [...capabilityEvidence.entries()].filter(([, set]) => set.size >= 3).map(([name]) => name).sort();
    return { challenge: level, observationCount: count, nextGoal, capabilities, words };
  },
};
