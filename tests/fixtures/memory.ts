/** Capture inputs and limits for the memory tests: one experience as the runtime builds it, on a real temporary directory. */
import { key } from '../../src/core/ids.ts'
import { experienceId, opIdOf, type ExperienceInput, type MemoryLimits, type Scope } from '../../src/memory/model.ts'

/** Limits small enough that a test can fill the store, and large enough that one experience fits. */
export const testLimits = (overrides: Partial<MemoryLimits> = {}): MemoryLimits => ({ budgetBytes: 8 << 20, recallMaxChars: 4000,
  checkpointOps: 64, segmentBytes: 1 << 20, materialInlineMaxChars: 4096, maxCues: 32, ...overrides })

export interface InputParts {
  /** The domain event it came from, which the id is derived from. */
  event?: string
  /** The id of the thing the event is about: a trigger, a ticket, or the policy change. */
  primary?: string
  occurredAt?: string
  recordedAt?: string
  source?: string
  subject?: string
  scope?: Scope
  kind?: ExperienceInput['kind']
  text?: string
  url?: string
  ids?: Record<string, string>
}

/** One experience input, derived and identified exactly as `src/app/memory.ts` captures one. */
export function memoryInput(parts: InputParts = {}): ExperienceInput {
  const event = parts.event ?? 'trigger.received', primary = parts.primary ?? 'feishu:oc_team:om_1'
  const occurredAt = parts.occurredAt ?? '2026-11-06T09:00:03.000Z', recordedAt = parts.recordedAt ?? '2026-11-06T09:00:03.742Z'
  const text = parts.text ?? 'Alice: the regression is a stale cache, do not raise the threshold yet.'
  return { id: experienceId(event, primary, recordedAt), opId: opIdOf(experienceId(event, primary, recordedAt)), occurredAt, recordedAt,
    source: parts.source ?? 'feishu:oc_team', ...(parts.subject === undefined ? { subject: 'ou_alice' } : { subject: parts.subject }),
    scope: parts.scope ?? { project: 'acme/widgets', person: 'ou_alice' }, kind: parts.kind ?? 'observation',
    material: { text, chars: text.length },
    origin: { event, at: recordedAt, primary, ids: parts.ids ?? { triggerId: primary }, ...(parts.url === undefined ? {} : { url: parts.url }) } }
}

/** The id a memory entry of `parts` has, for a test that asserts on ids it did not choose. */
export const idOf = (parts: InputParts = {}): string => memoryInput(parts).id

/** A stable request id for the recalled material of one experience. */
export const recallIdOf = (id: string): string => key('recall', id)
