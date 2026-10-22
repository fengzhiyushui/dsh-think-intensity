import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { EffortBlacklist } from '../src/blacklist.js'
import { registerAgentRequestHook, type HookDeps } from '../src/hooks/agent-request.js'
import { DecisionLog } from '../src/observability/decision-log.js'
import { StatsCollector } from '../src/observability/stats.js'
import type { LlmFacadeLike, LoggerLike, ResolvedModelInfoLike, StrategyConfig } from '../src/types.js'

type Listener = (
  payload: Record<string, unknown>,
  next: () => Promise<Record<string, unknown>>,
) => Promise<Record<string, unknown>>

interface Captured {
  listener: Listener
  options?: { prepend?: boolean; global?: boolean }
}

function fakeCtx(): { ctx: Context; captured: Captured } {
  const captured: Captured = {} as Captured
  const ctx = {
    on: (event: string, listener: Listener, options?: Captured['options']) => {
      expect(event).toBe('agent/request')
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

interface Fixture {
  info: ResolvedModelInfoLike | Error
}

function llmOf(f: Fixture): LlmFacadeLike {
  return {
    resolveModelInfo: () => (f.info instanceof Error ? Promise.reject(f.info) : Promise.resolve(f.info)),
  }
}

const BASE_CONFIG: StrategyConfig = { defaultLevel: 'high', providers: [] }
const EFFORTS: ResolvedModelInfoLike = { reasoning: { efforts: [{ id: 'off' }, { id: 'high' }, { id: 'max' }] } }
const SUBAGENT_PAYLOAD = { agent: { session: { header: { origin: 'subagent', id: 'sess-42' } } } }

function run(
  seed: Record<string, unknown>,
  fixture: Fixture,
  config: StrategyConfig = BASE_CONFIG,
  payloadExtra: Record<string, unknown> = {},
  blacklist: EffortBlacklist = new EffortBlacklist(),
) {
  const order: string[] = []
  const llm: LlmFacadeLike = {
    resolveModelInfo: () => {
      order.push('resolveModelInfo')
      return fixture.info instanceof Error ? Promise.reject(fixture.info) : Promise.resolve(fixture.info)
    },
  }
  const logger = stubLogger()
  const decisions = new DecisionLog(logger)
  const { ctx, captured } = fakeCtx()
  const deps: HookDeps = { llm, logger, blacklist, decisions, stats: new StatsCollector(undefined, 60_000) }
  registerAgentRequestHook(ctx, deps, () => config)
  return captured.listener(payloadExtra, async () => {
    order.push('next')
    return { ...seed }
  }).then((result) => ({ result, order, logger }))
}

describe('agent/request 钩子', () => {
  it('注册选项为 prepend + global', () => {
    const { ctx, captured } = fakeCtx()
    const logger = stubLogger()
    const deps: HookDeps = { llm: llmOf({}), logger, blacklist: new EffortBlacklist(), decisions: new DecisionLog(logger), stats: new StatsCollector(undefined, 60_000) }
    registerAgentRequestHook(ctx, deps, () => BASE_CONFIG)
    expect(captured.options).toEqual({ prepend: true, global: true })
  })

  it('红线 1：先 await next() 再调用能力守卫', async () => {
    const { order } = await run({ provider: 'p', model: 'm' }, { info: EFFORTS })
    expect(order).toEqual(['next', 'resolveModelInfo'])
  })

  it('场景 3：没选档 + 模型支持 → 注入默认档', async () => {
    const { result, logger } = await run({ provider: 'p', model: 'm' }, { info: EFFORTS })
    expect(result).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' })
    expect(logger.lines[0]).toContain('"kind":"inject"')
    expect(logger.lines[0]).toContain('"to":"high"')
    expect(logger.lines[0]).toContain('"reason":"default"')
  })

  it('场景 5：种子已有显式档位（off）→ 原样返回，不打扰', async () => {
    const seed = { provider: 'p', model: 'm', reasoningEffort: 'off' }
    const { result } = await run(seed, { info: EFFORTS })
    expect(result).toEqual(seed)
  })

  it('场景 1：模型无档位、种子无档位 → 不注入不报错', async () => {
    const seed = { provider: 'p', model: 'm' }
    const { result } = await run(seed, { info: {} })
    expect(result).toEqual(seed)
  })

  it('零配置且种子无档位 → 短路放行，不解析模型信息', async () => {
    const seed = { provider: 'p', model: 'm' }
    const empty: StrategyConfig = { defaultLevel: undefined, providers: [], purposeLevels: {} }
    const { result, order } = await run(seed, { info: EFFORTS }, empty)
    expect(result).toEqual(seed)
    expect(order).toEqual(['next'])
  })

  it('场景 6：非推理模型 + 种子继承档位 → 剥离 reasoningEffort', async () => {
    const seed = { provider: 'p', model: 'm', reasoningEffort: 'high' }
    const { result, logger } = await run(seed, { info: {} })
    expect(result).toEqual({ provider: 'p', model: 'm' })
    expect(Object.prototype.hasOwnProperty.call(result, 'reasoningEffort')).toBe(false)
    expect(logger.lines[0]).toContain('"kind":"strip"')
    expect(logger.lines[0]).toContain('"reason":"no-capability"')
  })

  it('红线 6：白名单外路由不注入', async () => {
    const config: StrategyConfig = { defaultLevel: 'high', providers: ['other'] }
    const { result } = await run({ provider: 'p', model: 'm' }, { info: EFFORTS }, config)
    expect(result).toEqual({ provider: 'p', model: 'm' })
  })

  it('红线 4：守卫异常 → 吞掉并放行原请求', async () => {
    const seed = { provider: 'p', model: 'm' }
    const { result } = await run(seed, { info: new Error('gateway down') })
    expect(result).toEqual(seed)
  })

  it('next() 自身失败 → 原样上抛（不吞宿主错误）', async () => {
    const { ctx, captured } = fakeCtx()
    const logger = stubLogger()
    const deps: HookDeps = { llm: llmOf({}), logger, blacklist: new EffortBlacklist(), decisions: new DecisionLog(logger), stats: new StatsCollector(undefined, 60_000) }
    registerAgentRequestHook(ctx, deps, () => BASE_CONFIG)
    await expect(
      captured.listener({}, async () => { throw new Error('host assembly failed') }),
    ).rejects.toThrow('host assembly failed')
  })

  it('M2.1：子 agent 会话注入 subagentLevel（优先于 defaultLevel）', async () => {
    const config: StrategyConfig = { defaultLevel: 'high', subagentLevel: 'max', providers: [] }
    const { result, logger } = await run(
      { provider: 'p', model: 'm' }, { info: EFFORTS }, config, SUBAGENT_PAYLOAD,
    )
    expect(result).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'max' })
    expect(logger.lines[0]).toContain('"reason":"subagent"')
    expect(logger.lines[0]).toContain('"to":"max"')
  })

  it('M2.1：子 agent 会话但未配置 subagentLevel → 回落 defaultLevel', async () => {
    const { result } = await run(
      { provider: 'p', model: 'm' }, { info: EFFORTS }, BASE_CONFIG, SUBAGENT_PAYLOAD,
    )
    expect(result).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' })
  })

  it('M2.1：子 agent 已显式选档 → 不打扰', async () => {
    const config: StrategyConfig = { defaultLevel: 'high', subagentLevel: 'max', providers: [] }
    const seed = { provider: 'p', model: 'm', reasoningEffort: 'off' }
    const { result } = await run(seed, { info: EFFORTS }, config, SUBAGENT_PAYLOAD)
    expect(result).toEqual(seed)
  })

  it('场景 7（前半）：黑名单命中的档位不注入，等待下次自然降级', async () => {
    const blacklist = new EffortBlacklist()
    blacklist.add('sess-42', 'p', 'm', 'high')
    const { result, logger } = await run(
      { provider: 'p', model: 'm' }, { info: EFFORTS }, BASE_CONFIG, { agent: { session: { header: { id: 'sess-42' } } } }, blacklist,
    )
    expect(result).toEqual({ provider: 'p', model: 'm' })
    expect(logger.lines[0]).toContain('"kind":"skip"')
    expect(logger.lines[0]).toContain('"reason":"blacklist"')
  })

  it('场景 7（隔离）：黑名单只影响同会话，其他会话照常注入', async () => {
    const blacklist = new EffortBlacklist()
    blacklist.add('sess-other', 'p', 'm', 'high')
    const { result } = await run(
      { provider: 'p', model: 'm' }, { info: EFFORTS }, BASE_CONFIG, { agent: { session: { header: { id: 'sess-42' } } } }, blacklist,
    )
    expect(result).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' })
  })
})
