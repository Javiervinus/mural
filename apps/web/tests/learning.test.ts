import { describe, expect, it } from "vitest";
import { decodeArchive, emptyArchive, encodeArchive, mergeArchive, ArchiveError } from "../src/core/archive";
import { LearningEngine } from "../src/core/learning";
import { languageThemes, LanguageRegistry } from "../src/core/languages";
import { appendFragment, correctFragment, makeFragment, makeSession, passages, passageRevisionKey, safeURL, sessionPassages, type EvidenceKind, type SessionRecord } from "../src/core/models";

function fixture(day = 0, theme = "walk", supported = false, kind: EvidenceKind = "independent"): SessionRecord {
  const date = new Date((1_780_000_000 + day * 86400) * 1000);
  const s = makeSession("nb", theme);
  s.startedAt = date;
  appendFragment(s, makeFragment({ speaker: "user", text: "Jeg gikk i skogen.", startMS: 1000, endMS: 2000, receivedAt: date, meaningVisible: supported }));
  const p = sessionPassages(s)[0]!;
  s.assessments = [{
    passageID: p.id, revisionKey: passageRevisionKey(p), outcome: "success", suggestedLevel: 2, nextGoal: "Fortell mer.", capability: "Describes a past outing",
    words: [{ lemma: "å gå", meaning: "to go", form: "gikk", kind, confidence: 0.95, sourceIDs: p.fragments.map((f) => f.id), quote: "Jeg gikk i skogen.", language: "nb" }],
    createdAt: date, context: theme,
  }];
  return s;
}

describe("transcript", () => {
  it("ignores duplicate provider events", () => {
    const s = makeSession();
    const f = makeFragment({ id: "same", speaker: "user", text: "Hei", startMS: 0, endMS: 100 });
    appendFragment(s, f); appendFragment(s, f);
    expect(s.fragments).toHaveLength(1);
  });
  it("preserves exact provider whitespace", () => {
    const f = [makeFragment({ id: "a", speaker: "assistant", text: "Hva", startMS: 0, endMS: 100 }), makeFragment({ id: "b", speaker: "assistant", text: " gjorde du?", startMS: 100, endMS: 400 })];
    expect(passages(f)[0]?.fragments.map((x) => x.text).join("")).toBe("Hva gjorde du?");
  });
  it("late fragments rebuild the passage and invalidate evidence", () => {
    const s = fixture();
    appendFragment(s, makeFragment({ id: "late", speaker: "user", text: " kanskje", startMS: 2100, endMS: 2500 }));
    expect(s.assessments).toHaveLength(0);
    expect(sessionPassages(s)).toHaveLength(1);
  });
  it("keeps overlapping speakers separate", () => {
    const p = passages([
      makeFragment({ speaker: "assistant", text: "Hei", startMS: 0, endMS: 500 }),
      makeFragment({ speaker: "user", text: "Hallo", startMS: 100, endMS: 400 }),
      makeFragment({ speaker: "assistant", text: "!", startMS: 500, endMS: 600 }),
    ]);
    expect(p.map((x) => x.fragments.map((f) => f.text).join(""))).toEqual(["Hei!", "Hallo"]);
  });
});

describe("learning engine", () => {
  it("visible meaning cannot award independent recall", () => {
    const s = fixture(0, "walk", true);
    expect(LearningEngine.validate(s.assessments[0]!, s)?.words[0]?.kind).toBe("assisted");
    expect(LearningEngine.project([s]).words[0]?.independentCount).toBe(0);
  });
  it("immediate imitation is assisted", () => {
    const s = fixture();
    s.fragments.unshift(makeFragment({ speaker: "assistant", text: "Du gikk en tur?", startMS: 0, endMS: 500 }));
    expect(LearningEngine.validate(s.assessments[0]!, s)?.words[0]?.kind).toBe("assisted");
  });
  it("english cannot award norwegian production", () => {
    const s = fixture(); s.assessments[0]!.words[0]!.language = "en";
    expect(LearningEngine.validate(s.assessments[0]!, s)?.words).toHaveLength(0);
  });
  it("typing cannot award independent spoken recall", () => {
    const s = fixture(); s.fragments[0]!.typed = true;
    expect(LearningEngine.validate(s.assessments[0]!, s)?.words[0]?.kind).toBe("assisted");
  });
  it("rejects fabricated sources and quotes", () => {
    let s = fixture(); s.assessments[0]!.words[0]!.sourceIDs = ["invented"];
    expect(LearningEngine.validate(s.assessments[0]!, s)?.words).toHaveLength(0);
    s = fixture(); s.assessments[0]!.words[0]!.quote = "Jeg kan fly.";
    expect(LearningEngine.validate(s.assessments[0]!, s)?.words).toHaveLength(0);
  });
  it("never double credits duplicate assessments or proposals", () => {
    let s = fixture(); s.assessments = [...s.assessments, ...s.assessments];
    const projection = LearningEngine.project([s], "nb", [], s.startedAt);
    expect(projection.words[0]?.independentCount).toBe(1);
    expect(projection.observationCount).toBe(1);
    s = fixture(); s.assessments[0]!.words = [...s.assessments[0]!.words, ...s.assessments[0]!.words];
    expect(LearningEngine.project([s], "nb", [], s.startedAt).words[0]?.independentCount).toBe(1);
  });
  it("steady requires spacing and different contexts", () => {
    const first = fixture(), second = fixture(2), third = fixture(8, "dinner");
    expect(LearningEngine.project([first, second, third], "nb", [], third.startedAt).words[0]?.bars).toBe(3);
    expect(LearningEngine.project([first, second, fixture(8)], "nb", [], third.startedAt).words[0]?.bars).toBe(2);
    expect(LearningEngine.project([first, fixture(0.01), fixture(0.02)], "nb", [], first.startedAt).words[0]!.bars).toBeLessThanOrEqual(2);
  });
  it("strength fades and lapses lower it", () => {
    const sessions = [fixture(), fixture(2), fixture(8, "dinner")];
    const later = new Date(sessions[2]!.startedAt.getTime() + 30 * 86400 * 1000);
    expect(LearningEngine.project(sessions, "nb", [], later).words[0]?.bars).toBe(2);
    const lapse = fixture(9, "walk", false, "lapse");
    expect(LearningEngine.project([...sessions, lapse], "nb", [], lapse.startedAt).words[0]?.bars).toBe(1);
  });
  it("corrected transcript revokes evidence", () => {
    const s = fixture();
    correctFragment(s, s.fragments[0]!.id, "I went for a walk.");
    expect(s.assessments).toHaveLength(0);
    expect(LearningEngine.project([s]).words).toHaveLength(0);
  });
});

describe("archive", () => {
  it("round trips and guards the version", () => {
    const archive = emptyArchive(); archive.sessions = [fixture()];
    const decoded = decodeArchive(encodeArchive(archive));
    expect(decoded.sessions).toHaveLength(1);
    expect(decoded.sessions[0]!.startedAt.getTime()).toBe(archive.sessions[0]!.startedAt.getTime());
    const broken = JSON.parse(encodeArchive(archive)); broken.schemaVersion = 99;
    expect(() => decodeArchive(JSON.stringify(broken))).toThrow(ArchiveError);
  });
  it("rejects duplicate sessions and dangerous numbers", () => {
    const archive = emptyArchive(); const s = fixture(); archive.sessions = [s, { ...s }];
    expect(() => decodeArchive(encodeArchive(archive))).toThrow();
    archive.sessions = [fixture()];
    archive.sessions[0]!.searchCalls = 2_000_000_000;
    expect(() => decodeArchive(encodeArchive(archive))).toThrow();
    archive.sessions[0]!.searchCalls = 0; archive.sessions[0]!.inputTokens = -1;
    expect(() => decodeArchive(encodeArchive(archive))).toThrow();
  });
  it("merge preserves local preferences and revalidates evidence", () => {
    const original = emptyArchive(); original.preferences.meaningLanguage = "Spanish"; original.preferences.aiConsentVersion = 1;
    const incoming = emptyArchive(); incoming.preferences.meaningLanguage = "English";
    const invalid = fixture(); invalid.assessments[0]!.revisionKey = "changed"; incoming.sessions = [invalid];
    const merged = mergeArchive(original, incoming);
    expect(merged.preferences.meaningLanguage).toBe("Spanish");
    expect(merged.preferences.aiConsentVersion).toBe(1);
    expect(merged.sessions[0]!.assessments).toHaveLength(0);
    expect(decodeArchive(encodeArchive(merged)).sessions).toHaveLength(1);
  });
  it("migrates version 1 archives to norwegian", () => {
    const v1 = { schemaVersion: 1, preferences: { learningLanguageID: "x", meaningVisible: true, meaningLanguage: "English", sessionMinutes: 15, hiddenWords: ["hei|hi"], interests: "", hasOnboarded: true }, sessions: [] };
    const archive = decodeArchive(JSON.stringify(v1));
    expect(archive.preferences.learningLanguageID).toBe("nb");
    expect(archive.preferences.hiddenWords).toEqual(["nb|hei|hi"]);
  });
  it("source links reject non-https and credentials", () => {
    expect(safeURL({ title: "bad", url: "javascript:alert(1)" })).toBeNull();
    expect(safeURL({ title: "bad", url: "https://user@example.com/page" })).toBeNull();
    expect(safeURL({ title: "good", url: "https://www.nrk.no/" })).not.toBeNull();
  });
  it("every language has twenty-four distinct themes", () => {
    for (const language of LanguageRegistry.all) expect(new Set(languageThemes(language).map((t) => t.id)).size).toBe(24);
  });
});
