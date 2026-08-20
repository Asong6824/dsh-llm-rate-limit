import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable identity joining one queued admission with its started transition. */
export type AdmissionWaitId = Branded<'AdmissionWaitId'>

/**
 * Brand an implementation-minted admission-wait identity.
 * @param id - opaque wait identity.
 * @returns the same string, branded; no validation is performed.
 */
export function AdmissionWaitId(id: string): AdmissionWaitId {
  return id as AdmissionWaitId
}
