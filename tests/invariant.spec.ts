import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as RateLimitInvariant from '../src/invariant.ts'
import { AdmissionWaitId } from '../src/index.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(RateLimitInvariant)
  return ctx
}

describe('llm-rate-limit invariants', () => {
  it('accepts one valid wait and started pair', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('valid-admission'))
    const waitId = AdmissionWaitId('wait-1')
    expect(() => {
      session.append('llm/admission-wait', {
        waitId,
        provider: 'mock',
        reason: 'requests',
        maxWaitMs: 100,
      })
      session.append('llm/admission-started', {
        waitId,
        provider: 'mock',
      })
    }).not.toThrow()
  })

  it('rejects duplicate identities, invalid wait bounds, and mismatched starts', async () => {
    const ctx = await setup()
    const duplicate = ctx.sessions.create(SessionId('duplicate-admission'))
    const waitId = AdmissionWaitId('same')
    duplicate.append('llm/admission-wait', {
      waitId, provider: 'mock', reason: 'queue', maxWaitMs: 10,
    })
    expect(() => {
      duplicate.append('llm/admission-wait', {
        waitId, provider: 'mock', reason: 'tokens', maxWaitMs: 10,
      })
    }).toThrow(/already owned/)

    const deadline = ctx.sessions.create(SessionId('invalid-wait-bound'))
    expect(() => {
      deadline.append('llm/admission-wait', {
        waitId: AdmissionWaitId('deadline'),
        provider: 'mock',
        reason: 'cooldown',
        maxWaitMs: 0,
      })
    }).toThrow(/maxWaitMs/)

    const mismatch = ctx.sessions.create(SessionId('mismatch-admission'))
    mismatch.append('llm/admission-wait', {
      waitId: AdmissionWaitId('mismatch'),
      provider: 'mock',
      reason: 'concurrency',
      maxWaitMs: 10,
    })
    expect(() => {
      mismatch.append('llm/admission-started', {
        waitId: AdmissionWaitId('mismatch'),
        provider: 'other',
      })
    }).toThrow(/provider must match/)
  })

})
