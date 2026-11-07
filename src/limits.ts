/** Validation bounds shared between host schemas and management panel forms. */
export const LIMITS = {
  ruleName: 100,
  ruleInstruction: 2000,
  evalTimeoutSeconds: { min: 30, max: 600 },
  maxWorkers: { min: 1, max: 16 },
  prepareCommand: 4000,
  promptMaxChars: { min: 1000, max: 1_000_000 },
  admissionContextMaxPages: { min: 1, max: 100 },
  admissionContextTimeoutMs: { min: 1, max: 90_000 },
  requestMaxChars: { min: 1000, max: 10_000_000 },
  requestReserveChars: { min: 0, max: 1_000_000 },
  memoryBudgetBytes: { min: 65_536, max: 68_719_476_736 },
  memoryRecallMaxChars: { min: 0, max: 20_000 },
  /**
   * The bounds of the allowance automatic reactivation runs under: the notices one window holds, and how long a window is. A window of
   * a second is the smallest that still replenishes, and one of a day the largest that still bounds a working stretch.
   */
  memoryRecallWakes: { min: 1, max: 64 },
  memoryRecallWindowMs: { min: 1_000, max: 86_400_000 },
  /** How many captures may wait for the memory store to accept them; their payload bytes are bounded by a share of the budget. */
  memoryPendingMaxItems: { min: 1, max: 10_000 },
  /** How many captures the receiving boundary refused may wait at the redelivery position; their payload bytes are bounded by the
   * same share of the budget, and the oldest are evicted — and counted as lost — past either bound. */
  memoryRedeliveryMaxItems: { min: 1, max: 10_000 },
  /** The bounds the long-term memory's background work runs under: its model calls, its parallelism, its queue and its patience. */
  memoryBackgroundMaxCalls: { min: 1, max: 100 },
  memoryBackgroundBatch: { min: 1, max: 100 },
  memoryBackgroundConcurrency: { min: 1, max: 4 },
  memoryBackgroundPending: { min: 1, max: 10_000 },
  memoryBackgroundTimeoutMs: { min: 1_000, max: 600_000 },
  memoryBackgroundAttempts: { min: 1, max: 10 },
  /** The answers to whether long-term memory writes need a boundary that keeps an agent shell out of the memory files. */
  memoryWriteMode: ['require', 'waive'],
} as const

/** Whether long-term memory writes need a proven isolation boundary (`require`), or are written without one (`waive`). */
export type MemoryWriteMode = (typeof LIMITS.memoryWriteMode)[number]
