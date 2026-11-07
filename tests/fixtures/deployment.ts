/** Default deployment and machine fixtures for tests. */
import type { Volatile } from '@deepseek-ai/cordis'
import type { Deployment, Machine } from '../../src/deployment.ts'

/** Mutable Volatile reference for simulating live configuration updates. */
export const reference = <T>(value: T): Volatile<T> & { set(next: T): void } => {
  let current = value
  return { get: () => current as never, set: next => { current = next } }
}
export const testMachine = (overrides: Partial<Machine> = {}): Machine => ({
  stateDir: '/tmp/dsh-superagent-test', promptMaxChars: reference(100000), admissionContextMaxPages: reference(10),
  admissionContextTimeoutMs: reference(15000), requestMaxChars: reference(400_000), requestOutputReserveChars: reference(32_000),
  requestMeasurementReserveChars: reference(8000), memoryBudgetBytes: reference(67_108_864), memoryRecallMaxChars: reference(4000),
  memoryRecallWakes: reference(8), memoryRecallWindowMs: reference(1_800_000), memoryPendingMaxItems: reference(256),
  memoryRedeliveryMaxItems: reference(64),
  memoryBackgroundMaxCalls: reference(8), memoryBackgroundBatch: reference(8), memoryBackgroundConcurrency: reference(1),
  memoryBackgroundPending: reference(256), memoryBackgroundTimeoutMs: reference(60_000), memoryBackgroundAttempts: reference(2),
  // A test deployment mounts no sandbox, so it can prove no boundary around the memory files: it writes only because the operator
  // said so. A test that is about the boundary itself overrides this with `reference('require')`.
  memoryWriteMode: reference('waive'),
  ...overrides,
})
export const testDeployment = (overrides: Partial<Deployment> = {}): Deployment => ({
  ...testMachine(), repository: 'acme/widgets',
  github: { cli: '/bin/false', login: 'agent-bot', noreply: '7+agent-bot@users.noreply.github.com' },
  feishu: { cli: '/bin/false', botId: 'ou_bot', appId: 'cli_bot', brand: 'feishu', name: 'Widgets Bot' },
  ...overrides,
})
