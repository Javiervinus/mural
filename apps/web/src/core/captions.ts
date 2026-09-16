/**
 * Port of apps/ios/Core/MandarinPinyin.swift and CaptionWords. The phone uses the system
 * tokenizer's Latin readings; the web uses pinyin-pro's word segmentation, loaded only when
 * Mandarin is in use. Generated pinyin never becomes learning evidence.
 */

export interface MandarinPronunciationToken {
  text: string;
  pinyin: string | null;
}

export interface CaptionSegment {
  text: string;
  lookup: string | null;
}

const HAN = /[㐀-䶿一-鿿豈-﫿\u{20000}-\u{2FA1F}\u{30000}-\u{3347F}]/u;

export function containsHan(text: string): boolean {
  return HAN.test(text);
}

type Segmenter = (text: string) => Array<{ origin: string; result: string }>;
let segmenter: Segmenter | null = null;
let loading: Promise<Segmenter> | null = null;

/** Loads the pinyin dictionary once; callers can render without readings until it resolves. */
export function loadMandarin(): Promise<Segmenter> {
  if (segmenter) return Promise.resolve(segmenter);
  if (!loading) {
    loading = import("pinyin-pro").then((module) => {
      const fn: Segmenter = (text) => module.segment(text, { format: module.OutputFormat.AllSegment, toneType: "symbol", nonZh: "consecutive", segmentit: 2 });
      segmenter = fn;
      return fn;
    });
  }
  return loading;
}

export function mandarinReady(): boolean {
  return segmenter !== null;
}

function fallbackTokens(text: string): MandarinPronunciationToken[] {
  const tokens: MandarinPronunciationToken[] = [];
  let run = "";
  let runHan: boolean | null = null;
  for (const character of text) {
    const han = HAN.test(character);
    if (runHan !== null && han !== runHan) { tokens.push({ text: run, pinyin: null }); run = ""; }
    run += character;
    runHan = han;
  }
  if (run) tokens.push({ text: run, pinyin: null });
  return tokens;
}

/** Word tokens with readings; punctuation, spacing and unrecognised characters remain exactly as supplied. */
export function mandarinTokens(text: string): MandarinPronunciationToken[] {
  if (!text) return [];
  if (!segmenter) return fallbackTokens(text);
  const tokens: MandarinPronunciationToken[] = [];
  for (const segment of segmenter(text)) {
    if (!segment.origin) continue;
    if (containsHan(segment.origin)) {
      const reading = segment.result.replace(/\s+/g, " ").trim().toLowerCase();
      tokens.push({ text: segment.origin, pinyin: reading && !containsHan(reading) ? reading : null });
    } else {
      tokens.push({ text: segment.origin, pinyin: null });
    }
  }
  return tokens;
}

/** A separate reading aid; source text is never replaced. Null when nothing has a reading. */
export function mandarinReading(text: string): string | null {
  const parts = mandarinTokens(text);
  if (!parts.some((p) => p.pinyin)) return null;
  let result = "";
  for (const part of parts) {
    const value = part.pinyin ?? part.text;
    const last = result.at(-1);
    const first = value[0];
    if (last && first && /[\p{L}\p{N}]/u.test(last) && /[\p{L}\p{N}]/u.test(first)) result += " ";
    result += value;
  }
  return result;
}

function segmentFor(text: string): CaptionSegment {
  const word = text.replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, "");
  return { text, lookup: /\p{L}/u.test(word) ? word : null };
}

/** Keeps every source character, linking Chinese words instead of whole sentences. */
export function captionSegments(text: string, languageID: string): CaptionSegment[] {
  if (languageID === "zh") {
    return mandarinTokens(text).map((t) => ({ text: t.text, lookup: /\p{L}/u.test(t.text) ? t.text : null }));
  }
  const result: CaptionSegment[] = [];
  let run = "";
  for (const character of text) {
    const last = run.at(-1);
    if (last !== undefined && /\s/.test(last) !== /\s/.test(character)) { result.push(segmentFor(run)); run = ""; }
    run += character;
  }
  if (run) result.push(segmentFor(run));
  return result;
}
