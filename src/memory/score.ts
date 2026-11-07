/**
 * The versioned numeric policy one remembered experience's importance is computed with, and the pure arithmetic that applies it.
 * A weight is a continuous number on one scale: the deterministic rule score and the background model's semantic score, combined
 * by non-negative coefficients, then lowered by exactly one time term and held inside explicit bounds. Thresholds are values of
 * that same policy, so nothing downstream can widen a decision into a low/middle/high label. Nothing here reads a file or a clock:
 * a policy that cannot explain a score is refused on load, and every caller of the same policy and record gets the same answer.
 *
 * Importance is one of four deliberately separate quantities. This file computes only importance; a query's correlation lives in
 * `retrieval.ts`, confidence belongs to the evidence rules, and current validity belongs to the revision work — so a recalled
 * experience never becomes more important for having been recalled.
 */
import type { Experience, ExperienceKind, Granularity, MemoryPolicy } from './model.ts'
import { POLICY_VERSION } from './model.ts'

/** Why a policy cannot be used: one of these, or none at all. */
export type PolicyProblem =
  /** The policy names no version, so a commit could not record which rules produced it. */
  | 'version'
  /** The scale is not an interval with room in it. */
  | 'scale'
  /** A coefficient is negative or not a number; a weight may never be raised by the model half alone. */
  | 'coefficientNegative'
  /** The coefficients do not form a convex combination, so the combination could leave the scale it is measured on. */
  | 'coefficientNotNormalised'
  /** The thresholds are not strictly ordered, so which of two of them a weight falls in would be undefined. */
  | 'thresholdOrder'
  /** A threshold lies outside the scale. */
  | 'thresholdOutsideScale'
  /** The top threshold is above the highest weight the policy can actually produce, so no record could ever reach it. */
  | 'thresholdUnreachable'
  /** The time unit is not one this term knows. */
  | 'timeUnit'
  /** The time base is not a timestamp, so a record without a time of its own has no age. */
  | 'timeBase'
  /** The decay is negative or larger than one, so the term could raise a weight or erase it within a day. */
  | 'timeDecay'
  /** The correlation a match needs before it may reactivate a forgotten experience is not a ratio between 0 and 1. */
  | 'recallThreshold'
  /** The equality rule is not a boolean, so a weight exactly at a threshold could silently take either rung. */
  | 'inclusive'
  /** A configured enter/exit pair is not two ordered points on the scale, so it would hold a decision instead of settling it. */
  | 'hysteresis'

/** What one experience's rule score is made of: the number, and the named terms that produced it, which a record keeps. */
export interface RuleScore { readonly score: number; readonly parts: readonly string[] }

/** The milliseconds in the policy's one unit; a day, because a memory's age is measured in days and nothing smaller. */
const DAY_MS = 86_400_000
/** What each kind of fact is worth before anything else is known: what was observed and what was decided outweigh what was inferred. */
const KIND_SCORE: Readonly<Record<ExperienceKind, number>> = { observation: 45, statement: 50, inference: 25 }
/** What naming the subject, linking the source, and belonging to an accepted piece of work add. */
const SUBJECT_SCORE = 8, URL_SCORE = 6, TASK_SCORE = 12
/** What the domain event behind the experience adds, when it is one of the events a weight is defined for. */
const EVENT_SCORE: Readonly<Record<string, number>> = { 'policy.changed': 15, 'ticket.created': 8, 'ticket.ended': 6, 'ticket.resumed': 4 }
/** The lowest and highest rule score the terms above can produce, which is what makes a top threshold reachable or not. */
export const RULE_BOUNDS = { min: Math.min(...Object.values(KIND_SCORE)),
  max: Math.max(...Object.values(KIND_SCORE)) + SUBJECT_SCORE + URL_SCORE + TASK_SCORE + Math.max(...Object.values(EVENT_SCORE)) } as const
/** What one reply may say beyond its number: a short rationale, and a bounded list of what it is unsure about. */
export const RATIONALE_MAX_CHARS = 300, UNCERTAIN_MAX = 5, UNCERTAIN_MAX_CHARS = 200

/**
 * The policy this build computes with. The numbers are the initial, validated choice rather than a measured optimum: the
 * coefficients are a convex combination so the result stays on the scale; the rule half decides what kind of fact it is and the
 * semantic half how much it will matter later; the time term is calibrated to the span an experience is expected to be read over
 * rather than to a season — ten years halves a weight that is still recalled, so a fact of the highest importance keeps its detail
 * for four years and its gist for thirteen, and the important experiences of a decade ago are still readable as what they were.
 * The first calibration this build shipped halved a weight in one year, which lowered every fact under the gist threshold within
 * nine months at importance 70 and read a year-old experience as history; that is why the version moved with the number. The
 * thresholds are the rungs of the ladder this build ships (70 keeps the detail, 40 keeps only the gist, 15 is where routine recall
 * lets go) with a weight exactly at one taking the higher rung; and a query needs a correlation of 0.34 before it may wake what
 * routine recall let go. The recalibration left all three thresholds alone: a slower term only keeps each rung reachable for longer,
 * and none of them became unreachable. The replay's calibration report records the basis for every one of them, and a change is a
 * new version, never an edit in place.
 */
export const MEMORY_POLICY: MemoryPolicy = {
  version: POLICY_VERSION,
  scale: { min: 0, max: 100 },
  ruleWeight: 0.6,
  semanticWeight: 0.4,
  // The base is the one timestamp an age is counted from when an experience carries no usable time of its own; the record's own
  // `occurredAt` is used once otherwise, so a record's age never depends on how often or when it was recalled. The decay is one half
  // per decade of age in the policy's unit: `1 / (1 + decay × ageDays)` is a half at 3650 days, and the replay measured the term the
  // year-long horizon it replaces produced over three years of experience.
  time: { unit: 'day', base: '2026-01-01T00:00:00.000Z', decay: 1 / 3650 },
  thresholds: { detail: 70, summary: 40, forgotten: 15 },
  // A weight exactly at a threshold keeps the higher branch: a record that just reached "detailed" is detailed.
  inclusive: true,
  recallThreshold: 0.34,
  // No hysteresis: a rung is a pure function of the record and the instant, nothing is written when it changes, and the weight
  // only falls as the clock advances, so there is no state that could flap and nothing a second re-scoring could steady.
}

/** Clamp `value` to the policy's scale. */
const clamp = (value: number, policy: MemoryPolicy): number => Math.min(policy.scale.max, Math.max(policy.scale.min, value))
/** Whether a value is a whole, finite number a policy may be built from. */
const finite = (value: number): boolean => typeof value === 'number' && Number.isFinite(value)

/**
 * Every way `policy` cannot explain a score, in one list; empty for a policy this build may compute with. It is called when the
 * policy is loaded, so a bad configuration is a refusal to score rather than a number nobody can account for later.
 */
export function policyProblems(policy: MemoryPolicy): readonly PolicyProblem[] {
  const problems: PolicyProblem[] = []
  if (typeof policy.version !== 'string' || policy.version === '') problems.push('version')
  const { min, max } = policy.scale
  if (!finite(min) || !finite(max) || min >= max) problems.push('scale')
  const weights = [policy.ruleWeight, policy.semanticWeight]
  if (weights.some(weight => !finite(weight) || weight < 0)) problems.push('coefficientNegative')
  else if (Math.abs(policy.ruleWeight + policy.semanticWeight - 1) > 1e-9) problems.push('coefficientNotNormalised')
  if (policy.time.unit !== 'day') problems.push('timeUnit')
  if (!finite(Date.parse(policy.time.base))) problems.push('timeBase')
  if (!finite(policy.time.decay) || policy.time.decay < 0 || policy.time.decay > 1) problems.push('timeDecay')
  const { detail, summary, forgotten } = policy.thresholds
  if (![detail, summary, forgotten].every(finite) || !(detail > summary && summary > forgotten)) problems.push('thresholdOrder')
  if ([detail, summary, forgotten].some(threshold => finite(threshold) && (threshold < min || threshold > max))) problems.push('thresholdOutsideScale')
  // The highest weight the combination can produce is bounded by the rule terms' own ceiling; a threshold above it is a decision
  // no experience could ever reach, which is a configuration error rather than an empty category.
  const highest = Math.min(max, policy.ruleWeight * Math.max(RULE_BOUNDS.max, min) + policy.semanticWeight * max)
  if (finite(detail) && detail > highest) problems.push('thresholdUnreachable')
  if (!finite(policy.recallThreshold) || policy.recallThreshold < 0 || policy.recallThreshold > 1) problems.push('recallThreshold')
  // The equality rule is read by every threshold decision, so it is a boolean and not a value that a caller could interpret either
  // way. A hysteresis pair is optional; one that is configured must be two points on the scale with the exit below the enter, or
  // it names a state the decision could enter and never leave.
  if (typeof policy.inclusive !== 'boolean') problems.push('inclusive')
  const hysteresis = policy.hysteresis
  if (hysteresis !== undefined && (!finite(hysteresis.enter) || !finite(hysteresis.exit) || hysteresis.enter <= hysteresis.exit
    || hysteresis.enter < min || hysteresis.enter > max || hysteresis.exit < min || hysteresis.exit > max)) problems.push('hysteresis')
  return problems
}

/**
 * The rule score of one experience: what kind of fact it is, whether it names its subject, whether it links to something
 * checkable, whether it belongs to accepted work, and which domain event it came from. Deterministic and repetition-blind: the
 * same record scores the same however often it was recalled or restated, and nothing about it is learned.
 */
export function ruleScoreOf(experience: Experience, policy: MemoryPolicy): RuleScore {
  const parts: string[] = [`kind ${experience.kind} +${KIND_SCORE[experience.kind]}`]
  let score = KIND_SCORE[experience.kind]
  if (experience.subject !== undefined && experience.subject !== '') { score += SUBJECT_SCORE; parts.push(`subject +${SUBJECT_SCORE}`) }
  if (experience.origin.url !== undefined) { score += URL_SCORE; parts.push(`url +${URL_SCORE}`) }
  if (experience.scope.task !== undefined) { score += TASK_SCORE; parts.push(`task +${TASK_SCORE}`) }
  const event = EVENT_SCORE[experience.origin.event]
  if (event !== undefined) { score += event; parts.push(`${experience.origin.event} +${event}`) }
  return { score: clamp(score, policy), parts }
}

/**
 * The importance of a rule score and a semantic score: the policy's non-negative linear combination, held inside its scale. The
 * semantic half comes from one background evaluation; it never replaces the rule half, and the result is one continuous number on
 * the policy's scale rather than a label either half chose.
 */
export function importanceOf(rule: number, semantic: number, policy: MemoryPolicy): number {
  const combined = policy.ruleWeight * rule + policy.semanticWeight * semantic
  return Number.isFinite(combined) ? clamp(combined, policy) : policy.scale.min
}

/**
 * The one deterministic time term: how much of a weight survives from `at` to `now`, counted in the policy's unit and lowered by
 * its decay. It is applied once, to the weight, and never to a score used to compute another one — so an experience's age cannot
 * be counted a second time through how often it was recalled. A timestamp the clock has not reached is not an age.
 */
export function timeFactorOf(at: string, now: string, policy: MemoryPolicy): number {
  const from = Date.parse(at)
  const to = Date.parse(now)
  const origin = Number.isFinite(from) ? from : Date.parse(policy.time.base)
  if (!Number.isFinite(to) || !Number.isFinite(origin)) return 1
  const age = Math.max(0, to - origin) / DAY_MS
  return 1 / (1 + policy.time.decay * age)
}

/** The effective weight of an experience: its importance with that one time term applied, still inside the policy's scale. */
export function weightOf(score: number, at: string, now: string, policy: MemoryPolicy): number {
  return Number.isFinite(score) ? clamp(score * timeFactorOf(at, now, policy), policy) : policy.scale.min
}

/**
 * The rung an effective weight has reached: what routine recall may show of the experience, and whether it is a candidate at all.
 * The three ordered thresholds are compared against the one continuous weight, so the answer is a statement about this instant
 * and this policy rather than a label anything stored. The equality rule is the policy's own: `inclusive` gives a weight exactly
 * at a threshold to the higher rung, and a policy that is not inclusive gives it to the lower one. A weight that is not a number
 * has no rung above the last, and is treated as left out rather than shown as something it is not.
 */
export function granularityOf(weight: number, policy: MemoryPolicy): Granularity {
  const { detail, summary, forgotten } = policy.thresholds
  const reached = (threshold: number): boolean => policy.inclusive ? weight >= threshold : weight > threshold
  if (!finite(weight)) return 'forgotten'
  if (reached(detail)) return 'detail'
  if (reached(summary)) return 'summary'
  if (reached(forgotten)) return 'cues'
  return 'forgotten'
}

/** The order the rungs sit in, from the least shown to the most; it is what makes "at least the gist" a comparison of two rungs. */
const RUNGS: readonly Granularity[] = ['forgotten', 'cues', 'summary', 'detail']
/**
 * `rung`, raised to `floor` when it sits below it. Reactivation is the door that uses it: a forgotten experience may be woken as
 * a candidate for this query, but it is shown at the gist rather than as a cue list it would have earned on its own — and never
 * above the rung its own weight reached.
 */
export const rungAtLeast = (rung: Granularity, floor: Granularity): Granularity =>
  RUNGS.indexOf(rung) >= RUNGS.indexOf(floor) ? rung : floor
