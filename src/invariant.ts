/** Package-owned durable admission-event invariants. @module dsh-llm-rate-limit/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { AdmissionWaitReason } from './types.ts'
import type {} from './index.ts'

const PACKAGE_NAME = 'dsh-llm-rate-limit'
const WAIT_REASONS: readonly AdmissionWaitReason[] = [
  'cooldown', 'concurrency', 'queue', 'requests', 'tokens',
]

/** Cordis companion plugin name. */
export const name = 'llm-rate-limit-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

function validateWait(
  history: readonly SessionEvent[],
  event: SessionEvent<'llm/admission-wait'>,
  fail: InvariantFailure,
): void {
  const { waitId, provider, maxWaitMs } = event.data
  const reason: unknown = event.data.reason
  const purpose: unknown = event.data.purpose
  if (typeof waitId !== 'string' || waitId.length === 0) {
    fail('llm/admission-wait waitId must be a non-empty string')
  }
  if (history.some(prior => (prior.type === 'llm/admission-wait'
    || prior.type === 'llm/admission-started') && prior.data.waitId === waitId)) {
    fail(`llm/admission-wait waitId ${JSON.stringify(waitId)} is already owned`)
  }
  if (typeof provider !== 'string' || provider.length === 0) {
    fail('llm/admission-wait provider must be a non-empty string')
  }
  if (!WAIT_REASONS.some(candidate => candidate === reason)) {
    fail(`llm/admission-wait reason is unsupported: ${JSON.stringify(reason)}`)
  }
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > MAX_TIMER_DELAY_MS) {
    fail(`llm/admission-wait maxWaitMs must be a safe integer within 1..${MAX_TIMER_DELAY_MS}`)
  }
  if (purpose !== undefined && purpose !== 'compaction' && purpose !== 'session-title') {
    fail(`llm/admission-wait purpose is unsupported: ${JSON.stringify(purpose)}`)
  }
}

function validateStarted(
  history: readonly SessionEvent[],
  event: SessionEvent<'llm/admission-started'>,
  fail: InvariantFailure,
): void {
  const { waitId, provider } = event.data
  if (typeof waitId !== 'string' || waitId.length === 0) {
    fail('llm/admission-started waitId must be a non-empty string')
  }
  const wait = history.findLast((prior): prior is SessionEvent<'llm/admission-wait'> =>
    prior.type === 'llm/admission-wait' && prior.data.waitId === waitId)
  if (wait === undefined) fail('llm/admission-started pairs no prior wait')
  if (history.some(prior => prior.type === 'llm/admission-started' && prior.data.waitId === waitId)) {
    fail('llm/admission-started repeats one wait')
  }
  if (provider !== wait.data.provider) {
    fail('llm/admission-started provider must match its wait')
  }
}

function validateSession(session: Session, fail: InvariantFailure): void {
  for (const [index, event] of session.events.entries()) {
    if (event.type === 'llm/admission-wait') validateWait(session.events.slice(0, index), event, fail)
    else if (event.type === 'llm/admission-started') validateStarted(session.events.slice(0, index), event, fail)
  }
}

const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) validateSession(session, fail)
  ctx.on('session/created', (session) => { validateSession(session, fail) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type === 'llm/admission-wait') validateWait(session.events, event, fail)
    else if (event.type === 'llm/admission-started') validateStarted(session.events, event, fail)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the LLM admission invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
