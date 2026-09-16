/**
 * Language detection for the redirect check (iOS uses NLLanguageRecognizer). tinyld returns
 * ISO 639-1 codes with an accuracy in 0…1; Norwegian Bokmål comes back as "no".
 */
import { detectAll } from "tinyld";

export interface Detection {
  languageID: string;
  confidence: number;
}

const ALIASES: Record<string, string> = { no: "nb", nn: "nb" };

/** Most likely language of `text`, or null when nothing is recognised. */
export function detectLanguage(text: string): Detection | null {
  const trimmed = text.trim();
  if (trimmed.length < 8) return null;
  let results: Array<{ lang: string; accuracy: number }>;
  try {
    results = detectAll(trimmed);
  } catch {
    return null;
  }
  const best = results[0];
  if (!best || !best.lang) return null;
  return { languageID: ALIASES[best.lang] ?? best.lang, confidence: Math.max(0, Math.min(1, best.accuracy)) };
}
