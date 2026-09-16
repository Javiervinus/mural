/** Runs the shared cross-platform fixture so the web core stays interchangeable with the phone cores. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeArchive, encodeArchive, REFERENCE_DATE_OFFSET_SECONDS } from "../src/core/archive";
import { LearningEngine } from "../src/core/learning";
import { LanguageRegistry } from "../src/core/languages";
import { passageText, sessionPassages } from "../src/core/models";
import { TeachingPolicy } from "../src/core/policy";

const directory = join(process.cwd(), "../../shared/fixtures/cross-platform");
const source = readFileSync(join(directory, "archive.json"), "utf8");
const expected = JSON.parse(readFileSync(join(directory, "archive-expected.json"), "utf8"));

function referenceSeconds(date: Date): number {
  return date.getTime() / 1000 - REFERENCE_DATE_OFFSET_SECONDS;
}

type Json = Record<string, unknown>;
function fieldPaths(value: unknown, prefix = "", paths = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => fieldPaths(v, prefix + "[]", paths));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Json)) {
      if (child === null) continue;
      const path = prefix.endsWith(".translations") ? prefix + ".{}" : prefix + "." + key;
      paths.add(path);
      fieldPaths(child, path, paths);
    }
  }
  return paths;
}

describe("shared cross-platform fixture", () => {
  it("redirect decisions match the shared cases", () => {
    const cases = JSON.parse(readFileSync(join(directory, "redirect-cases.json"), "utf8")).cases as Array<{ language: string; detected: string; confidence: number; redirect: boolean }>;
    expect(cases.length).toBeGreaterThan(0);
    for (const item of cases) {
      const language = LanguageRegistry.module(item.language)!;
      expect(TeachingPolicy.shouldRedirectSpeech(language, item.detected, item.confidence), `${item.language}/${item.detected}/${item.confidence}`).toBe(item.redirect);
    }
  });

  it("re-encoded archive keeps every field and value of the fixture", () => {
    const archive = decodeArchive(source);
    const reencoded = encodeArchive(archive);
    expect(fieldPaths(JSON.parse(reencoded))).toEqual(fieldPaths(JSON.parse(source)));
    expect(JSON.parse(reencoded)).toEqual(JSON.parse(source));
    expect(decodeArchive(reencoded).sessions.map((s) => sessionPassages(s).map(passageText))).toEqual(archive.sessions.map((s) => sessionPassages(s).map(passageText)));
  });

  it("transcript passages match the fixture", () => {
    const archive = decodeArchive(source);
    const passages = expected.passages as Record<string, Array<{ speaker: string; text: string; fragmentIDs: string[] }>>;
    expect(new Set(Object.keys(passages))).toEqual(new Set(archive.sessions.map((s) => s.id)));
    for (const session of archive.sessions) {
      const want = passages[session.id]!;
      const got = sessionPassages(session);
      expect(got.length, session.id).toBe(want.length);
      want.forEach((item, i) => {
        expect(got[i]!.speaker).toBe(item.speaker);
        expect(passageText(got[i]!)).toBe(item.text);
        expect(got[i]!.fragments.map((f) => f.id)).toEqual(item.fragmentIDs);
      });
    }
  });

  it("learner projection matches the fixture", () => {
    const archive = decodeArchive(source);
    const learner = expected.learner as Json;
    const now = new Date((Number(expected.now) + REFERENCE_DATE_OFFSET_SECONDS) * 1000);
    const state = LearningEngine.project(archive.sessions, String(expected.languageID), archive.preferences.hiddenWords, now);
    expect(state.challenge).toBe(learner.challenge);
    expect(state.observationCount).toBe(learner.observationCount);
    expect(state.nextGoal).toBe(learner.nextGoal);
    expect(state.capabilities).toEqual(learner.capabilities);
    const want = learner.words as Array<Json>;
    const words = [...state.words].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    expect(words.map((w) => w.id)).toEqual(want.map((w) => w.id));
    want.forEach((item, i) => {
      const word = words[i]!;
      expect(word.lemma).toBe(item.lemma);
      expect(word.meaning).toBe(item.meaning);
      expect(word.form).toBe(item.form);
      expect(word.example).toBe(item.example);
      expect(word.bars).toBe(item.bars);
      expect(word.understandingCount).toBe(item.understandingCount);
      expect(word.independentCount).toBe(item.independentCount);
      expect(referenceSeconds(word.lastSeen)).toBe(item.lastSeen);
      expect(referenceSeconds(word.dueAt)).toBe(item.dueAt);
    });
  });
});
