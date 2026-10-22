/**
 * Session-event type augmentations for dsh-llm-rate-limit.
 *
 * v0.1.2: the plugin no longer writes `llm/admission-wait` or
 * `llm/admission-started` events — those types are outside the engine's
 * KNOWN_SESSION_EVENT_TYPES vocabulary, and a live `Session.append()` cannot
 * set the `ignorable: true` marker, so every session that recorded such an
 * event became permanently unloadable. The interfaces are retained solely to
 * type legacy events written by 0.1.0 and earlier; they are no longer
 * declared on SessionEventMap because the plugin never produces them.
 */
import type { AdmissionWaitId } from './brand.ts';
export type { AdmissionWaitId };
/** Capacity that prevented a model call from entering its provider immediately. */
export type AdmissionWaitReason = 'cooldown' | 'concurrency' | 'queue' | 'requests' | 'tokens';
/** Legacy payload recorded by 0.1.0 and earlier before one model call entered the local admission queue. */
export interface LlmAdmissionWaitEventData {
    waitId: AdmissionWaitId;
    provider: string;
    reason: AdmissionWaitReason;
    maxWaitMs: number;
    purpose?: 'compaction' | 'session-title';
}
/** Legacy transition recorded by 0.1.0 and earlier after admission succeeded. */
export interface LlmAdmissionStartedEventData {
    waitId: AdmissionWaitId;
    provider: string;
}
