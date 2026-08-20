/**
 * Provider-scoped proactive admission control around the LLM stream seam.
 *
 * @module dsh-llm-rate-limit
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { GenerateOptions, LlmFailure, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { AdmissionWaitId } from './brand.ts'
import { estimateRequestTokens } from './estimate.ts'
import type { AdmissionWaitReason } from './types.ts'

export type { AdmissionWaitReason, LlmAdmissionStartedEventData, LlmAdmissionWaitEventData } from './types.ts'
export { AdmissionWaitId } from './brand.ts'

export const name = 'llm-rate-limit'
export const inject = ['llm', 'sessions']

/** Request-token bucket configuration for one provider. */
export interface RequestLimitConfig {
  /** Refill rate over sixty seconds. */
  perMinute: number
  /** Maximum accumulated request permits. */
  burst: number
}

/** Estimated-token bucket configuration for one provider. */
export interface TokenLimitConfig {
  /** Refill rate over sixty seconds. */
  perMinute: number
  /** Maximum accumulated token permits. */
  burst: number
  /** Output allowance used when a request omits `maxTokens`. */
  estimatedOutputTokens: number
  /** Fixed estimate for each image content block. */
  imageTokens: number
}

/** Bounded waiting policy for one provider. */
export interface QueueConfig {
  /** Maximum calls waiting behind admitted calls. */
  maxSize: number
  /** Maximum time one queued call may wait. */
  maxWaitMs: number
  /** Whether auxiliary calls wait or fail whenever admission is not immediate. */
  auxiliary: 'queue' | 'reject'
}

/** Adaptive provider cooldown after selected terminal failures. */
export interface CooldownConfig {
  /** Stable provider-neutral failure codes that trigger cooldown. */
  codes?: string[]
  /** HTTP response statuses that trigger cooldown. */
  statuses?: number[]
  /** First local cooldown delay. */
  initialDelayMs: number
  /** Maximum local exponential delay. */
  maxDelayMs: number
  /** Largest exact provider `Retry-After` accepted. */
  maxProviderDelayMs: number
  /** Symmetric jitter ratio applied only to local delay. */
  jitterRatio: number
}

/** Complete admission policy for one provider route. */
export interface ProviderLimitConfig {
  /** Optional request-rate bucket. */
  requests?: RequestLimitConfig
  /** Optional estimated-token-rate bucket. */
  tokens?: TokenLimitConfig
  /** Optional cap on provider calls currently in flight. */
  maxConcurrentRequests?: number
  /** Required bound and auxiliary policy for delayed calls. */
  queue: QueueConfig
  /** Optional adaptive cooldown after selected provider failures. */
  cooldown?: CooldownConfig
}

/** Plugin configuration keyed by exact `GenerateOptions.provider`. */
export interface Config {
  /** Admission policies keyed by exact provider route; an empty map is inert. */
  providers: Record<string, ProviderLimitConfig>
}

const positiveInteger = (): z<number> => z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
const timerDelay = (): z<number> => z.number().min(1).max(MAX_TIMER_DELAY_MS)

/** Runtime schema for {@link Config}; semantic cross-field checks run at load. */
export const Config: z<Config> = z.object({
  providers: z.dict(z.object({
    requests: z.union([z.const(undefined), z.object({
      perMinute: positiveInteger().required(),
      burst: positiveInteger().required(),
    })]),
    tokens: z.union([z.const(undefined), z.object({
      perMinute: positiveInteger().required(),
      burst: positiveInteger().required(),
      estimatedOutputTokens: positiveInteger().required(),
      imageTokens: positiveInteger().required(),
    })]),
    maxConcurrentRequests: positiveInteger(),
    queue: z.object({
      maxSize: positiveInteger().required(),
      maxWaitMs: timerDelay().required(),
      auxiliary: z.union(['queue', 'reject']).required(),
    }).required(),
    cooldown: z.union([z.const(undefined), z.object({
      codes: z.array(z.string()),
      statuses: z.array(z.number().step(1).min(100).max(599)),
      initialDelayMs: timerDelay().required(),
      maxDelayMs: timerDelay().required(),
      maxProviderDelayMs: timerDelay().required(),
      jitterRatio: z.number().min(0).max(1).required(),
    })]),
  })).required(),
}) as unknown as z<Config>

/** Non-serializable clock and entropy hooks for deterministic tests. */
export interface RateLimitInternals {
  /** Wall-clock milliseconds used for bucket refill, cooldown, and queue deadlines. */
  now?: () => number
  /** Inclusive zero-to-one sample used for cooldown jitter. */
  random?: () => number
}

interface Bucket {
  tokens: number
  lastRefillAt: number
  readonly perMillisecond: number
  readonly burst: number
}

interface ProviderState {
  readonly config: ProviderLimitConfig
  readonly requests?: Bucket
  readonly tokens?: Bucket
  active: number
  failureEpoch: number
  failureStreak: number
  cooldownUntil: number
  queue: QueueEntry[]
  timer: ReturnType<typeof setTimeout> | undefined
  pumping: boolean
}

interface AdmissionLease {
  readonly state: ProviderState
  readonly reservedTokens: number
  readonly failureEpoch: number
  released: boolean
}

interface AdmissionSuccess {
  readonly ok: true
  readonly lease: AdmissionLease
}

interface AdmissionFailure {
  readonly ok: false
  readonly failure: LlmFailure
  readonly aborted: boolean
}

type AdmissionResult = AdmissionSuccess | AdmissionFailure

interface QueueEntry {
  readonly options: GenerateOptions
  readonly tokenCost: number
  readonly enqueuedAt: number
  readonly deadline: number
  readonly session?: Session
  readonly waitId?: AdmissionWaitId
  readonly resolve: (result: AdmissionResult) => void
  abortListener?: () => void
  settled: boolean
}

interface CapacityWait {
  readonly reason: AdmissionWaitReason
  /** Milliseconds until capacity can change; infinity means release-driven. */
  readonly delayMs: number
}

const KNOWN_PROVIDER_KEYS = new Set(['requests', 'tokens', 'maxConcurrentRequests', 'queue', 'cooldown'])
const KNOWN_REQUEST_KEYS = new Set(['perMinute', 'burst'])
const KNOWN_TOKEN_KEYS = new Set(['perMinute', 'burst', 'estimatedOutputTokens', 'imageTokens'])
const KNOWN_QUEUE_KEYS = new Set(['maxSize', 'maxWaitMs', 'auxiliary'])
const KNOWN_COOLDOWN_KEYS = new Set([
  'codes', 'statuses', 'initialDelayMs', 'maxDelayMs', 'maxProviderDelayMs', 'jitterRatio',
])

function rejectUnknownKeys(subject: string, value: object, known: ReadonlySet<string>): void {
  const unknown = Object.keys(value).find(key => !known.has(key))
  if (unknown !== undefined) throw new Error(`llm-rate-limit: ${subject} has unknown key "${unknown}"`)
}

function positiveSafeInteger(subject: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`llm-rate-limit: ${subject} must be a positive safe integer`)
  }
}

function validateConfig(config: Config): void {
  rejectUnknownKeys('config', config, new Set(['providers']))
  for (const [provider, policy] of Object.entries(config.providers)) {
    if (provider.length === 0) throw new Error('llm-rate-limit: provider keys must be non-empty')
    rejectUnknownKeys(`provider "${provider}"`, policy, KNOWN_PROVIDER_KEYS)
    if (policy.requests === undefined && policy.tokens === undefined
      && policy.maxConcurrentRequests === undefined && policy.cooldown === undefined) {
      throw new Error(`llm-rate-limit: provider "${provider}" must configure requests, tokens, maxConcurrentRequests, or cooldown`)
    }
    rejectUnknownKeys(`provider "${provider}" queue`, policy.queue, KNOWN_QUEUE_KEYS)
    positiveSafeInteger(`provider "${provider}" queue.maxSize`, policy.queue.maxSize)
    positiveSafeInteger(`provider "${provider}" queue.maxWaitMs`, policy.queue.maxWaitMs)
    if (policy.queue.maxWaitMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`llm-rate-limit: provider "${provider}" queue.maxWaitMs exceeds the timer limit`)
    }
    if (policy.requests !== undefined) {
      rejectUnknownKeys(`provider "${provider}" requests`, policy.requests, KNOWN_REQUEST_KEYS)
      positiveSafeInteger(`provider "${provider}" requests.perMinute`, policy.requests.perMinute)
      positiveSafeInteger(`provider "${provider}" requests.burst`, policy.requests.burst)
    }
    if (policy.tokens !== undefined) {
      rejectUnknownKeys(`provider "${provider}" tokens`, policy.tokens, KNOWN_TOKEN_KEYS)
      positiveSafeInteger(`provider "${provider}" tokens.perMinute`, policy.tokens.perMinute)
      positiveSafeInteger(`provider "${provider}" tokens.burst`, policy.tokens.burst)
      positiveSafeInteger(`provider "${provider}" tokens.estimatedOutputTokens`, policy.tokens.estimatedOutputTokens)
      positiveSafeInteger(`provider "${provider}" tokens.imageTokens`, policy.tokens.imageTokens)
    }
    if (policy.maxConcurrentRequests !== undefined) {
      positiveSafeInteger(`provider "${provider}" maxConcurrentRequests`, policy.maxConcurrentRequests)
    }
    if (policy.cooldown !== undefined) {
      rejectUnknownKeys(`provider "${provider}" cooldown`, policy.cooldown, KNOWN_COOLDOWN_KEYS)
      const { codes, statuses } = policy.cooldown
      if ((codes?.length ?? 0) === 0 && (statuses?.length ?? 0) === 0) {
        throw new Error(`llm-rate-limit: provider "${provider}" cooldown must configure codes or statuses`)
      }
      if (codes?.some(code => typeof code !== 'string' || code.length === 0)) {
        throw new Error(`llm-rate-limit: provider "${provider}" cooldown.codes must contain non-empty strings`)
      }
      if (codes !== undefined && new Set(codes).size !== codes.length) {
        throw new Error(`llm-rate-limit: provider "${provider}" cooldown.codes must not contain duplicates`)
      }
      if (statuses?.some(status => !Number.isInteger(status) || status < 100 || status > 599)) {
        throw new Error(`llm-rate-limit: provider "${provider}" cooldown.statuses must contain HTTP statuses`)
      }
      if (statuses !== undefined && new Set(statuses).size !== statuses.length) {
        throw new Error(`llm-rate-limit: provider "${provider}" cooldown.statuses must not contain duplicates`)
      }
      positiveSafeInteger(`provider "${provider}" cooldown.initialDelayMs`, policy.cooldown.initialDelayMs)
      positiveSafeInteger(`provider "${provider}" cooldown.maxDelayMs`, policy.cooldown.maxDelayMs)
      positiveSafeInteger(`provider "${provider}" cooldown.maxProviderDelayMs`, policy.cooldown.maxProviderDelayMs)
      if (policy.cooldown.maxDelayMs < policy.cooldown.initialDelayMs) {
        throw new Error(`llm-rate-limit: provider "${provider}" cooldown.maxDelayMs must not be below initialDelayMs`)
      }
      if (policy.cooldown.maxProviderDelayMs < policy.cooldown.maxDelayMs) {
        throw new Error(`llm-rate-limit: provider "${provider}" cooldown.maxProviderDelayMs must not be below maxDelayMs`)
      }
      if (!Number.isFinite(policy.cooldown.jitterRatio)
        || policy.cooldown.jitterRatio < 0 || policy.cooldown.jitterRatio > 1) {
        throw new Error(`llm-rate-limit: provider "${provider}" cooldown.jitterRatio must be within 0..1`)
      }
    }
  }
}

function bucket(config: RequestLimitConfig | TokenLimitConfig, now: number): Bucket {
  return {
    tokens: config.burst,
    lastRefillAt: now,
    perMillisecond: config.perMinute / 60_000,
    burst: config.burst,
  }
}

function refill(target: Bucket, now: number): void {
  const elapsed = Math.max(0, now - target.lastRefillAt)
  target.tokens = Math.min(target.burst, target.tokens + elapsed * target.perMillisecond)
  target.lastRefillAt = Math.max(target.lastRefillAt, now)
}

function bucketDelay(target: Bucket, cost: number): number {
  if (target.tokens >= cost) return 0
  return (cost - target.tokens) / target.perMillisecond
}

function usageTokens(usage: TokenUsage): number {
  return usage.inputTokens
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0)
    + usage.outputTokens
}

function localFailure(message: string): AdmissionFailure {
  return { ok: false, aborted: false, failure: { message, code: 'LOCAL_RATE_LIMIT' } }
}

function abortedFailure(message: string): AdmissionFailure {
  return { ok: false, aborted: true, failure: { message, code: 'ABORTED' } }
}

/**
 * Install proactive admission control for configured provider routes.
 * @param ctx - plugin context owning the stream listener and queued calls.
 * @param config - exact-provider admission policies.
 * @param internals - deterministic clock and entropy hooks for tests.
 */
export function apply(ctx: Context, config: Config, internals: RateLimitInternals = {}): void {
  validateConfig(config)
  const now = internals.now ?? Date.now
  const random = internals.random ?? Math.random
  const lifetime = new AbortController()
  const active = new Set<Promise<void>>()
  const states = new Map<string, ProviderState>()

  for (const [provider, policy] of Object.entries(config.providers)) {
    const createdAt = now()
    states.set(provider, {
      config: policy,
      ...policy.requests === undefined ? {} : { requests: bucket(policy.requests, createdAt) },
      ...policy.tokens === undefined ? {} : { tokens: bucket(policy.tokens, createdAt) },
      active: 0,
      failureEpoch: 0,
      failureStreak: 0,
      cooldownUntil: 0,
      queue: [],
      timer: undefined,
      pumping: false,
    })
  }

  function capacityWait(state: ProviderState, tokenCost: number, at: number): CapacityWait | undefined {
    if (state.requests !== undefined) refill(state.requests, at)
    if (state.tokens !== undefined) refill(state.tokens, at)
    if (state.cooldownUntil > at) return { reason: 'cooldown', delayMs: state.cooldownUntil - at }
    if (state.config.maxConcurrentRequests !== undefined
      && state.active >= state.config.maxConcurrentRequests) {
      return { reason: 'concurrency', delayMs: Number.POSITIVE_INFINITY }
    }
    if (state.requests !== undefined) {
      const delayMs = bucketDelay(state.requests, 1)
      if (delayMs > 0) return { reason: 'requests', delayMs }
    }
    if (state.tokens !== undefined) {
      const delayMs = bucketDelay(state.tokens, tokenCost)
      if (delayMs > 0) return { reason: 'tokens', delayMs }
    }
    return undefined
  }

  function reserve(state: ProviderState, tokenCost: number, at: number): AdmissionLease {
    if (state.requests !== undefined) {
      refill(state.requests, at)
      state.requests.tokens -= 1
    }
    if (state.tokens !== undefined) {
      refill(state.tokens, at)
      state.tokens.tokens -= tokenCost
    }
    state.active += 1
    return {
      state,
      reservedTokens: state.tokens === undefined ? 0 : tokenCost,
      failureEpoch: state.failureEpoch,
      released: false,
    }
  }

  function schedulePump(state: ProviderState, delayMs: number): void {
    if (state.timer !== undefined) clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      state.timer = undefined
      pump(state)
    }, Math.max(0, Math.min(MAX_TIMER_DELAY_MS, Math.ceil(delayMs))))
  }

  function settleEntry(entry: QueueEntry, result: AdmissionResult): void {
    if (entry.settled) return
    entry.settled = true
    if (entry.abortListener !== undefined) entry.options.signal?.removeEventListener('abort', entry.abortListener)
    entry.resolve(result)
  }

  function pump(state: ProviderState): void {
    if (state.pumping || lifetime.signal.aborted) return
    state.pumping = true
    try {
      if (state.timer !== undefined) {
        clearTimeout(state.timer)
        state.timer = undefined
      }
      while (state.queue.length > 0) {
        // The loop condition proves the indexed head exists.
        // oxlint-disable-next-line typescript/no-non-null-assertion
        const entry = state.queue[0]!
        const at = now()
        if (entry.deadline <= at) {
          state.queue.shift()
          settleEntry(entry, localFailure(`llm-rate-limit: provider "${entry.options.provider}" admission timed out`))
          continue
        }
        const wait = capacityWait(state, entry.tokenCost, at)
        if (wait !== undefined) {
          schedulePump(state, Math.min(wait.delayMs, entry.deadline - at))
          return
        }
        state.queue.shift()
        settleEntry(entry, { ok: true, lease: reserve(state, entry.tokenCost, at) })
      }
    } finally {
      state.pumping = false
    }
  }

  function cancelQueued(state: ProviderState, entry: QueueEntry): void {
    const index = state.queue.indexOf(entry)
    if (index < 0) return
    state.queue.splice(index, 1)
    settleEntry(entry, abortedFailure('llm-rate-limit: admission cancelled'))
    pump(state)
  }

  async function acquire(
    state: ProviderState,
    options: GenerateOptions,
    tokenCost: number,
  ): Promise<AdmissionResult> {
    if (lifetime.signal.aborted) return abortedFailure('llm-rate-limit: plugin disposed')
    if (options.signal?.aborted) return abortedFailure('llm-rate-limit: admission cancelled')
    if (state.tokens !== undefined && tokenCost > state.tokens.burst) {
      return localFailure(
        `llm-rate-limit: provider "${options.provider}" request estimate ${tokenCost} exceeds token burst ${state.tokens.burst}`,
      )
    }

    const at = now()
    const wait = state.queue.length === 0
      ? capacityWait(state, tokenCost, at)
      : { reason: 'queue' as const, delayMs: 0 }
    if (wait === undefined) return { ok: true, lease: reserve(state, tokenCost, at) }
    if (options.purpose !== undefined && state.config.queue.auxiliary === 'reject') {
      return localFailure(`llm-rate-limit: provider "${options.provider}" auxiliary request was shed`)
    }
    if (state.queue.length >= state.config.queue.maxSize) {
      return localFailure(`llm-rate-limit: provider "${options.provider}" admission queue is full`)
    }

    const sessionId = options.sessionId
    const session = sessionId === undefined ? undefined : ctx.sessions.get(sessionId)
    const waitId = session === undefined ? undefined : AdmissionWaitId(randomUUID())
    const deadline = at + state.config.queue.maxWaitMs
    let resolveResult: (result: AdmissionResult) => void = () => {}
    const result = new Promise<AdmissionResult>((resolve) => { resolveResult = resolve })
    const entry: QueueEntry = {
      options,
      tokenCost,
      enqueuedAt: at,
      deadline,
      ...session === undefined ? {} : { session },
      ...waitId === undefined ? {} : { waitId },
      resolve: resolveResult,
      settled: false,
    }
    if (session !== undefined && waitId !== undefined) {
      session.append('llm/admission-wait', {
        waitId,
        provider: options.provider,
        reason: wait.reason,
        maxWaitMs: state.config.queue.maxWaitMs,
        ...options.purpose === undefined ? {} : { purpose: options.purpose },
      })
    }
    entry.abortListener = () => { cancelQueued(state, entry) }
    options.signal?.addEventListener('abort', entry.abortListener, { once: true })
    state.queue.push(entry)
    pump(state)
    const admitted = await result
    if (admitted.ok) {
      const startedAt = now()
      if (startedAt > deadline) {
        rollback(admitted.lease)
        return localFailure(`llm-rate-limit: provider "${options.provider}" admission timed out`)
      }
    }
    if (admitted.ok && session !== undefined && waitId !== undefined && sessionId !== undefined
      && ctx.sessions.get(sessionId) === session) {
      try {
        session.append('llm/admission-started', { waitId, provider: options.provider })
      } catch (error: unknown) {
        rollback(admitted.lease)
        throw error
      }
    }
    return admitted
  }

  function release(lease: AdmissionLease): void {
    if (lease.released) return
    lease.released = true
    lease.state.active -= 1
    pump(lease.state)
  }

  function rollback(lease: AdmissionLease): void {
    const at = now()
    if (lease.state.requests !== undefined) {
      refill(lease.state.requests, at)
      lease.state.requests.tokens = Math.min(lease.state.requests.burst, lease.state.requests.tokens + 1)
    }
    if (lease.state.tokens !== undefined) {
      refill(lease.state.tokens, at)
      lease.state.tokens.tokens = Math.min(
        lease.state.tokens.burst,
        lease.state.tokens.tokens + lease.reservedTokens,
      )
    }
    release(lease)
  }

  function reconcile(lease: AdmissionLease, usage: TokenUsage | undefined): void {
    const tokens = lease.state.tokens
    if (tokens === undefined || usage === undefined) return
    refill(tokens, now())
    tokens.tokens = Math.min(tokens.burst, tokens.tokens + lease.reservedTokens - usageTokens(usage))
    pump(lease.state)
  }

  function cooldownDelay(config: CooldownConfig, streak: number): number {
    const exponent = Math.min(streak - 1, 1024)
    const target = Math.min(config.initialDelayMs * 2 ** exponent, config.maxDelayMs)
    const jitter = 1 - config.jitterRatio + 2 * config.jitterRatio * random()
    return Math.min(config.maxDelayMs, Math.max(0, Math.round(target * jitter)))
  }

  function observeFinish(lease: AdmissionLease, chunk: Extract<StreamChunk, { type: 'finish' }>): void {
    const { state } = lease
    const cooldown = state.config.cooldown
    if (chunk.reason.kind === 'error' && cooldown !== undefined
      && (cooldown.codes?.includes(chunk.reason.failure.code) === true
        || (chunk.reason.failure.status !== undefined
          && cooldown.statuses?.includes(chunk.reason.failure.status) === true))) {
      state.failureEpoch += 1
      state.failureStreak += 1
      const providerDelay = chunk.reason.failure.providerRetryAfterMs
      const delay = providerDelay !== undefined && Number.isFinite(providerDelay)
        && providerDelay > 0 && providerDelay <= cooldown.maxProviderDelayMs
        ? providerDelay
        : cooldownDelay(cooldown, state.failureStreak)
      state.cooldownUntil = Math.max(state.cooldownUntil, now() + delay)
      pump(state)
      return
    }
    if ((chunk.reason.kind === 'stop' || chunk.reason.kind === 'tool-calls' || chunk.reason.kind === 'max-tokens')
      && state.failureEpoch === lease.failureEpoch) {
      state.failureStreak = 0
    }
  }

  async function* limitedStream(
    options: GenerateOptions,
    next: () => AsyncIterable<StreamChunk>,
  ): AsyncGenerator<StreamChunk> {
    let resolveDone: () => void = () => {}
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    active.add(done)
    try {
      if (lifetime.signal.aborted) {
        const failure = abortedFailure('llm-rate-limit: plugin disposed')
        yield { type: 'finish', reason: { kind: 'aborted', failure: failure.failure } }
        return
      }
      const state = states.get(options.provider)
      if (state === undefined) {
        yield* next()
        return
      }
      const tokenCost = state.config.tokens === undefined
        ? 0
        : estimateRequestTokens(
          options,
          state.config.tokens.estimatedOutputTokens,
          state.config.tokens.imageTokens,
        )
      const admission = await acquire(state, options, tokenCost)
      if (!admission.ok) {
        yield {
          type: 'finish',
          reason: admission.aborted
            ? { kind: 'aborted', failure: admission.failure }
            : { kind: 'error', failure: admission.failure },
        }
        return
      }

      let usage: TokenUsage | undefined
      try {
        for await (const chunk of next()) {
          if (chunk.type === 'usage') usage = chunk.usage
          else if (chunk.type === 'finish') observeFinish(admission.lease, chunk)
          yield chunk
        }
      } finally {
        reconcile(admission.lease, usage)
        release(admission.lease)
      }
    } finally {
      active.delete(done)
      resolveDone()
    }
  }

  const disposeListener = ctx.on('llm/stream', (options, next) => limitedStream(options, next))

  ctx.effect(() => async () => {
    disposeListener()
    lifetime.abort(new Error('llm-rate-limit plugin disposed'))
    for (const state of states.values()) {
      if (state.timer !== undefined) clearTimeout(state.timer)
      state.timer = undefined
      for (const entry of state.queue.splice(0)) {
        settleEntry(entry, abortedFailure('llm-rate-limit: plugin disposed'))
      }
    }
    await Promise.allSettled([...active])
  }, 'llm-rate-limit: abort queued admission and drain active streams')
}
