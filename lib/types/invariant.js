/** Package-owned admission-event invariants. @module dsh-llm-rate-limit/invariant */
/**
 * v0.1.2: the plugin no longer writes `llm/admission-wait` or
 * `llm/admission-started` events — those types are outside the engine's
 * KNOWN_SESSION_EVENT_TYPES vocabulary, and a live `Session.append()` cannot
 * set the `ignorable: true` marker, so every session that recorded such an
 * event became permanently unloadable ("contains event type ... unknown to
 * this harness ... refusing to interpret the log").
 *
 * Sessions written by 0.1.0 and earlier may still carry those events. They
 * are legacy data now: the engine either skips them (when repaired to carry
 * `ignorable: true`) or refuses the log (when unrepairable). Either way,
 * asserting structural invariants over them adds no safety, so this
 * companion no longer registers any validation.
 */
/** Cordis companion plugin name. */
export const name = 'llm-rate-limit-invariant';
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'];
/**
 * Register the LLM admission invariant companion.
 *
 * v0.1.2 registers no validation: the admission events this companion once
 * asserted over are no longer produced, and legacy copies are inert.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx) => Promise.resolve(ctx.invariants.register('dsh-llm-rate-limit', () => { }));
