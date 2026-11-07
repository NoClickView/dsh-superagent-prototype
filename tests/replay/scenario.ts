/**
 * The replayed years, and the questions asked about them — the one part of the replay a person wrote by hand, and therefore the only
 * part that can say what a correct answer is. Nothing here is derived from a strategy, from the memory files or from the system being
 * measured: the `must` strings were decided when the episode texts were written, so an answer graded against them is graded against the
 * world the replay described rather than against the system's own account of itself (spec Testing Decision 10).
 *
 * One episode is one thing a person said, at one instant, spanning 2023-01-09 to 2026-11-06. The tags name the eight situations ticket
 * 11 requires; every tag has at least one question measured against it. `score` is the importance the replay's controlled background
 * model answers with for that episode — a fixed function of the scenario, part of the recorded configuration, so the rungs the weights
 * land on are reproducible rather than whatever a real provider happened to return.
 *
 * Times are the replay's own clock, never the wall clock of the machine running it: the memory's whole notion of age is arithmetic over
 * these instants, so a replay that read the real clock would not be reproducible a week later.
 */

/** The eight situations the ticket requires the replay to cover. */
export type ScenarioTag =
  /** A fact that a later fact replaced, where only the later one is the present. */
  | 'old-fact-update'
  /** Two different people with the same first name, which must not be collapsed into one. */
  | 'same-name-entities'
  /** One rare event that mattered far more than anything repeated around it. */
  | 'rare-important-event'
  /** The same fact restated many times, which must not become more important for being repeated. */
  | 'repeated-self-reference'
  /** Two pieces of evidence that disagree, which must be kept as a disagreement rather than settled by recency. */
  | 'contradictory-evidence'
  /** An experience below the last threshold that a strong cue wakes again, without that wake raising its weight. */
  | 'forget-then-reactivate'
  /** An original the bounded archive released, whose detail is therefore gone. */
  | 'evicted-originals'
  /** Years of silence, a restart inside them, and a read afterwards. */
  | 'long-idle-recovery'

/** Every tag, in the order the report lists them. */
export const TAGS: readonly ScenarioTag[] = ['old-fact-update', 'same-name-entities', 'rare-important-event',
  'repeated-self-reference', 'contradictory-evidence', 'forget-then-reactivate', 'evicted-originals', 'long-idle-recovery']

/** One thing a person said at one instant, and what the controlled background model thinks of it. */
export interface Episode {
  /** Stable name inside the scenario. The same episode fed twice is the same fact, and its id is derived from the fact itself. */
  readonly key: string
  /** When it happened, which is also the instant the replay's clock stands at while it is received. */
  readonly at: string
  readonly text: string
  /** The situation this episode is the evidence for. */
  readonly tag: ScenarioTag
  /** The importance the controlled background model returns for it, on the policy's 0–100 scale. */
  readonly score: number
  /** What the episode is there to make true, in one clause, for the report's per-situation breakdown. */
  readonly note: string
}

/** What a correct answer must contain: every one of these strings, in what the reader produced. */
export interface ExpectedAnswer { readonly kind: 'answer'; readonly must: readonly string[] }
/** What a correct answer is when the memory holds nothing that supports one: the reader must say it does not know. */
export interface ExpectedAbstention { readonly kind: 'abstain' }
export type Expectation = ExpectedAnswer | ExpectedAbstention

/** What a reader says instead of answering. It is the only fixed string in the grading, so it is the same for every strategy. */
export const ABSTAIN = 'I do not know'

/** One question a person asked, which is also an episode: asking it is a message the runtime receives and the memory captures. */
export interface Question {
  /** Stable name inside the scenario. */
  readonly id: string
  /** The situations this question is evidence about. */
  readonly tags: readonly ScenarioTag[]
  /** When it is asked, which is also the instant its own episode is received. */
  readonly at: string
  /** What the person typed. It is captured as an experience like any other message. */
  readonly ask: string
  /**
   * When the fact the question is about happened, which is the age the report bands its result by. A fact older than a year is one the
   * shipped time term has already lowered a rung, so mixing the two bands would hide which of the two effects a number came from.
   */
  readonly basis?: string
  /**
   * The instant the question is about. Absent means now: the memory is asked what holds at `at`, which is how a question about a past
   * state is answered by the claims that held then rather than by the newest ones.
   */
  readonly about?: string
  /** The hand-written key an answer is graded against, which no strategy, model or memory file contributes to. */
  readonly expect: Expectation
  /**
   * Details a correct answer must not carry, because the replayed world never stated them. They are the fabrication traps: an answer
   * naming one invented a fact, however plausible it reads.
   */
  readonly forbidden?: readonly string[]
  /**
   * Phrases that state a fact that is no longer current. An answer to a question about now that carries one is quoting what used to
   * hold as though it still did — the metric the spec calls stale-fact misuse.
   */
  readonly stale?: readonly string[]
}

/** The whole replayed world: what was said, in order, and what was asked about it. */
export interface ReplayScenario {
  readonly name: string
  /** The instant the replay starts and ends, which the report quotes. */
  readonly from: string
  readonly to: string
  readonly episodes: readonly Episode[]
  readonly questions: readonly Question[]
  /**
   * The facts a later fact replaced, as the phrases that state each of them. An answer about now carrying one of these is stale-fact
   * misuse; it is declared once here rather than per question, so a question added later is measured against the same list, and every
   * question's own `stale` list must be drawn from it.
   */
  readonly staleClaims: readonly string[]
  /**
   * The episodes a later fact states it replaced. The replay checks that exactly these, and no others, end up with their window closed:
   * a revision that closes a fact about something else reads a subject change out of two shared words, and the count of those is a
   * property of the mechanism the report has to own rather than a detail of one test.
   */
  readonly replaced: readonly string[]
  /**
   * Version-shaped details no episode ever stated. Any answer carrying one is a fabricated detail; the check reads the answer text
   * rather than any strategy's own confidence, so no model's self-description can affect it.
   */
  readonly fabricatedDetails: readonly string[]
}

/** The instant the questions are asked: the day after the last thing said, which is the end of the replayed years. */
const NOW = '2026-11-06T09:00:00.000Z'

/** One episode, in the order a person said it. */
const said = (key: string, at: string, tag: ScenarioTag, score: number, text: string, note: string): Episode =>
  ({ key, at, tag, score, text, note })

/**
 * The alert threshold, restated seven times over a year. One fact said once, and six messages that add nothing to it: a memory that
 * counted restatements as evidence would make this the most important thing in the corpus without anything having happened.
 */
const REPEATED = 'the alert threshold is 70 and must not be raised'
const RESTATEMENTS: readonly Episode[] = ['2023-09-01', '2023-11-01', '2024-01-01', '2024-03-01', '2024-05-01', '2024-07-01',
  '2024-09-01'].map((day, index) => said(`threshold.${index + 1}`, `${day}T10:00:00.000Z`, 'repeated-self-reference', 70, REPEATED,
  index === 0 ? 'the fact itself, which the six below only restate' : 'a restatement of the same fact'))

/**
 * The long original whose one exact detail the archive may release. The command sits in the second sentence, so a gist made of the
 * first sentence loses it while the original still states it — which is the difference between losing a detail to compression and
 * losing it to eviction, measured apart rather than together. The tail is long enough that the capture goes to a content-addressed
 * blob, which is the only class of original the archive may release at all.
 */
const PURGE = 'the settings cache is purged after a deploy in one documented step, and only that step clears it. Running make purge-cache '
  + 'against the release bucket clears the settings cache, and the same recipe clears the preview bucket, the staging bucket and the '
  + 'canary bucket, which is why the release checklist names it before every promotion of a build to the release train and after every '
  + 'rollback of one. Ask Alice before running it against production: the purge is not reversible, the buckets are shared with the '
  + 'reporting pipeline that reads them every night, and a purge during the reporting window makes a day of dashboards disappear. '
  + Array.from({ length: 13 }, (_, index) => `Standing note ${index + 1} on the purge window: the release engineer confirms the reporting `
    + 'pipeline has finished before the window opens, records the time the window opened in the release ticket, waits for the preview '
    + 'bucket to drain, and watches the staging dashboards for the ten minutes after the purge before promoting anything. ').join('')

/**
 * The years the replay covers. The silence between 2025-06 and 2026-02 is the long idle stretch, and the runtime is restarted inside
 * it: nothing was captured for eight months, and the memory must still answer for what it holds afterwards.
 */
const EPISODES: readonly Episode[] = [
  said('ci.jenkins', '2023-01-09T10:00:00.000Z', 'old-fact-update', 55,
    'the deploy pipeline runs on jenkins and the release train is weekly', 'the state a later fact replaces'),
  said('notes.hand', '2023-01-23T10:00:00.000Z', 'old-fact-update', 30,
    'the release notes are written by hand the day before every release train', 'a neighbour of the fact, not the fact'),
  said('outage.postmortem', '2023-07-18T10:00:00.000Z', 'rare-important-event', 95,
    'production outage on the night of the deploy: the database lost two hours of writes, and the post-mortem requires a backup check '
    + 'before every deploy from now on', 'said once, never restated, and the constraint still holds years later'),
  ...RESTATEMENTS,
  said('sam.billing', '2024-03-05T10:00:00.000Z', 'same-name-entities', 55,
    'Sam from the billing team took over the deploy pipeline from Alice', 'the first of two different people called Sam'),
  said('nightly.safe', '2024-06-02T10:00:00.000Z', 'contradictory-evidence', 45,
    'the nightly job is safe to skip on weekends because nothing writes overnight', 'the claim a later message disagrees with'),
  said('sam.platform', '2024-09-17T10:00:00.000Z', 'same-name-entities', 55,
    'Sam from the platform team took over the release train schedule', 'the second of two different people called Sam'),
  said('nightly.wrong', '2025-02-14T10:00:00.000Z', 'contradictory-evidence', 45,
    'that is wrong: the nightly job is not safe to skip on weekends, the weekend run still reconciles the ledger',
    'the denial, which leaves both claims standing'),
  said('ci.switched', '2025-05-20T10:00:00.000Z', 'old-fact-update', 60,
    'the deploy pipeline switched to github actions and the release train is daily now',
    'the replacement, which is the only current claim about the pipeline'),
  said('report.read', '2025-06-03T10:00:00.000Z', 'long-idle-recovery', 40,
    'the weekly report reads from the reporting pipeline and nothing else', 'the last thing said before eight months of silence'),
  said('cluster.old', '2026-02-10T10:00:00.000Z', 'old-fact-update', 70,
    'the staging cluster runs in eu-west-1', 'the state the next fact replaces'),
  said('deploy.incident', '2026-06-11T10:00:00.000Z', 'long-idle-recovery', 45,
    'the deploy went out without the backup check again, and the release train had to be rolled back',
    'a cue that shares enough with the 2023 outage to wake it'),
  said('cluster.new', '2026-08-03T10:00:00.000Z', 'old-fact-update', 70,
    'the staging cluster switched to eu-west-2 because the failover drill moved', 'the replacement, and the only current region claim'),
  said('cache.purge', '2026-09-10T10:00:00.000Z', 'evicted-originals', 60, PURGE,
    'a long original whose one exact detail the archive may release'),
]

/** The questions, each asked as a message the runtime receives and the memory captures, at the end of the replayed years. */
const QUESTIONS: readonly Question[] = [
  { id: 'cluster-now', tags: ['old-fact-update'], at: NOW, basis: '2026-08-03T10:00:00.000Z',
    ask: 'which region does the staging cluster run in now?',
    // Both claims are readable at this age, and only the replacement is the present one.
    expect: { kind: 'answer', must: ['eu-west-2'] }, stale: ['eu-west-1'] },
  { id: 'ci-now', tags: ['old-fact-update'], at: NOW, basis: '2025-05-20T10:00:00.000Z',
    ask: 'which CI does the deploy pipeline run on now?',
    expect: { kind: 'answer', must: ['github actions'] }, stale: ['runs on jenkins'] },
  { id: 'ci-past', tags: ['old-fact-update'], at: NOW, basis: '2023-01-09T10:00:00.000Z', about: '2023-06-01T00:00:00.000Z',
    ask: 'which CI did the deploy pipeline run on in June 2023?', expect: { kind: 'answer', must: ['runs on jenkins'] } },
  { id: 'sam-who', tags: ['same-name-entities'], at: NOW, basis: '2024-09-17T10:00:00.000Z', ask: 'which team did Sam take over?',
    // Two different people called Sam, and neither answer replaces the other: one answer that collapses them fails.
    expect: { kind: 'answer', must: ['billing', 'platform'] } },
  { id: 'nightly', tags: ['contradictory-evidence'], at: NOW, basis: '2025-02-14T10:00:00.000Z',
    ask: 'is the nightly job safe to skip on weekends?',
    expect: { kind: 'answer', must: ['not safe to skip', 'safe to skip'] } },
  { id: 'threshold', tags: ['repeated-self-reference'], at: NOW, basis: '2023-09-01T10:00:00.000Z', ask: 'what is the alert threshold?',
    expect: { kind: 'answer', must: ['70'] } },
  { id: 'postmortem', tags: ['rare-important-event', 'forget-then-reactivate'], at: NOW, basis: '2023-07-18T10:00:00.000Z',
    ask: 'the deploy went out without the post-mortem backup check again: what does the post-mortem require before a deploy?',
    expect: { kind: 'answer', must: ['backup check'] } },
  { id: 'report', tags: ['long-idle-recovery'], at: NOW, basis: '2025-06-03T10:00:00.000Z',
    ask: 'what does the weekly report read from?', expect: { kind: 'answer', must: ['reporting pipeline'] } },
  { id: 'purge', tags: ['evicted-originals'], at: NOW, basis: '2026-09-10T10:00:00.000Z',
    ask: 'what exact command purges the settings cache after a deploy?',
    // The only statement of the command is one long original, so this is the question a released original costs an answer to.
    expect: { kind: 'answer', must: ['make purge-cache'] } },
  { id: 'vendor', tags: ['rare-important-event'], at: NOW, ask: 'what did the incident review say about the database vendor contract?',
    // Nothing in the replayed years mentions a vendor contract, so any answer to it is invented.
    expect: { kind: 'abstain' }, forbidden: ['renewal', 'terminated', 'discount'] },
]

/** The scenario the replay runs: three years and ten months, eight months of silence inside them, and ten graded questions. */
export const SCENARIO: ReplayScenario = {
  name: 'acme/widgets, 2023-01-09 to 2026-11-06',
  from: '2023-01-09T10:00:00.000Z',
  to: NOW,
  episodes: EPISODES,
  questions: QUESTIONS,
  // Only the replaced claims state these, so an answer about now carrying one is quoting what something used to be.
  staleClaims: ['runs on jenkins', 'eu-west-1'],
  // The two facts the scenario wrote a replacement for, and the only two whose window should close.
  replaced: ['ci.jenkins', 'cluster.old'],
  // No episode states a version number, so any version-shaped answer invented the number it quotes.
  fabricatedDetails: [],
}

/** The one episode the bounded archive is measured on: the only statement of the detail its question asks for. */
export const PURGE_KEY = 'cache.purge'
/** The importance the controlled model gave the first restatement, whose record the repetition check reads. */
export const FIRST_RESTATEMENT = 'threshold.1'
