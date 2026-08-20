/**
 * Provider-scoped proactive admission control around the LLM stream seam.
 *
 * @module dsh-llm-rate-limit
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export type { AdmissionWaitReason, LlmAdmissionStartedEventData, LlmAdmissionWaitEventData } from './types.ts';
export { AdmissionWaitId } from './brand.ts';
export declare const name = "llm-rate-limit";
export declare const inject: string[];
/** Request-token bucket configuration for one provider. */
export interface RequestLimitConfig {
    /** Refill rate over sixty seconds. */
    perMinute: number;
    /** Maximum accumulated request permits. */
    burst: number;
}
/** Estimated-token bucket configuration for one provider. */
export interface TokenLimitConfig {
    /** Refill rate over sixty seconds. */
    perMinute: number;
    /** Maximum accumulated token permits. */
    burst: number;
    /** Output allowance used when a request omits `maxTokens`. */
    estimatedOutputTokens: number;
    /** Fixed estimate for each image content block. */
    imageTokens: number;
}
/** Bounded waiting policy for one provider. */
export interface QueueConfig {
    /** Maximum calls waiting behind admitted calls. */
    maxSize: number;
    /** Maximum time one queued call may wait. */
    maxWaitMs: number;
    /** Whether auxiliary calls wait or fail whenever admission is not immediate. */
    auxiliary: 'queue' | 'reject';
}
/** Adaptive provider cooldown after selected terminal failures. */
export interface CooldownConfig {
    /** Stable provider-neutral failure codes that trigger cooldown. */
    codes?: string[];
    /** HTTP response statuses that trigger cooldown. */
    statuses?: number[];
    /** First local cooldown delay. */
    initialDelayMs: number;
    /** Maximum local exponential delay. */
    maxDelayMs: number;
    /** Largest exact provider `Retry-After` accepted. */
    maxProviderDelayMs: number;
    /** Symmetric jitter ratio applied only to local delay. */
    jitterRatio: number;
}
/** Complete admission policy for one provider route. */
export interface ProviderLimitConfig {
    /** Optional request-rate bucket. */
    requests?: RequestLimitConfig;
    /** Optional estimated-token-rate bucket. */
    tokens?: TokenLimitConfig;
    /** Optional cap on provider calls currently in flight. */
    maxConcurrentRequests?: number;
    /** Required bound and auxiliary policy for delayed calls. */
    queue: QueueConfig;
    /** Optional adaptive cooldown after selected provider failures. */
    cooldown?: CooldownConfig;
}
/** Plugin configuration keyed by exact `GenerateOptions.provider`. */
export interface Config {
    /** Admission policies keyed by exact provider route; an empty map is inert. */
    providers: Record<string, ProviderLimitConfig>;
}
/** Runtime schema for {@link Config}; semantic cross-field checks run at load. */
export declare const Config: z<Config>;
/** Non-serializable clock and entropy hooks for deterministic tests. */
export interface RateLimitInternals {
    /** Wall-clock milliseconds used for bucket refill, cooldown, and queue deadlines. */
    now?: () => number;
    /** Inclusive zero-to-one sample used for cooldown jitter. */
    random?: () => number;
}
/**
 * Install proactive admission control for configured provider routes.
 * @param ctx - plugin context owning the stream listener and queued calls.
 * @param config - exact-provider admission policies.
 * @param internals - deterministic clock and entropy hooks for tests.
 */
export declare function apply(ctx: Context, config: Config, internals?: RateLimitInternals): void;
