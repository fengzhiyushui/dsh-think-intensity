import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { EffortBlacklist } from '../src/blacklist.js'
import { registerStreamObserverHook, type HookDeps } from '../src/observability/stream-observer.js'
import { DecisionLog } from '../src/observability/decision-log.js'
import { StatsCollector } from '../src/observability/stats.js'
import type { LlmFacadeLike, LoggerLike } from '../src/types.js'

type StreamListener = (
  options: Record<string, unknown>,
  next: () => AsyncIterable<unknown>,
) => AsyncIterable<unknown>

interface Captured {
  listener: StreamListener
  options?: { prepend?: boolean; global?: boolean }
}

function fakeCtx(): { ctx: Context; captured: Captured } {
  const captured: Captured = {} as Captured
  const ctx = {
    on: (event: string, listener: StreamListener, options?: Captured['options']) => {
      expect(event).toBe('llm/stream')
      captured.listener = listener
      captured.options = options
      return () => true
    },
  } as unknown as Context
  return { ctx, captured }
}

function stubLogger(): LoggerLike & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    info: (...args: unknown[]) => {
      const [template, ...rest] = args.map(String)
      lines.push(template.replace(/%s/g, () => rest.shift() ?? '%s'))
    },
  }
}

interface StatCall {
  effort?: string
  finish: string
  durationMs: number
  reasoningTokens?: number
  outputTokens?: number
  inputTokens?: number
  purpose?: string
  provider: string
  model: string
  sessionId: string
}

function setup() {
  const calls: StatCall[] = []
  const logger = stubLogger()
  const decisions = new DecisionLog(logger)
  const stats = new StatsCollector(undefined, 60_000)
  const spy = { record: (entry: StatCall) => { calls.push(entry) } }
  const deps: HookDeps = {
    llm: {} as LlmFacadeLike,
    logger,
    blacklist: new EffortBlacklist(),
    decisions,
    stats: spy as unknown as StatsCollector,
  }
  const { ctx, captured } = fakeCtx()
  registerStreamObserverHook(ctx, deps)
  return { captured, calls }
}

function chunkStream(chunks: unknown[]): AsyncIterable<unknown> {
  return (async function* () { for (const chunk of chunks) yield chunk })()
}

function throwingStream(error: Error): AsyncIterable<unknown> {
  return (async function* () { throw error })()
}

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

const OK_CHUNKS = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'hi' },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 5 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

describe('llm/stream 观测钩子（M3.1 零侵入观测）', () => {
  it('注册选项为 global', () => {
    const { captured } = setup()
    expect(captured.options).toEqual({ global: true })
  })

  it('分片逐块原样透传（零侵入）', async () => {
    const { captured } = setup()
    const out = await collect(captured.listener({ provider: 'p', model: 'm' }, () => chunkStream(OK_CHUNKS)))
    expect(out).toEqual(OK_CHUNKS)
  })

  it('usage + finish + 耗时被采集', async () => {
    const { captured, calls } = setup()
    await collect(captured.listener({ provider: 'p', model: 'm' }, () => chunkStream(OK_CHUNKS)))
    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call.reasoningTokens).toBe(5)
    expect(call.outputTokens).toBe(20)
    expect(call.inputTokens).toBe(10)
    expect(call.finish).toBe('ok')
    expect(call.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('error finish → finish=error', async () => {
    const { captured, calls } = setup()
    const chunks = [
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'error', failure: { code: 'X', message: 'y' } } },
    ]
    await collect(captured.listener({ provider: 'p', model: 'm' }, () => chunkStream(chunks)))
    expect(calls[0].finish).toBe('error')
  })

  it('aborted finish → finish=aborted', async () => {
    const { captured, calls } = setup()
    const chunks = [{ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'x' } } }]
    await collect(captured.listener({ provider: 'p', model: 'm' }, () => chunkStream(chunks)))
    expect(calls[0].finish).toBe('aborted')
  })

  it('源流抛错 → 原样上抛 + finish 记 error', async () => {
    const { captured, calls } = setup()
    await expect(
      collect(captured.listener({ provider: 'p', model: 'm' }, () => throwingStream(new Error('stream died')))),
    ).rejects.toThrow('stream died')
    expect(calls).toHaveLength(1)
    expect(calls[0].finish).toBe('error')
  })

  it('effort 惰性读取：内层注入在 finally 时可见', async () => {
    const { captured, calls } = setup()
    // 模拟更内层的 purpose 注入：next() 返回的流开始迭代后才写入 options
    const options: Record<string, unknown> = { provider: 'p', model: 'm' }
    const next = async function* () {
      options.reasoningEffort = 'low'
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    await collect(captured.listener(options, next))
    expect(calls[0].effort).toBe('low')
  })

  it('purpose 透传到统计条目', async () => {
    const { captured, calls } = setup()
    await collect(captured.listener(
      { provider: 'p', model: 'm', purpose: 'compaction', sessionId: 's1' },
      () => chunkStream(OK_CHUNKS),
    ))
    expect(calls[0].purpose).toBe('compaction')
    expect(calls[0].sessionId).toBe('s1')
  })

  it('未知 finish kind → finish=ok（合并可扩展联合的 fall through）', async () => {
    const { captured, calls } = setup()
    const chunks = [{ type: 'finish', reason: { kind: 'future-kind' } }]
    await collect(captured.listener({ provider: 'p', model: 'm' }, () => chunkStream(chunks)))
    expect(calls[0].finish).toBe('ok')
  })

  it('单块观测异常不打断转发（getter 抛错的 chunk）', async () => {
    const { captured, calls } = setup()
    const hostile = {
      get type(): string { throw new Error('chunk exploded') },
    }
    const out = await collect(captured.listener(
      { provider: 'p', model: 'm' },
      () => chunkStream([hostile, { type: 'finish', reason: { kind: 'stop' } }]),
    ))
    expect(out).toHaveLength(2)
    expect(calls).toHaveLength(1)
  })

  it('stats.record 抛错 → 不冒泡（观测路径异常隔离）', async () => {
    const logger = stubLogger()
    const decisions = new DecisionLog(logger)
    const stats = { record: () => { throw new Error('record exploded') } }
    const deps: HookDeps = {
      llm: {} as LlmFacadeLike,
      logger,
      blacklist: new EffortBlacklist(),
      decisions,
      stats: stats as unknown as StatsCollector,
    }
    const { ctx, captured } = fakeCtx()
    registerStreamObserverHook(ctx, deps)
    const out = await collect(captured.listener({ provider: 'p', model: 'm' }, () => chunkStream(OK_CHUNKS)))
    expect(out).toEqual(OK_CHUNKS)
  })
})
