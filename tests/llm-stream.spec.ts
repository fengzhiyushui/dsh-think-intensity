import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { EffortBlacklist } from '../src/blacklist.js'
import { registerLlmStreamHook, type HookDeps } from '../src/hooks/llm-stream.js'
import { DecisionLog } from '../src/observability/decision-log.js'
import { StatsCollector } from '../src/observability/stats.js'
import type { LlmFacadeLike, LoggerLike, ResolvedModelInfoLike, StrategyConfig } from '../src/types.js'

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

const EFFORTS: ResolvedModelInfoLike = { reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }] } }

const PURPOSE_CONFIG: StrategyConfig = {
  defaultLevel: undefined,
  providers: [],
  purposeLevels: { compaction: 'low', 'session-title': 'low' },
}

function chunks(): AsyncIterable<unknown> {
  return (async function* () { yield 'chunk-1'; yield 'chunk-2' })()
}

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

function setup(
  info: ResolvedModelInfoLike | Error,
  config: StrategyConfig = PURPOSE_CONFIG,
  blacklist: EffortBlacklist = new EffortBlacklist(),
) {
  const llm: LlmFacadeLike = {
    resolveModelInfo: () => (info instanceof Error ? Promise.reject(info) : Promise.resolve(info)),
  }
  const logger = stubLogger()
  const decisions = new DecisionLog(logger)
  const { ctx, captured } = fakeCtx()
  const deps: HookDeps = { llm, logger, blacklist, decisions, stats: new StatsCollector(undefined, 60_000) }
  registerLlmStreamHook(ctx, deps, () => config)
  return { captured, logger }
}

describe('llm/stream 钩子（M2.2 purpose 分档）', () => {
  it('注册选项为 global（只观察 + 终端前变更，无需 prepend）', () => {
    const { captured } = setup(EFFORTS)
    expect(captured.options).toEqual({ global: true })
  })

  it('compaction 调用 + 未冻结 + 模型支持 → 注入 purposeLevels 配置档', async () => {
    const { captured, logger } = setup(EFFORTS)
    const options: Record<string, unknown> = { provider: 'p', model: 'm', purpose: 'compaction' }
    const out = await collect(captured.listener(options, chunks))
    expect(out).toEqual(['chunk-1', 'chunk-2'])
    expect(options.reasoningEffort).toBe('low')
    expect(logger.lines[0]).toContain('"reason":"purpose:compaction"')
    expect(logger.lines[0]).toContain('"to":"low"')
  })

  it('红线 7：冻结的 options 只读放行（主对话请求）', async () => {
    const { captured } = setup(EFFORTS)
    const options = Object.freeze({ provider: 'p', model: 'm', purpose: 'compaction' })
    const out = await collect(captured.listener(options, chunks))
    expect(out).toEqual(['chunk-1', 'chunk-2'])
  })

  it('红线 2：显式档位已设 → 不打扰', async () => {
    const { captured } = setup(EFFORTS)
    const options: Record<string, unknown> = { provider: 'p', model: 'm', purpose: 'compaction', reasoningEffort: 'high' }
    await collect(captured.listener(options, chunks))
    expect(options.reasoningEffort).toBe('high')
  })

  it('普通对话请求（无 purpose）→ 不干预', async () => {
    const { captured } = setup(EFFORTS)
    const options: Record<string, unknown> = { provider: 'p', model: 'm' }
    await collect(captured.listener(options, chunks))
    expect('reasoningEffort' in options).toBe(false)
  })

  it('purpose 未配置档位 → 不干预', async () => {
    const { captured } = setup(EFFORTS, { defaultLevel: undefined, providers: [], purposeLevels: {} })
    const options: Record<string, unknown> = { provider: 'p', model: 'm', purpose: 'compaction' }
    await collect(captured.listener(options, chunks))
    expect('reasoningEffort' in options).toBe(false)
  })

  it('红线 3：模型 efforts 不含目标档 → 不注入', async () => {
    const { captured } = setup(EFFORTS)
    const options: Record<string, unknown> = { provider: 'p', model: 'm', purpose: 'compaction' }
    const strictConfig = { defaultLevel: undefined, providers: [], purposeLevels: { compaction: 'max' } }
    const strict = setup(EFFORTS, strictConfig)
    await collect(strict.captured.listener(options, chunks))
    expect('reasoningEffort' in options).toBe(false)
  })

  it('红线 6：白名单外路由不注入', async () => {
    const config: StrategyConfig = { defaultLevel: undefined, providers: ['other'], purposeLevels: { compaction: 'low' } }
    const { captured } = setup(EFFORTS, config)
    const options: Record<string, unknown> = { provider: 'p', model: 'm', purpose: 'compaction' }
    await collect(captured.listener(options, chunks))
    expect('reasoningEffort' in options).toBe(false)
  })

  it('场景 7：黑名单命中的 purpose 档不注入', async () => {
    const blacklist = new EffortBlacklist()
    blacklist.add('sess-1', 'p', 'm', 'low')
    const { captured, logger } = setup(EFFORTS, PURPOSE_CONFIG, blacklist)
    const options: Record<string, unknown> = { provider: 'p', model: 'm', purpose: 'compaction', sessionId: 'sess-1' }
    await collect(captured.listener(options, chunks))
    expect('reasoningEffort' in options).toBe(false)
    expect(logger.lines[0]).toContain('"kind":"skip"')
    expect(logger.lines[0]).toContain('"reason":"blacklist"')
  })

  it('红线 4：守卫抛错 → 吞掉，流照常返回', async () => {
    const { captured } = setup(new Error('metadata unavailable'))
    const options: Record<string, unknown> = { provider: 'p', model: 'm', purpose: 'compaction' }
    const out = await collect(captured.listener(options, chunks))
    expect(out).toEqual(['chunk-1', 'chunk-2'])
    expect('reasoningEffort' in options).toBe(false)
  })

  it('注入发生在 next() 委派之前（变更先于适配器查找）', async () => {
    const { captured } = setup(EFFORTS)
    const options: Record<string, unknown> = { provider: 'p', model: 'm', purpose: 'compaction' }
    let seenByNext: unknown
    const next = async function* () { seenByNext = (options as { reasoningEffort?: string }).reasoningEffort }
    await collect(captured.listener(options, next))
    expect(seenByNext).toBe('low')
  })
})
