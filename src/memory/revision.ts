/**
 * The revision of what the memory believes: which older knowledge a new fact replaces, which fact arrived behind a newer one, and
 * which evidence only disagrees. Three questions, one deterministic answer each, and no model in the loop — what a claim is about is
 * decided by the cues both records carry, whether it revises anything is decided by what the newer fact says (it changed, it denies,
 * or it merely reports), and the order is decided by the two facts' own valid times rather than by when either was written.
 *
 * Two rules carry the whole ticket. A fact that happened earlier but is written later never becomes the present: its window ends
 * where the newer claim starts, and it replaces nothing. And evidence that disagrees is never settled by being newer or heavier: a
 * denial leaves both claims disputed until a fact says which one holds, and until then a reader is given both, with their sources.
 * Nothing here writes, and nothing here decides what an evidence source means beyond these markers — a later report that names the
 * same subject without saying it changed is another record, not a revision, and the limitation is deliberate: the alternative is
 * inventing a contradiction out of two descriptions of the same thing.
 *
 * What counts as "about the same thing" is the one number this file could get wrong in a way a reader would never see, so it is
 * stated twice. Two records have to share at least two cues — one shared word is a topic, never a subject — and those shared cues
 * have to account for a third of the older claim's own topic, because a change announcement is usually broader than the claim it
 * retires: "the deploy pipeline switched to github actions and the release train is daily now" shares "release" and "train" with a
 * note about who schedules the release train and with a note about how the release notes are written, and it replaces neither of them.
 * A count alone cannot tell that overlap from the real one ("deploy", "pipeline", "release", "train" out of the seven cues of the
 * pipeline claim), and a count high enough to exclude the neighbours would make a short claim impossible to replace at all, since a
 * claim of four cues can share at most four. The share is measured against the older claim rather than the newer fact because it is
 * the older claim's window that closes: the newer fact has to speak for most of what that claim said, and a fact that announces a
 * change and its consequences is allowed to be broader than the claim it replaces. Every figure below is a constant of this build, so
 * the same two records revise the same way on every run.
 */
import type { Assertion, Experience, MemoryRecord, RevisionState, Scope, Supersession } from './model.ts'
import { cuesOf, materialText } from './retrieval.ts'

/** Cues a new fact must share with an older one before it may be read as being about the same thing. One shared word is a topic. */
export const REVISION_MIN_CUES = 2
/**
 * Share of the older claim's own topic those shared cues must account for. An announcement of a change is usually broader than the
 * claim it retires, so the cue count alone says nothing about whether this claim is the one that changed: two words out of twelve are
 * a topic both texts mention, and closing a window over them is the false revision the replay measured. A third of the older claim is
 * the point where the newer fact speaks for most of what it said, and it is deliberately a fraction of a claim rather than a number,
 * because a claim of four cues can never share more than four.
 */
export const REVISION_MIN_SHARE = 1 / 3
/** Most older records one new fact may relate to, so a broad subject cannot rewrite a whole history in one commit. */
export const REVISION_MAX = 4
/** Characters of a claim kept with a record: one line to read a revision by. The original is what a reader expands. */
export const CLAIM_MAX_CHARS = 400
/** Cues a claim's topic carries; the same tokenizer as retrieval, so a claim and a query agree about what a text is about. */
const TOPIC_CUES = 12
/**
 * What a piece of evidence says about the subject it shares with older knowledge: that it changed, that an older claim is false, or
 * nothing at all. Only the first two support a revision, and only the first states what holds now.
 */
export type RevisionSignal = 'replaces' | 'disputes' | undefined
/**
 * Phrases that say the subject itself changed. They are what separates "a new event that changes the current state" from "a report
 * about the same state", and they are matched on the newer evidence only: an older claim does not have to say it was later replaced.
 */
const CHANGE = /\b(?:is now|are now|was changed|were changed|changed to|changed from|changes to|has changed|have changed|now is|now runs?|updated to|moved to|switched to|no longer|instead of|replaced by|replaces)\b|改为|改成|换成|已改为|不再是|不再|变更了/
/** Phrases that deny a recorded claim without stating what holds instead, which is disagreement rather than a replacement. */
const DENIAL = /\b(?:not true|is not true|isn't true|incorrect|is wrong|was wrong|that is wrong|disagree|disagrees|contradicts|is false|no longer true)\b|不是这样|并非|不对|有误|不属实/

/**
 * What one text says about a change. A change marker wins over a denial marker: evidence that states what holds now is a replacement
 * even when it also denies the old claim, and evidence that only denies leaves the question open.
 */
export function revisionSignal(text: string): RevisionSignal {
  const said = text.toLowerCase()
  if (CHANGE.test(said)) return 'replaces'
  if (DENIAL.test(said)) return 'disputes'
  return undefined
}

/** Whether two records are about the same subject space: every scope key either names must agree, and an absent key is not a wildcard. */
const sameScope = (left: Scope, right: Scope): boolean => left.project === right.project && left.task === right.task
  && left.person === right.person
/**
 * What one record's claim is about: the cues of its own material, as the claim kept them. It is not the record's retrieval cues,
 * which also carry who spoke — two messages from one person share their author, and an author is not a subject.
 */
export const topicOf = (record: MemoryRecord): readonly string[] =>
  record.representation.assertions?.[0]?.topic ?? record.representation.cues
/** How many topic cues two records share, which is the only measure of "the same thing" this build uses. */
const sharedCues = (left: readonly string[], right: ReadonlySet<string>): number => left.filter(cue => right.has(cue)).length
/**
 * Whether the newer fact is about the same thing as the older claim: enough shared cues to be more than a shared topic, and enough of
 * them to account for a stated share of what the older claim itself was about. A claim whose topic this build kept nothing of can
 * never be replaced — there is nothing to compare, and inventing a relation out of no evidence is the failure this guard exists for.
 */
const sameSubject = (older: readonly string[], newer: ReadonlySet<string>): boolean => {
  if (older.length === 0) return false
  const shared = sharedCues(older, newer)
  return shared >= REVISION_MIN_CUES && shared / older.length >= REVISION_MIN_SHARE
}
/** How a claim is ordered against another: by the instant the fact held, and then by id so two runs agree. */
const byFactTime = (left: MemoryRecord, right: MemoryRecord): number => right.representation.validFrom.localeCompare(left.representation.validFrom)
  || left.experience.id.localeCompare(right.experience.id)

/**
 * The claim one experience makes: its text, the sources behind it, the cues that say what it is about, and the instant it started
 * holding. Deterministic, so the same experience always states the same claim and an operator can read two records side by side.
 */
export function claimOf(experience: Experience, cues: readonly string[]): Assertion {
  const whole = materialText(experience.material).replace(/\s+/g, ' ').trim()
  const text = whole.length > CLAIM_MAX_CHARS ? `${whole.slice(0, CLAIM_MAX_CHARS - 1)}…` : whole
  // The experience itself first, then the source references behind it: a conflict is returned with these, and nothing invented.
  const sources = [...new Set([experience.id, ...Object.values(experience.origin.ids)])].slice(0, 6)
  return { text, sourceIds: sources, status: 'current', topic: [...cues].slice(0, TOPIC_CUES), validFrom: experience.occurredAt }
}
/**
 * The revision links one new record commits with. A fact that says the shared subject changed replaces what was believed before it,
 * unless something newer already holds — in which case this fact is history: its own window ends where that newer claim starts, and
 * it changes nothing about the present. A fact that only denies leaves both sides disputed. A fact that names the subject without
 * saying either of those is another record about it, and links to nothing. "The same subject" is `sameSubject`, not a cue count: the
 * evidence has to be about what the older claim was about, or the ticket's rule — replace only when the evidence supports
 * replacement — would be satisfied by two records that merely talk about the same part of the system.
 */
export function revisionsOf(next: MemoryRecord, records: Iterable<MemoryRecord>): readonly Supersession[] {
  const signal = revisionSignal(materialText(next.experience.material))
  if (signal === undefined) return []
  const all = [...records]
  const states = revisionStates(all)
  const held = new Set(topicOf(next))
  const candidates = all.filter(record => record.experience.id !== next.experience.id
      && sameScope(record.experience.scope, next.experience.scope)
      && states.get(record.experience.id)?.status !== 'superseded'
      && sameSubject(topicOf(record), held))
    .sort(byFactTime).slice(0, REVISION_MAX)
  if (!candidates.length) return []
  const factTime = next.representation.validFrom
  // A denial states no replacement value, so it can order nothing: it leaves both claims disputed whatever their times say.
  if (signal === 'disputes') return candidates.map(other => link(other, 'disputes', factTime))
  const links: Supersession[] = []
  const newest = candidates.find(other => other.representation.validFrom > factTime)
  // A newer claim that already holds closes this one's window: the fact is history, and it replaces nothing that came before it.
  if (newest) links.push(link(newest, 'earlier', newest.representation.validFrom))
  for (const other of candidates) {
    // Two claims that start at the same instant cannot be ordered by time at all, so neither replaces the other and both are disputed.
    if (other.representation.validFrom === factTime) links.push(link(other, 'disputes', factTime))
    else if (newest === undefined || other.representation.validFrom < factTime) links.push(link(other, 'replaces', factTime))
  }
  return links.slice(0, REVISION_MAX)
}
/** One link to another experience, at the revision it held when this record was written. */
const link = (other: MemoryRecord, kind: Supersession['kind'], at: string): Supersession =>
  ({ experienceId: other.experience.id, revision: other.representation.revision, kind, at })

/**
 * Where every record of one published version stands, derived from the links the records themselves carry. Nothing is stored: a
 * successor closes an older window without rewriting the record that made the older claim, so this is the one place the two sides
 * are brought together. A replaced window is closed; a record that arrived already past a newer claim was born closed; a record that
 * disputes another is disputed itself; a window a later claim closed wins over a disagreement, because it settles it.
 */
export function revisionStates(records: Iterable<MemoryRecord>): Map<string, RevisionState> {
  const all = [...records]
  const replaced = new Map<string, { by: string; at: string }>(), disputed = new Map<string, string[]>()
  for (const record of all) {
    for (const edge of record.representation.supersedes ?? []) {
      if (edge.kind === 'replaces') { if (!replaced.has(edge.experienceId)) replaced.set(edge.experienceId, { by: record.experience.id, at: edge.at }) }
      else if (edge.kind === 'disputes') disputed.set(edge.experienceId, [...(disputed.get(edge.experienceId) ?? []), record.experience.id])
    }
  }
  const states = new Map<string, RevisionState>()
  for (const record of all) {
    const id = record.experience.id, representation = record.representation
    const closing = replaced.get(id)
    // A record written after a newer understanding existed carries its own end; a record replaced later learns it from the link.
    const validTo = closing?.at ?? representation.validTo
    const disagreements = disputed.get(id) ?? []
    const denies = (representation.supersedes ?? []).filter(edge => edge.kind === 'disputes').map(edge => edge.experienceId)
    const status = validTo !== undefined ? 'superseded' as const
      : disagreements.length || denies.length ? 'disputed' as const : 'current' as const
    // The record that already held when this one arrived is named by its own link, so a born-closed window names who closed it.
    const earlier = (representation.supersedes ?? []).find(edge => edge.kind === 'earlier')?.experienceId
    states.set(id, { status, validFrom: representation.validFrom, ...(validTo === undefined ? {} : { validTo }),
      ...(closing === undefined && earlier === undefined ? {} : { by: closing?.by ?? earlier }),
      disputedWith: [...new Set([...disagreements, ...denies])] })
  }
  return states
}

/** Where one record stands, given every record of the version it is read from. */
export function stateOf(record: MemoryRecord, records: Iterable<MemoryRecord>): RevisionState {
  const known = revisionStates(records).get(record.experience.id)
  return known ?? { status: 'current', validFrom: record.representation.validFrom, disputedWith: [] }
}
/** The cues two records share, which is the measure a revision's `REVISION_MIN_CUES` and `REVISION_MIN_SHARE` are stated against. */
export const topicOverlap = (left: MemoryRecord, right: MemoryRecord): number => sharedCues(topicOf(left), new Set(topicOf(right)))
