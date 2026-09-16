/** Port of apps/ios/Core/MeaningController.swift: one translation in flight, coalescing growing fragments. */
import { passageRevisionKey, passageText, type Passage } from "./models";

export interface MeaningRequest {
  sessionID: string;
  passageID: string;
  revisionKey: string;
  text: string;
  learningLanguageID: string;
  meaningLanguage: string;
}

export function meaningRequest(sessionID: string, passage: Passage, learningLanguageID: string, meaningLanguage: string): MeaningRequest {
  return { sessionID, passageID: passage.id, revisionKey: passageRevisionKey(passage), text: passageText(passage), learningLanguageID, meaningLanguage };
}
export function meaningCacheKey(revisionKey: string, language: string): string {
  return language + "::" + revisionKey;
}
export function requestCacheKey(request: MeaningRequest): string {
  return meaningCacheKey(request.revisionKey, request.meaningLanguage);
}
function sharesContext(a: MeaningRequest, b: MeaningRequest): boolean {
  return a.sessionID === b.sessionID && a.passageID === b.passageID && a.learningLanguageID === b.learningLanguageID && a.meaningLanguage === b.meaningLanguage;
}
function sameRequest(a: MeaningRequest, b: MeaningRequest): boolean {
  return sharesContext(a, b) && a.revisionKey === b.revisionKey && a.text === b.text;
}

export interface MeaningResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export type Translate = (request: MeaningRequest) => Promise<MeaningResult>;

export class MeaningController {
  text = "";
  isLoading = false;
  error: string | null = null;
  onResult: ((request: MeaningRequest, result: MeaningResult) => void) | null = null;
  onChange: (() => void) | null = null;
  private readonly translate: Translate;
  private readonly delayMs: number;
  private desired: MeaningRequest | null = null;
  private rendered: MeaningRequest | null = null;
  private working = false;
  private generation = 0;

  constructor(translate: Translate, delayMs = 450) {
    this.translate = translate;
    this.delayMs = delayMs;
  }

  private changed() {
    this.onChange?.();
  }

  update(request: MeaningRequest, cached: string | null = null): void {
    const changedContext = this.desired ? !sharesContext(this.desired, request) : true;
    if (changedContext) this.reset();
    this.desired = request;
    if (cached && cached.trim()) {
      this.cancelWorker();
      this.text = cached;
      this.rendered = request;
      this.error = null;
      this.changed();
      return;
    }
    if (this.rendered && sameRequest(this.rendered, request)) return;
    // Do not display a translation of text that was subsequently corrected.
    if (this.rendered && !request.text.startsWith(this.rendered.text)) {
      this.text = "";
      this.rendered = null;
      this.changed();
    }
    if (!this.working && this.error === null) this.begin();
  }

  reset(): void {
    this.cancelWorker();
    this.desired = null;
    this.rendered = null;
    this.text = "";
    this.error = null;
    this.changed();
  }

  retry(): void {
    if (!this.desired) return;
    this.cancelWorker();
    this.error = null;
    this.begin();
  }

  private cancelWorker() {
    this.generation += 1;
    this.working = false;
    if (this.isLoading) { this.isLoading = false; this.changed(); }
  }

  private begin() {
    if (!this.desired || this.working) return;
    this.working = true;
    this.isLoading = true;
    this.changed();
    const token = this.generation;
    void (async () => {
      try {
        if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        if (token !== this.generation || !this.desired) return;
        const request = this.desired;
        const result = await this.translate(request);
        if (token !== this.generation || !this.desired) return;
        const latest = this.desired;
        if (!result.text.trim()) throw new Error("The translation came back empty. Please try again.");
        this.onResult?.(request, result);
        if (sharesContext(latest, request) && latest.text.startsWith(request.text)) {
          this.text = result.text;
          this.rendered = request;
        }
        this.working = false;
        this.isLoading = false;
        this.changed();
        if (!sameRequest(latest, request)) this.begin();
      } catch (error) {
        if (token !== this.generation) return;
        this.working = false;
        this.isLoading = false;
        this.error = error instanceof Error ? error.message : String(error);
        this.changed();
      }
    })();
  }
}
