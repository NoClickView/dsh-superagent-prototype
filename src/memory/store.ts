/**
 * The memory's authority on disk, and its only writer: an append-only journal whose fsynced line is the commit point, a checkpoint
 * plus manifest that let a restart skip replaying everything, and the capacity accounting that makes the store refuse rather than
 * grow. A version here is a prefix of the journal that ends on a line boundary, so a reader can only ever see a complete version,
 * and there is no point at which two files have to agree. Tickets 03 and 09 extend the write boundary and the reclamation policy;
 * this file deliberately leaves both seams open.
 *
 * Durability claim, and what it does not claim. A committed op survives a **process crash**: the segment's `fsync` is real, and the
 * version a reader may identify is the longest parseable prefix of the journal, so a crash loses at most the op whose `fsync` never
 * returned — and the durable effect queue redelivers that one, which the stable experience id then dedupes. It is not a claim about
 * **power loss**. A file's `fsync` does not flush the directory entry that names it; `flushDirectory` asks for that where the
 * platform honours it, and on NTFS the request is refused with `EPERM`, so no rename here is treated as a durable commit. That is
 * exactly why every overwritten file is derived index data: a lost rename costs a slower `open()`, never a lost or mixed version.
 * `MemoryStep` names every point of that protocol, so a test can kill the process at any two syscalls of it.
 */
import { createHash } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, truncateSync,
  unlinkSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { POLICY_VERSION, type MemoryLimits, type MemoryRecord, type MemoryUsage, type Representation } from './model.ts'

/**
 * A point of the publication protocol a process crash can interrupt, named by the file operation it comes before: an append and
 * its fsync, a checkpoint and the manifest that names it, the deletion of what a checkpoint covers, and the two ends of a commit.
 * The protocol is the whole of what makes a version complete, so these are the only points a crash can be in. Reclamation adds the
 * two deletions it makes — a rebuildable cache and an original the commit before it already disowned — because a crash between
 * that commit and the blob it deletes is the one state a recovery pass has to finish.
 */
export type MemoryStep = 'journal.write' | 'journal.sync' | 'checkpoint.write' | 'checkpoint.rename' | 'manifest.write'
  | 'manifest.rename' | 'blob.write' | 'blob.drop' | 'index.drop' | 'segment.rotate' | 'segment.drop' | 'checkpoint.drop'
  | 'commit.ack' | 'recovery.republish'

/** What the store needs to open: where it lives, how large it may grow, the clock a checkpoint is stamped with, and who watches. */
export interface MemoryStoreHost {
  /** The memory root, `<stateDir>/memory` in the runtime; a test may point it at a temporary directory. */
  readonly dir: string
  readonly limits: MemoryLimits
  readonly now: () => string
  /**
   * Called before each operation `MemoryStep` names, and immediately before the commit that is durable and applied returns its
   * acknowledgement. A host that throws here is a process that died there: nothing after the throw happens and the caller must
   * discard this store and open it again. That is how the crash matrix is driven, and how a reader is opened mid-publication.
   */
  readonly interrupt?: (step: MemoryStep) => void
  /**
   * Open as a reader of the same files: serve the last complete version and write nothing — no staging sweep, no orphan sweep,
   * no index, no checkpoint, no truncation of a torn append. A reader therefore cannot repair what it reads, which is the point.
   */
  readonly readOnly?: boolean
}
/** The format this build writes and reads; a newer one opens the store read-only rather than being migrated silently. */
export const MEMORY_FORMAT = 'dsh-superagent-memory/1'
/** The one op this build writes. `exp.rep` and `meta` are reserved for tickets 06/07/08 and are refused until they exist. */
export interface ExpPutOp {
  readonly t: 'exp.put'; readonly seq: number; readonly version: number; readonly opId: string; readonly at: string
  readonly policy: string; readonly record: MemoryRecord
}
export type MemoryOp = ExpPutOp
/** The whole state as of one op, so a restart replays only the ops after it. `usage` here is display data: the files are the authority. */
export interface MemoryCheckpoint {
  readonly format: string; readonly seq: number; readonly version: number; readonly at: string; readonly policy: string
  readonly records: readonly MemoryRecord[]
}
/** The derived index a reader trusts: which checkpoint is complete, and which segments the writer last sealed. */
export interface MemoryManifest {
  readonly format: string; readonly version: number; readonly seq: number; readonly at: string
  readonly checkpoint?: { readonly file: string; readonly seq: number; readonly bytes: number; readonly sha256: string }
  readonly segments: readonly { readonly file: string; readonly firstSeq: number; readonly bytes: number; readonly sha256: string }[]
}
/** What one commit did. A back-pressured op wrote nothing: its input waits in the durable effect queue and is retried later. */
export type CommitResult =
  | { readonly status: 'created'; readonly version: number }
  | { readonly status: 'backpressured'; readonly usage: MemoryUsage }
/** The block sizes the accounting measures in, so `sum(usage)` compares with the directory's real size. */
const BLOCK = 4096
/** Fractions of the budget each class of file may take; a class may use the budget's headroom, and these only decide reclamation. */
export const SHARE = { raw: 0.6, journal: 0.1, history: 0.15, summaries: 0.08, index: 0.05, temporary: 0.02 } as const
/** Above this share of the budget the store reclaims what it can rebuild before it writes anything large. */
export const HIGH_WATER = 0.9
/** The share of the budget kept free so the store can always write its own commit: a journal line, a checkpoint, a manifest. */
export const COMMIT_RESERVE = 0.02
const BLOCKS = (bytes: number): number => Math.ceil(bytes / BLOCK) * BLOCK
const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
const pad = (value: number): string => String(value).padStart(8, '0')
const segmentName = (firstSeq: number): string => `journal-${pad(firstSeq)}.ndjson`
const segmentPattern = /journal-(\d+)\.ndjson$/
/** `journal-00000042.ndjson` reads as 42; a name that is not a segment is not read. */
const firstSeqOf = (path: string): number | undefined => { const found = segmentPattern.exec(path); return found?.[1] === undefined ? undefined : Number(found[1]) }
/** Bytes of every file directly in `dir`, in whole blocks, which is what the directory occupies. */
const directoryBytes = (dir: string): number => existsSync(dir)
  ? readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isFile()).reduce((sum, entry) => sum + BLOCKS(statSync(join(dir, entry.name)).size), 0)
  : 0
/** The names in a directory, and none at all when it does not exist: a reader of a memory root that was never written reads nothing. */
const names = (dir: string): string[] => existsSync(dir) ? readdirSync(dir) : []
/** A short synchronous pause, for the retries a Windows rename needs. `Atomics.wait` is the only sleep a synchronous path has. */
function pause(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* A platform without Atomics.wait retries at once. */ }
}
/**
 * Flush a directory entry where the platform allows it, because flushing a file does not flush the entry that names it. POSIX honours
 * this and makes a rename durable; NTFS refuses a directory `fsync` with `EPERM`, and some platforms refuse to open a directory at
 * all, which is a limitation this records rather than papers over — it is why no rename in this file is treated as a durable commit.
 */
function flushDirectory(dir: string): void {
  let fd: number | undefined
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code !== undefined && !['EPERM', 'EACCES', 'EINVAL', 'EBADF', 'ENOTSUP', 'EISDIR'].includes(code)) throw error
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* The handle is gone either way. */ } }
  }
}

/** One journal line, or `undefined` when it is not a complete op: a torn tail and a corrupt line must be told apart by the reader. */
export function parseOp(line: string): MemoryOp | undefined {
  let value: unknown
  try { value = JSON.parse(line) } catch { return undefined }
  if (!value || typeof value !== 'object') return undefined
  const op = value as Record<string, unknown>
  if (op.t !== 'exp.put') return undefined
  if (!Number.isSafeInteger(op.seq) || !Number.isSafeInteger(op.version) || typeof op.opId !== 'string' || typeof op.at !== 'string') return undefined
  if (typeof op.policy !== 'string' || !record(op.record)) return undefined
  return { t: 'exp.put', seq: op.seq as number, version: op.version as number, opId: op.opId, at: op.at, policy: op.policy,
    record: op.record as MemoryRecord }
}
/** Whether a value is a record this build can read: an experience with the fields retrieval and the store address it by. */
function record(value: unknown): value is MemoryRecord {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  const experience = item.experience as Record<string, unknown> | undefined
  const representation = item.representation as Record<string, unknown> | undefined
  return !!experience && !!representation && typeof experience.id === 'string' && typeof experience.occurredAt === 'string'
    && typeof experience.recordedAt === 'string' && typeof experience.source === 'string' && typeof experience.kind === 'string'
    && !!experience.scope && !!experience.material && !!experience.origin
    && typeof representation.experienceId === 'string' && typeof representation.revision === 'number'
    && Array.isArray(representation.cues) && !!representation.detail
    && Number.isSafeInteger(item.seq) && Number.isSafeInteger(item.version)
}
/** One checkpoint file, or `undefined` when it is not one this build reads. */
export function parseCheckpoint(value: unknown): MemoryCheckpoint | undefined {
  if (!value || typeof value !== 'object') return undefined
  const checkpoint = value as Record<string, unknown>
  if (checkpoint.format !== MEMORY_FORMAT || !Number.isSafeInteger(checkpoint.seq) || !Number.isSafeInteger(checkpoint.version)) return undefined
  if (typeof checkpoint.at !== 'string' || typeof checkpoint.policy !== 'string' || !Array.isArray(checkpoint.records)) return undefined
  if (!checkpoint.records.every(record)) return undefined
  return { format: MEMORY_FORMAT, seq: checkpoint.seq as number, version: checkpoint.version as number, at: checkpoint.at,
    policy: checkpoint.policy, records: checkpoint.records as MemoryRecord[] }
}
/** The manifest a reader may trust, or `undefined` when it was not written by this build. */
export function parseManifest(value: unknown): MemoryManifest | undefined {
  if (!value || typeof value !== 'object') return undefined
  const manifest = value as Record<string, unknown>
  if (manifest.format !== MEMORY_FORMAT || !Number.isSafeInteger(manifest.version) || !Number.isSafeInteger(manifest.seq)) return undefined
  if (typeof manifest.at !== 'string' || !Array.isArray(manifest.segments)) return undefined
  const files = (list: unknown): boolean => Array.isArray(list) && list.every(entry => !!entry && typeof entry === 'object'
    && typeof (entry as Record<string, unknown>).file === 'string' && Number.isSafeInteger((entry as Record<string, unknown>).bytes))
  const checkpoint = manifest.checkpoint
  if (checkpoint !== undefined && (!files([checkpoint]) || !Number.isSafeInteger((checkpoint as Record<string, unknown>).seq))) return undefined
  if (!files(manifest.segments)) return undefined
  return manifest as unknown as MemoryManifest
}

/**
 * The memory files and the state a reader may see. Every commit is one fsynced journal line; the checkpoint and manifest are
 * derived indexes written at a checkpoint or a segment rotation, so a crash between them costs a replay and never a version.
 */
export class MemoryStore {
  private readonly records = new Map<string, MemoryRecord>()
  private seqNumber = 0
  private versionNumber = 0
  private checkpointSeq = 0
  private writableFlag = true
  private readonly problems: string[] = []
  /** What reclamation has freed since this store opened, per class of file. Operational, so it starts again on every open. */
  private readonly reclaimedBytes = { caches: 0, versions: 0, originals: 0, bytes: 0 }
  private usage: MemoryUsage
  private segment = { name: '', bytes: 0 }
  private fd: number | undefined
  private constructor(private readonly host: MemoryStoreHost) {
    this.usage = this.measure()
    // A reader writes nothing at all, so it is a store that refuses every write by construction rather than by a policy it could
    // be argued out of. Everything else opens writable and only a failed recovery or a corrupt journal takes that away.
    if (host.readOnly === true) this.writableFlag = false
  }

  /** Open (or create) the store, recover the last complete version, and republish when the tail has grown long. Never throws. */
  static open(host: MemoryStoreHost): MemoryStore {
    const store = new MemoryStore(host)
    try { store.recover() } catch (error) { store.writableFlag = false; store.problems.push(`the memory store could not be recovered: ${String(error)}`) }
    store.usage = store.measure()
    if (store.writableFlag) {
      try {
        // The index names the version just recovered, so a reader finds one after every open, and the tail is checkpointed when
        // it has grown long enough to be worth skipping on the next open.
        store.hit('recovery.republish')
        store.publishManifest()
        store.maybeCheckpoint(false)
      } catch (error) { store.problems.push(`the memory store could not publish its index: ${String(error)}`) }
    }
    return store
  }
  /** The version a reader may identify: the journal prefix length, so two readers of the same version see the same records. */
  get version(): number { return this.versionNumber }
  /** The last op applied, which is the version in this build. */
  get seq(): number { return this.seqNumber }
  /** False when recovery found corruption or a newer format; the store then serves reads and refuses every write. */
  get writable(): boolean { return this.writableFlag }
  get problemList(): readonly string[] { return this.problems }
  /** The records of the current version, in the order they were first written. */
  entries(): Iterable<MemoryRecord> { return this.records.values() }
  record(id: string): MemoryRecord | undefined { return this.records.get(id) }
  size(): number { return this.records.size }
  /** What the files take now. */
  get currentUsage(): MemoryUsage { return this.usage }
  /** Bytes held back from the budget for the store's own commit, which no capture may spend on its own content. */
  get reserveBytes(): number { return reserveOf(this.host.limits.budgetBytes) }
  /** Bytes reclamation has freed since this store opened, and how much of it came from each class of file. */
  get reclaimed(): { readonly caches: number; readonly versions: number; readonly originals: number; readonly bytes: number } {
    return { ...this.reclaimedBytes }
  }
  /** The bytes one more commit may take before the store is full; an input larger than this is stored truncated, not refused. */
  remainingBytes(): number {
    const limit = this.host.limits.budgetBytes
    return Math.max(0, Math.floor(limit - this.usage.total - reserveOf(limit) - BLOCK))
  }
  /**
   * Publish one experience: one journal line, fsynced before the state changes, so a reader never sees an op that is not durable. A
   * duplicate (the same id with the same record) writes nothing and returns the version it already had, which is what makes a
   * redelivery after a crash a no-op. `reclaiming` names an op that exists to free space — the commit that disowns an original —
   * which is the one commit allowed to spend the reserve, because it is the store's own way out of a full disk rather than content
   * competing with it. Even that one may never cross the hard cap.
   */
  commit(opId: string, at: string, record: MemoryRecord, reclaiming = false): { readonly result: CommitResult; readonly duplicate: boolean } {
    const held = this.records.get(record.experience.id)
    if (held && sameRecord(held, record)) return { result: { status: 'created', version: this.versionNumber }, duplicate: true }
    if (!this.writableFlag) throw new Error('The memory store is read-only')
    const seq = this.seqNumber + 1, version = seq
    const published: MemoryRecord = { ...record, seq, version }
    const op: MemoryOp = { t: 'exp.put', seq, version, opId, at, policy: POLICY_VERSION, record: published }
    const line = `${JSON.stringify(op)}\n`
    const bytes = Buffer.byteLength(line)
    if (!this.reserve(bytes, reclaiming)) return { result: { status: 'backpressured', usage: this.usage }, duplicate: false }
    this.append(line, bytes)
    this.records.set(published.experience.id, published)
    this.seqNumber = seq
    this.versionNumber = version
    this.usage = this.measure()
    this.maybeCheckpoint(false)
    // The op is durable and applied and the caller has not been told: a crash here is exactly the case a redelivery must survive.
    this.hit('commit.ack')
    return { result: { status: 'created', version }, duplicate: false }
  }
  /** Write original text as a content-addressed blob, or return the id of the identical blob already held. */
  writeBlob(text: string): { blob: string; bytes: number } {
    const bytes = Buffer.from(text, 'utf8'), blob = sha256(bytes)
    const path = join(this.host.dir, 'raw', blob)
    if (!existsSync(path) || statSync(path).size !== bytes.length) {
      mkdirSync(join(this.host.dir, 'raw'), { recursive: true })
      this.replace(path, bytes, ['blob.write', 'blob.write'])
    }
    return { blob, bytes: bytes.length }
  }
  /** The whole original text of a blob, or `undefined` when it is no longer there: a released original is never filled in. */
  readBlob(blob: string): string | undefined {
    try { return readFileSync(join(this.host.dir, 'raw', blob), 'utf8') } catch { return undefined }
  }
  /**
   * Delete one blob whose record a commit already disowned, unless another record still names it. The order is the whole of its
   * safety: the op that says the detail is unavailable is fsynced first, so a crash here leaves an orphan blob that the next open
   * sweeps, and never a record claiming text the store no longer has. A blob is content addressed, so two experiences that quote
   * the same long text share one file — releasing one of them may not take the other's original with it, which is why a blob a
   * readable record still names is kept. Unlinking a file another reader holds open succeeds on this platform, which is why a
   * reader opened before the release keeps its answer and finds the text gone if it asks for it again.
   */
  dropBlob(blob: string): boolean {
    if (!this.writableFlag) return false
    const shared = [...this.records.values()].some(record => record.experience.material.form === 'blob'
      && record.experience.material.blob === blob && record.representation.detail.available)
    if (shared) return false
    this.hit('blob.drop')
    try {
      const bytes = BLOCKS(statSync(join(this.host.dir, 'raw', blob)).size)
      unlinkSync(join(this.host.dir, 'raw', blob))
      this.reclaimedBytes.originals += 1; this.reclaimedBytes.bytes += bytes
      flushDirectory(join(this.host.dir, 'raw'))
      this.usage = this.measure()
      return true
    } catch { return false }
  }
  /**
   * Free what is provably rebuildable or already covered, and nothing a reader may still need: every file under `index/` is a
   * cache whose loss costs a rebuild, every checkpoint older than the current and the one before it is a version nothing may be
   * read from, and every file under `staging/` is a commit a crash interrupted. It runs before the store refuses a write and
   * before the service ranks any original, so the cheap space is always freed first.
   */
  reclaim(): number {
    if (!this.writableFlag) return 0
    const freed = this.reclaimCaches() + this.reclaimVersions()
    this.usage = this.measure()
    return freed
  }
  /** How many bytes reclamation may still free without dropping one original: caches, versions and interrupted scratch. */
  reclaimableBytes(): number {
    const dir = this.host.dir
    const index = directoryBytes(join(dir, 'index')), staging = directoryBytes(join(dir, 'staging'))
    const series = names(join(dir, 'published', 'series')).filter(name => /^ck-\d+\.json$/.test(name)).sort()
    const versions = series.slice(0, Math.max(0, series.length - 2))
      .reduce((sum, name) => sum + BLOCKS(statSync(join(dir, 'published', 'series', name)).size), 0)
    return index + staging + versions
  }
  /** Delete the rebuildable index: derived from the version in memory, so its loss costs a rebuild and never a record. */
  private reclaimCaches(): number {
    const dir = join(this.host.dir, 'index')
    let freed = 0
    for (const name of names(dir)) {
      if (!/\.json$/.test(name)) continue
      this.hit('index.drop')
      try {
        const bytes = BLOCKS(statSync(join(dir, name)).size)
        unlinkSync(join(dir, name))
        freed += bytes; this.reclaimedBytes.caches += 1; this.reclaimedBytes.bytes += bytes
      } catch { /* Kept, and freed at the next pass. */ }
    }
    return freed
  }
  /**
   * Delete the versions nothing reads: every checkpoint before the current one and the one before it (a crash during a checkpoint
   * still has a version to fall back on), every segment a named checkpoint already covers, and the scratch a crash interrupted.
   */
  private reclaimVersions(): number {
    let freed = 0
    const series = join(this.host.dir, 'published', 'series'), ranked = names(series).filter(name => /^ck-\d+\.json$/.test(name)).sort()
    for (const name of ranked.slice(0, Math.max(0, ranked.length - 2))) {
      this.hit('checkpoint.drop')
      try {
        const bytes = BLOCKS(statSync(join(series, name)).size)
        unlinkSync(join(series, name))
        freed += bytes; this.reclaimedBytes.versions += 1; this.reclaimedBytes.bytes += bytes
      } catch { /* Kept. */ }
    }
    const staging = join(this.host.dir, 'staging')
    for (const name of names(staging)) {
      try { const bytes = BLOCKS(statSync(join(staging, name)).size); unlinkSync(join(staging, name)); freed += bytes } catch { /* Kept. */ }
    }
    if (this.checkpointSeq > 0) freed += this.dropCoveredSegments()
    return freed
  }
  /** Release the segment handle. Every op is already fsynced, so this flushes nothing and loses nothing. */
  close(): void {
    if (this.fd !== undefined) { try { closeSync(this.fd) } catch { /* The handle is gone either way. */ } this.fd = undefined }
  }
  /** Reach a point of the protocol: the host may die here, which is the only way a crash is injected. */
  private hit(step: MemoryStep): void { this.host.interrupt?.(step) }
  /** Recover: read the manifest, verify the checkpoint it names, replay the journal past it, and sweep what a crash left. */
  private recover(): void {
    // A reader creates nothing: every directory it needs is one the writer already made, and a missing one is an empty store.
    if (this.writableFlag) for (const name of ['journal', 'published', 'published/series', 'raw', 'index', 'staging']) mkdirSync(join(this.host.dir, name), { recursive: true })
    this.emptyStaging()
    const manifest = this.readManifest()
    let checkpointSeq = 0
    if (manifest?.checkpoint) {
      const checkpoint = this.readCheckpoint(manifest)
      if (checkpoint) {
        for (const record of checkpoint.records) this.records.set(record.experience.id, record)
        this.seqNumber = checkpoint.seq; this.versionNumber = checkpoint.version; checkpointSeq = checkpoint.seq
      } else {
        this.problems.push(`the checkpoint ${manifest.checkpoint.file} is missing or does not match the manifest, so the journal was replayed from the start`)
      }
    }
    this.replay()
    this.sweepBlobs()
    this.checkpointSeq = checkpointSeq
    this.openSegment()
  }
  /** The manifest, when it is this build's; a torn first creation is treated as absent, which replays the whole journal. */
  private readManifest(): MemoryManifest | undefined {
    const path = join(this.host.dir, 'published', 'manifest.json')
    if (!existsSync(path)) return undefined
    try {
      const manifest = parseManifest(JSON.parse(readFileSync(path, 'utf8')))
      if (!manifest) this.problems.push('the published manifest is not one this build wrote, so the journal was replayed from the start')
      return manifest
    } catch (error) {
      this.problems.push(`the published manifest could not be read (${String(error)}), so the journal was replayed from the start`)
      return undefined
    }
  }
  /** The checkpoint the manifest names, if its bytes and hash still agree: a checkpoint is complete or absent. */
  private readCheckpoint(manifest: MemoryManifest): MemoryCheckpoint | undefined {
    const named = manifest.checkpoint
    if (!named) return undefined
    try {
      const bytes = readFileSync(join(this.host.dir, 'published', named.file))
      if (bytes.length !== named.bytes || sha256(bytes) !== named.sha256) return undefined
      return parseCheckpoint(JSON.parse(bytes.toString('utf8')))
    } catch { return undefined }
  }
  /**
   * Replay the journal segments in order. The longest prefix of ops whose `seq` advances by exactly one is the state. An unterminated
   * tail — the append a crash interrupted, or the zeroes it left — was never acknowledged, because `commit` fsyncs and only then
   * lets the caller see the version, so recovery drops those bytes and the effect queue redelivers that op. A line that cannot be
   * read anywhere else, or a gap in `seq`, is corruption: the store keeps what it has, serves it, and refuses to write, because
   * destroying unread data to become writable is worse than not writing.
   */
  private replay(): void {
    const segments = this.segments()
    for (const [number, path] of segments.entries()) {
      const last = number === segments.length - 1
      const text = readFileSync(path, 'utf8')
      const terminated = text.split('\n').slice(0, -1)
      let offset = 0
      for (const [index, line] of terminated.entries()) {
        const op = line === '' ? undefined : parseOp(line)
        if (!op || (op.seq !== this.seqNumber + 1 && op.seq > this.seqNumber)) { this.corrupt(`${path}:${index + 1}`); return }
        if (op.seq > this.seqNumber) {
          this.records.set(op.record.experience.id, op.record)
          this.seqNumber = op.seq; this.versionNumber = op.version
        }
        offset += Buffer.byteLength(line, 'utf8') + 1
      }
      // Bytes after the last newline: the crash-interrupted append of this segment, which was never acknowledged.
      if (!text.endsWith('\n') && text.length > 0) {
        if (!last) { this.corrupt(`${path}: after its last complete line`); return }
        this.dropTornTail(path, offset)
      }
    }
  }
  /** Drop the unacknowledged bytes of a torn append, so the next op does not merge with them into one unreadable line. */
  private dropTornTail(path: string, offset: number): void {
    // A reader must not repair what it reads: the writer owns this file, and bytes it cannot truncate are dropped by the writer.
    if (!this.writableFlag) return
    try {
      if (statSync(path).size > offset) truncateSync(path, offset)
    } catch (error) {
      // A truncate another handle blocks can be worked around by sealing the segment out of the journal's way.
      try { renameSync(path, `${path}.torn`) } catch {
        this.writableFlag = false
        this.problems.push(`a torn append in ${path} could be neither dropped nor sealed (${String(error)}): the store refuses to write`)
      }
    }
  }
  private corrupt(where: string): void {
    this.writableFlag = false
    this.problems.push(`the journal is corrupt at ${where}: the store serves the version it has and refuses to write`)
  }
  /** The journal segments, oldest first. The files are the authority; the manifest's list of them is display data. */
  private segments(): string[] {
    const dir = join(this.host.dir, 'journal')
    return names(dir).flatMap(name => { const first = firstSeqOf(name); return first === undefined ? [] : [{ first, path: join(dir, name) }] })
      .sort((left, right) => left.first - right.first).map(segment => segment.path)
  }  /** Empty `staging/`: everything there is a crash's leftover, and no file there is ever read as a version. */
  private emptyStaging(): void {
    if (!this.writableFlag) return
    const dir = join(this.host.dir, 'staging')
    for (const name of names(dir)) { try { unlinkSync(join(dir, name)) } catch { /* A file another handle holds can wait. */ } }
  }
  /**
   * Delete blobs no record references: a blob is written before its op, so a crash between them leaves an orphan. A record whose
   * detail was released references no blob either, which is what lets a crash between an eviction's commit and its deletion finish
   * here: the version that is durable already says the text is gone, so the bytes it left behind are collected on the next open.
   */
  private sweepBlobs(): void {
    if (!this.writableFlag) return
    const referenced = new Set([...this.records.values()].flatMap(record => record.experience.material.form === 'blob'
      && record.representation.detail.available ? [record.experience.material.blob] : []))
    const dir = join(this.host.dir, 'raw')
    for (const name of names(dir)) if (!referenced.has(name)) { try { unlinkSync(join(dir, name)) } catch { /* Swept next time. */ } }
  }
  /** Open the segment the next op appends to: the last one while it has room, otherwise a new one (a create, never a rename). */
  private openSegment(): void {
    const last = this.segments().at(-1)
    const first = last === undefined ? undefined : firstSeqOf(last)
    if (last !== undefined && first !== undefined && statSync(last).size < this.host.limits.segmentBytes) {
      this.segment = { name: last, bytes: statSync(last).size }
      this.fd = openSync(last, 'a')
      return
    }
    this.segment = { name: join(this.host.dir, 'journal', segmentName(this.seqNumber + 1)), bytes: 0 }
    this.fd = openSync(this.segment.name, 'a')
  }
  /** Append one op and fsync it: this is the commit point, and nothing observable changes before it returns. */
  private append(line: string, bytes: number): void {
    if (this.fd === undefined || this.segment.bytes + bytes > this.host.limits.segmentBytes && this.segment.bytes > 0) this.rotate()
    if (this.fd === undefined) throw new Error('The memory journal is not open')
    this.hit('journal.write')
    writeSync(this.fd, line)
    // The write returned and the fsync has not: a crash here leaves bytes the OS may keep whole, tear, or lose, which is why the
    // longest parseable prefix of the journal — and never the last line's existence — is what recovery believes.
    this.hit('journal.sync')
    fsyncSync(this.fd)
    this.segment.bytes += bytes
  }
  /** Seal the current segment and start the next one, which is a create: no file is ever renamed over. */
  private rotate(): void {
    this.hit('segment.rotate')
    if (this.fd !== undefined) { try { closeSync(this.fd) } catch { /* Already closed. */ } this.fd = undefined }
    this.segment = { name: join(this.host.dir, 'journal', segmentName(this.seqNumber + 1)), bytes: 0 }
    this.fd = openSync(this.segment.name, 'a')
    // A new segment's own directory entry is what makes it findable after a power cut, where the platform flushes directories at all.
    flushDirectory(join(this.host.dir, 'journal'))
    try { this.publishManifest() } catch (error) { this.problems.push(`the manifest could not record a sealed segment: ${String(error)}`) }
  }
  /**
   * Whether `bytes` more may be written: reclaim what is rebuildable, then answer. The store refuses rather than growing unbounded;
   * the one exception is a commit that frees space, which may spend the reserve this store keeps for exactly such a commit.
   */
  private reserve(bytes: number, reclaiming = false): boolean {
    const limit = this.host.limits.budgetBytes
    // A file the store grows occupies whole blocks, so a commit may add one block more than its bytes; counting that is what keeps
    // the measured total inside the budget after the write rather than only before it.
    const grows = Math.ceil(bytes / BLOCK) * BLOCK + BLOCK
    const held = reclaiming ? 0 : reserveOf(limit)
    if (this.usage.total + grows + held <= limit) return true
    this.reclaim()
    this.usage = this.measure()
    return this.usage.total + grows + held <= limit
  }
  /**
   * Write a checkpoint and its manifest when the tail is long enough, or when a caller asks for the first version. Both are derived
   * index data: the op that prompted them is already fsynced, so a publication that cannot be completed costs a slower next open and
   * must never fail the commit that prompted it. Nothing a checkpoint covers is deleted until a manifest actually names it, because
   * until that rename returns the journal is the only copy of those ops.
   */
  private maybeCheckpoint(force: boolean): void {
    if (!this.writableFlag || this.seqNumber === this.checkpointSeq) return
    if (!force && this.seqNumber - this.checkpointSeq < this.host.limits.checkpointOps) return
    try {
      const at = this.host.now()
      // Seal the current segment first, so the checkpoint's ops are in a segment that can be dropped whole.
      this.rotate()
      const checkpoint: MemoryCheckpoint = { format: MEMORY_FORMAT, seq: this.seqNumber, version: this.versionNumber, at, policy: POLICY_VERSION,
        records: [...this.records.values()] }
      const bytes = Buffer.from(`${JSON.stringify(checkpoint)}\n`, 'utf8')
      const name = `ck-${pad(this.seqNumber)}.json`
      this.replace(join(this.host.dir, 'published', 'series', name), bytes, ['checkpoint.write', 'checkpoint.rename'])
      this.publishManifest({ file: `series/${name}`, seq: this.seqNumber, bytes: bytes.length, sha256: sha256(bytes) })
      // Only a checkpoint a manifest actually names may authorize dropping a segment: until that rename returns, the journal is the
      // only copy of those ops, and a lost rename would turn a confirmed version into a corrupt journal.
      this.checkpointSeq = this.seqNumber
      this.dropCoveredSegments()
      this.usage = this.measure()
    } catch (error) {
      this.problems.push(`a checkpoint could not be published (${String(error)}): the journal still holds what it would cover`)
    }
  }
  /** Write the manifest, naming the checkpoint and the segments the writer has sealed. The one file replaced by rename. */
  private publishManifest(checkpoint?: MemoryManifest['checkpoint']): void {
    const held = checkpoint ?? this.readManifest()?.checkpoint
    const valid = held && existsSync(join(this.host.dir, 'published', held.file)) ? held : undefined
    const segments = this.segments().flatMap(path => {
      const first = firstSeqOf(path)
      if (first === undefined) return []
      const bytes = readFileSync(path)
      return [{ file: `journal/${segmentName(first)}`, firstSeq: first, bytes: bytes.length, sha256: sha256(bytes) }]
    })
    const manifest: MemoryManifest = { format: MEMORY_FORMAT, version: this.versionNumber, seq: this.seqNumber, at: this.host.now(),
      ...(valid ? { checkpoint: valid } : {}), segments }
    this.replace(join(this.host.dir, 'published', 'manifest.json'), Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8'),
      ['manifest.write', 'manifest.rename'])
  }
  /** Drop the segments a checkpoint covers, which is how the journal stays bounded. Failure keeps them: replay guards against them. */
  /**
   * Drop the segments a checkpoint covers, which is how the journal stays bounded, and answer how many bytes that freed. Each
   * one is a version nothing may be read from any more, so it is counted with the versions reclamation freed.
   */
  private dropCoveredSegments(): number {
    let freed = 0
    for (const path of this.segments().slice(0, -1)) {
      const first = firstSeqOf(path)
      if (first !== undefined && first <= this.checkpointSeq) {
        this.hit('segment.drop')
        try {
          const bytes = BLOCKS(statSync(path).size)
          unlinkSync(path)
          freed += bytes; this.reclaimedBytes.versions += 1; this.reclaimedBytes.bytes += bytes
        } catch { /* Dropped at the next checkpoint. */ }
      }
    }
    return freed
  }
  /**
   * Replace a file in one step: a staging file, fsynced, then renamed over the target. The rename is retried, because Windows
   * refuses one while another handle — an indexer, a reader — holds the target open. A lost rename leaves the previous file,
   * which is always a complete earlier version, so the retry is about progress and not about correctness. `steps` names the two
   * points a crash can interrupt, so a test dies exactly between the bytes and the name.
   */
  private replace(path: string, bytes: Buffer, steps: readonly [MemoryStep, MemoryStep]): void {
    const staging = join(this.host.dir, 'staging', `${process.pid}-${Math.random().toString(36).slice(2)}.tmp`)
    this.hit(steps[0])
    const fd = openSync(staging, 'wx', 0o600)
    try { writeSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
    for (let attempt = 0; ; attempt++) {
      try { this.hit(steps[1]); renameSync(staging, path); flushDirectory(dirname(path)); return } catch (error) {
        const code = (error as { code?: string }).code
        const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
        if (!retryable || attempt >= 2) { try { unlinkSync(staging) } catch { /* Left for the next open. */ } throw error }
        pause(10 * 3 ** attempt)
      }
    }
  }
  /** Account for what the memory root holds, class by class. Derived from the filesystem and the records, never from a counter. */
  private measure(): MemoryUsage {
    const dir = this.host.dir
    const raw = directoryBytes(join(dir, 'raw')), journal = directoryBytes(join(dir, 'journal'))
    const history = directoryBytes(join(dir, 'published', 'series')), temporary = directoryBytes(join(dir, 'staging'))
    const index = directoryBytes(join(dir, 'index'))
    // Summaries and cues live inside the recorded representations, not in files of their own, so they are counted as they are.
    const summaries = [...this.records.values()].reduce((sum, record) => sum
      + Buffer.byteLength(JSON.stringify({ ...record.representation, cues: [] }), 'utf8'), 0)
    // The manifest itself is a file the store always keeps; it is small and counted with the history it indexes.
    const manifest = existsSync(join(dir, 'published', 'manifest.json')) ? BLOCKS(statSync(join(dir, 'published', 'manifest.json')).size) : 0
    const total = raw + journal + history + temporary + index + summaries + manifest
    return { raw, summaries, index, journal, history: history + manifest, temporary, total }
  }
}
/**
 * Bytes held back from the budget for the store's own commit: staging, a manifest, and one journal line. It is never smaller than
 * three blocks, because a commit pads its line up to a block and may add one more, and a reserve smaller than that could leave the
 * store unable to write the very op that frees space.
 */
const reserveOf = (limit: number): number => Math.max(3 * BLOCK, Math.floor(limit * COMMIT_RESERVE))
/**
 * The payload bytes that may wait in the durable queue for this store before its receiving boundary starts refusing captures: the
 * whole budget, because a queue that could not hold one capture of the size a full store back-pressures would refuse every such
 * capture instead of waiting for room, which leaves the memory's persisted bytes at three budgets rather than growing a second one —
 * the files, the queue, and the redelivery position a refused capture waits at, which is bounded by this same share.
 */
export const pendingBytesOf = (budgetBytes: number): number => Math.max(BLOCK, budgetBytes)
/** Whether two records are the same publication, which is what makes a redelivery a no-op rather than a second op. */
const sameRecord = (left: MemoryRecord, right: MemoryRecord): boolean => JSON.stringify(left.experience) === JSON.stringify(right.experience)
  && JSON.stringify(left.representation) === JSON.stringify(right.representation)
  && JSON.stringify(left.importance) === JSON.stringify(right.importance)
/** The segment name a first-op seq starts, which a crash test writes a torn line into. */
export const journalNameOf = (firstSeq: number): string => segmentName(firstSeq)
