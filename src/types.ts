import type { AdmissionWaitId } from './brand.ts'

export type { AdmissionWaitId }

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable, non-surface record written before one model call waits for local provider admission. */
    'llm/admission-wait': LlmAdmissionWaitEventData
    /** Durable transition written after local admission succeeds and immediately before provider dispatch. */
    'llm/admission-started': LlmAdmissionStartedEventData
  }
}

/** Capacity that prevented a model call from entering its provider immediately. */
export type AdmissionWaitReason = 'cooldown' | 'concurrency' | 'queue' | 'requests' | 'tokens'

/** Durable payload recorded before one model call enters the local admission queue. */
export interface LlmAdmissionWaitEventData {
  waitId: AdmissionWaitId
  provider: string
  reason: AdmissionWaitReason
  maxWaitMs: number
  purpose?: 'compaction' | 'session-title'
}

/** Durable transition recorded after admission succeeds. */
export interface LlmAdmissionStartedEventData {
  waitId: AdmissionWaitId
  provider: string
}
