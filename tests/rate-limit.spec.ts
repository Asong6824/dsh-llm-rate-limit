import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as rateLimit from '../src/index.ts'

function success(usage?: { inputTokens: number; outputTokens: number }): StreamChunk[] {
  return [
    ...usage === undefined ? [] : [{ type: 'usage' as const, usage }],
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function failure(code: string, providerRetryAfterMs?: number, status?: number): StreamChunk[] {
  return [{
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        message: `${code} failure`,
        code,
        ...status === undefined ? {} : { status },
        ...providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs },
      },
    },
  }]
}

class HandlerAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []

  constructor(
    private readonly handler: (options: GenerateOptions, call: number) => AsyncIterable<StreamChunk> | Iterable<StreamChunk>,
  ) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    yield* this.handler(options, this.calls.length)
  }
}

function basePolicy(overrides: Partial<rateLimit.ProviderLimitConfig> = {}): rateLimit.ProviderLimitConfig {
  return {
    requests: { perMinute: 60, burst: 1 },
    queue: { maxSize: 10, maxWaitMs: 10_000, auxiliary: 'queue' },
    ...overrides,
  }
}

function withoutRequestPolicy(
  overrides: Omit<Partial<rateLimit.ProviderLimitConfig>, 'requests'>,
): rateLimit.ProviderLimitConfig {
  return {
    queue: { maxSize: 10, maxWaitMs: 10_000, auxiliary: 'queue' },
    ...overrides,
  }
}

async function harness(
  adapter: HandlerAdapter,
  providers: Record<string, rateLimit.ProviderLimitConfig>,
): Promise<{ ctx: Context; fiber: Fiber }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(Object.assign((inner: Context) => {
    rateLimit.apply(inner, { providers }, { now: Date.now, random: () => 0.5 })
  }, { inject: rateLimit.inject }))
  ctx.llm.registerAdapter(['mock', 'other'], adapter)
  return { ctx, fiber }
}

function request(
  provider = 'mock',
  extra: Partial<GenerateOptions> = {},
): GenerateOptions {
  return { provider, model: 'model', messages: [], ...extra }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

afterEach(() => {
  vi.useRealTimers()
})

describe('llm-rate-limit', () => {
  it('paces request starts in FIFO order and records a paired non-surface wait', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const adapter = new HandlerAdapter(() => success())
    const { ctx } = await harness(adapter, { mock: basePolicy() })
    const session = ctx.sessions.create(SessionId('paced'))
    const first = request('mock', { sessionId: session.id })
    const second = request('mock', { sessionId: session.id })

    await collect(ctx.llm.stream(first))
    const pending = collect(ctx.llm.stream(second))
    await vi.advanceTimersByTimeAsync(999)
    expect(adapter.calls).toEqual([first])
    expect(session.events.filter(event => event.type === 'llm/admission-wait')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toEqual(success())
    expect(adapter.calls).toEqual([first, second])
    const wait = session.events.find(event => event.type === 'llm/admission-wait')
    const started = session.events.find(event => event.type === 'llm/admission-started')
    expect(wait?.data).toMatchObject({ provider: 'mock', reason: 'requests', maxWaitMs: 10_000 })
    expect(started?.data).toEqual({ waitId: wait?.data.waitId, provider: 'mock' })
  })

  it('bounds the concurrency queue, preserves FIFO, and sheds auxiliary calls', async () => {
    let releaseFirst: () => void = () => {}
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const adapter = new HandlerAdapter(async function* (_options, call) {
      if (call === 1) await firstGate
      yield* success()
    })
    const { ctx } = await harness(adapter, {
      mock: withoutRequestPolicy({
        maxConcurrentRequests: 1,
        queue: { maxSize: 1, maxWaitMs: 10_000, auxiliary: 'reject' },
      }),
    })

    const first = collect(ctx.llm.stream(request()))
    await vi.waitFor(() => { expect(adapter.calls).toHaveLength(1) })
    const second = collect(ctx.llm.stream(request()))
    const auxiliary = await collect(ctx.llm.stream(request('mock', { purpose: 'session-title' })))
    const overflow = await collect(ctx.llm.stream(request()))
    expect(auxiliary[0]).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'LOCAL_RATE_LIMIT' } } })
    expect(overflow[0]).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'LOCAL_RATE_LIMIT' } } })

    releaseFirst()
    await first
    await second
    expect(adapter.calls).toHaveLength(2)
  })

  it('cancels a queued call without contacting the provider', async () => {
    let releaseFirst: () => void = () => {}
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const adapter = new HandlerAdapter(async function* (_options, call) {
      if (call === 1) await gate
      yield* success()
    })
    const { ctx } = await harness(adapter, {
      mock: withoutRequestPolicy({ maxConcurrentRequests: 1 }),
    })
    const first = collect(ctx.llm.stream(request()))
    await vi.waitFor(() => { expect(adapter.calls).toHaveLength(1) })
    const controller = new AbortController()
    const queued = collect(ctx.llm.stream(request('mock', { signal: controller.signal })))
    controller.abort()
    await expect(queued).resolves.toMatchObject([{ type: 'finish', reason: { kind: 'aborted' } }])
    expect(adapter.calls).toHaveLength(1)
    releaseFirst()
    await first
  })

  it('times out a queued call without contacting the provider', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    let releaseFirst: () => void = () => {}
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const adapter = new HandlerAdapter(async function* (_options, call) {
      if (call === 1) await gate
      yield* success()
    })
    const { ctx } = await harness(adapter, {
      mock: withoutRequestPolicy({
        maxConcurrentRequests: 1,
        queue: { maxSize: 1, maxWaitMs: 100, auxiliary: 'queue' },
      }),
    })
    const first = collect(ctx.llm.stream(request()))
    await vi.waitFor(() => { expect(adapter.calls).toHaveLength(1) })
    const queued = collect(ctx.llm.stream(request()))
    await vi.advanceTimersByTimeAsync(100)
    await expect(queued).resolves.toMatchObject([{
      type: 'finish', reason: { kind: 'error', failure: { code: 'LOCAL_RATE_LIMIT' } },
    }])
    expect(adapter.calls).toHaveLength(1)
    releaseFirst()
    await first
  })

  it('reconciles estimated tokens against provider usage before waking the queue', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const adapter = new HandlerAdapter(() => success({ inputTokens: 8, outputTokens: 2 }))
    const { ctx } = await harness(adapter, {
      mock: withoutRequestPolicy({
        tokens: { perMinute: 60, burst: 10, estimatedOutputTokens: 5, imageTokens: 1 },
      }),
    })

    await collect(ctx.llm.stream(request()))
    const pending = collect(ctx.llm.stream(request()))
    await vi.advanceTimersByTimeAsync(4_999)
    expect(adapter.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(adapter.calls).toHaveLength(2)
  })

  it('uses bounded Retry-After cooldown and resets local backoff after success', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const scripts = [failure('BUSY', 2_000, 529), success(), failure('RATE_LIMIT'), success()]
    const adapter = new HandlerAdapter(() => scripts.shift() ?? success())
    const { ctx } = await harness(adapter, {
      mock: withoutRequestPolicy({
        cooldown: {
          codes: ['RATE_LIMIT'],
          statuses: [529],
          initialDelayMs: 500,
          maxDelayMs: 4_000,
          maxProviderDelayMs: 10_000,
          jitterRatio: 0,
        },
      }),
    })

    await collect(ctx.llm.stream(request()))
    const afterRetryAfter = collect(ctx.llm.stream(request()))
    await vi.advanceTimersByTimeAsync(1_999)
    expect(adapter.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await afterRetryAfter

    await collect(ctx.llm.stream(request()))
    const afterReset = collect(ctx.llm.stream(request()))
    await vi.advanceTimersByTimeAsync(499)
    expect(adapter.calls).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    await afterReset
    expect(adapter.calls).toHaveLength(4)
  })

  it('falls back to local cooldown when Retry-After exceeds its bound', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const scripts = [failure('RATE_LIMIT', 20_000), success()]
    const adapter = new HandlerAdapter(() => scripts.shift() ?? success())
    const { ctx } = await harness(adapter, {
      mock: withoutRequestPolicy({
        cooldown: {
          codes: ['RATE_LIMIT'],
          initialDelayMs: 500,
          maxDelayMs: 4_000,
          maxProviderDelayMs: 10_000,
          jitterRatio: 0,
        },
      }),
    })
    await collect(ctx.llm.stream(request()))
    const pending = collect(ctx.llm.stream(request()))
    await vi.advanceTimersByTimeAsync(499)
    expect(adapter.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(adapter.calls).toHaveLength(2)
  })

  it('passes unconfigured providers unchanged and rejects impossible reservations', async () => {
    const adapter = new HandlerAdapter(() => success())
    const { ctx } = await harness(adapter, {
      mock: withoutRequestPolicy({
        tokens: { perMinute: 60, burst: 4, estimatedOutputTokens: 5, imageTokens: 1 },
      }),
    })
    const direct = request('other')
    await collect(ctx.llm.stream(direct))
    expect(adapter.calls[0]).toBe(direct)

    const refused = await collect(ctx.llm.stream(request()))
    expect(refused).toMatchObject([{ type: 'finish', reason: { kind: 'error', failure: { code: 'LOCAL_RATE_LIMIT' } } }])
    expect(adapter.calls).toHaveLength(1)
  })

  it('aborts queued waits and reaches quiescence on disposal', async () => {
    let releaseFirst: () => void = () => {}
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const adapter = new HandlerAdapter(async function* (_options, call) {
      if (call === 1) await gate
      yield* success()
    })
    const { ctx, fiber } = await harness(adapter, {
      mock: withoutRequestPolicy({ maxConcurrentRequests: 1 }),
    })
    const first = collect(ctx.llm.stream(request()))
    await vi.waitFor(() => { expect(adapter.calls).toHaveLength(1) })
    const queued = collect(ctx.llm.stream(request()))
    let disposed = false
    const disposal = fiber.dispose().then(() => { disposed = true })
    await expect(queued).resolves.toMatchObject([{ type: 'finish', reason: { kind: 'aborted' } }])
    expect(disposed).toBe(false)
    releaseFirst()
    await first
    await disposal
    expect(disposed).toBe(true)
  })

  it('fails invalid provider policy at plugin load', () => {
    const ctx = new Context()
    expect(() => {
      rateLimit.apply(ctx, {
        providers: {
          mock: {
            requests: { perMinute: 1, burst: 1 },
            queue: { maxSize: 1, maxWaitMs: 1, auxiliary: 'queue' },
            cooldown: {
              codes: ['RATE_LIMIT'],
              initialDelayMs: 10,
              maxDelayMs: 5,
              maxProviderDelayMs: 5,
              jitterRatio: 0,
            },
          },
        },
      })
    }).toThrow(/maxDelayMs must not be below initialDelayMs/)
  })

  it('accepts each optional limiter independently through the loader schema', () => {
    expect(rateLimit.Config({
      providers: {
        mock: {
          requests: { perMinute: 600, burst: 1 },
          queue: { maxSize: 4, maxWaitMs: 500, auxiliary: 'reject' },
        },
      },
    })).toEqual({
      providers: {
        mock: {
          requests: { perMinute: 600, burst: 1 },
          queue: { maxSize: 4, maxWaitMs: 500, auxiliary: 'reject' },
        },
      },
    })
  })
})
