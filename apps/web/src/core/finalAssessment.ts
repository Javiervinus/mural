/** Port of apps/ios/Core/FinalAssessmentQueue.swift: finish the last unassessed user passage after a session ends. */
import { LearningEngine } from "./learning";
import { passageRevisionKey, passageText, sessionPassages, type Assessment, type Passage, type SessionRecord } from "./models";

export interface FinalAssessmentResult {
  sessionID: string;
  languageID: string;
  assessment: Assessment;
  inputTokens: number;
  outputTokens: number;
  searchCalls: number;
}

/** Apply only to the original saved transcript, which may have changed or been deleted. Returns a new record. */
export function applyFinalAssessment(result: FinalAssessmentResult, current: SessionRecord | undefined): SessionRecord | null {
  if (!current || current.id !== result.sessionID || current.languageID !== result.languageID || !current.endedAt) return null;
  const validated = LearningEngine.validate(result.assessment, current);
  if (!validated) return null;
  if (current.assessments.some((a) => a.passageID === result.assessment.passageID && a.revisionKey === result.assessment.revisionKey)) return null;
  return {
    ...current,
    assessments: [...current.assessments.filter((a) => a.passageID !== validated.passageID), validated],
    inputTokens: current.inputTokens + result.inputTokens,
    outputTokens: current.outputTokens + result.outputTokens,
    searchCalls: current.searchCalls + result.searchCalls,
  };
}

export type Assess = (session: SessionRecord, passage: Passage) => Promise<FinalAssessmentResult>;

interface Job {
  token: number;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
}

export class FinalAssessmentQueue {
  onResult: ((result: FinalAssessmentResult) => void) | null = null;
  private readonly assess: Assess;
  private readonly timeoutMs: number;
  private jobs = new Map<string, Job>();
  private serial = 0;

  constructor(assess: Assess, timeoutSeconds = 15) {
    this.assess = assess;
    this.timeoutMs = Math.min(15, Math.max(0.001, timeoutSeconds)) * 1000;
  }

  submit(session: SessionRecord): boolean {
    if (!session.endedAt || this.jobs.has(session.id)) return false;
    const list = sessionPassages(session);
    let passage: Passage | undefined;
    for (let i = list.length - 1; i >= 0; i -= 1) { if (list[i]!.speaker === "user") { passage = list[i]; break; } }
    if (!passage || passageText(passage).length < 3) return false;
    const key = passageRevisionKey(passage);
    if (session.assessments.some((a) => a.passageID === passage!.id && a.revisionKey === key)) return false;
    this.serial += 1;
    const token = this.serial;
    const deadline = Date.now() + this.timeoutMs;
    const timer = setTimeout(() => { if (this.jobs.get(session.id)?.token === token) this.cancel(session.id); }, this.timeoutMs);
    this.jobs.set(session.id, { token, deadline, timer });
    void this.assess(session, passage).then((result) => {
      const job = this.jobs.get(session.id);
      if (!job || job.token !== token || Date.now() > job.deadline) return;
      if (result.sessionID !== session.id || result.languageID !== session.languageID) return;
      clearTimeout(job.timer);
      this.jobs.delete(session.id);
      this.onResult?.(result);
    }).catch(() => {
      const job = this.jobs.get(session.id);
      if (job?.token === token) { clearTimeout(job.timer); this.jobs.delete(session.id); }
    });
    return true;
  }

  isPending(id: string): boolean {
    return this.jobs.has(id);
  }

  cancel(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    clearTimeout(job.timer);
    this.jobs.delete(id);
  }
}
