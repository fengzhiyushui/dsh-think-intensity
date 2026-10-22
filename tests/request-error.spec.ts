import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { EffortBlacklist } from '../src/blacklist.js'
import { registerRequestErrorHook, type HookDeps } from '../src/hooks/request-error.js'
import { DecisionLog } from '../src/observability/decision-log.js'
import { StatsCollector } from '../src/observability/stats.js'
import type { LoggerLike } from '../src/types.js'

type Listener = (
  payload: Record<string, unknown>,
  next: () => Promise<unknown>,
) => Promise<unknown>

interface Captured {
  listener: Listener
  options?: { prepend?: boolean; global?: boolean }
}

function fakeCtx(): { ctx: Context; captured: Captured } {
  const captured: Captured = {} as Captured
  const ctx = {
    on: (event: string, listener: Listener, options?: Captured['options']) => {
      expect(event).toBe('agent/request-error')
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

function setup() {
  const blacklist = new EffortBlacklist()
  const logger = stubLogger()
  const decisions = new DecisionLog(logger)
  const { ctx, captured } = fakeCtx()
  const deps: HookDeps = { llm: {} as never, logger, blacklist, decisions, stats: new StatsCollector(undefined, 60_000) }
  registerRequestErrorHook(ctx, deps)
  return { captured, blacklist, logger }
}

const UNSUPPORTED_FAILURE = {
  code: 'UNSUPPORTED_REASONING_EFFORT',
  message: 'provider "my-gateway" model "m-1" does not support reasoning effort "max"',
}

describe('agent/request-error 钩子（M2.3 自愈降级）', () => {
  it('注册选项为 global', () => {
    const { captured } = setup()
    expect(captured.options).toEqual({ global: true })
  })

  it('场景 7：UNSUPPORTED_REASONING_EFFORT → 解析并加入会话内黑名单，动作原样委派', async () => {
    const { captured, blacklist, logger } = setup()
    let delegated = false
    const action = await captured.listener(
      { provider: 'my-gateway', failure: UNSUPPORTED_FAILURE, agent: { session: { header: { id: 'sess-9' } } } },
      async () => { delegated = true; return { kind: 'retry' } },
    )
    expect(delegated).toBe(true)
    expect(action).toEqual({ kind: 'retry' })
    expect(blacklist.blocks('sess-9', 'my-gateway', 'm-1', 'max')).toBe(true)
    expect(blacklist.blocks('sess-9', 'my-gateway', 'm-1', 'high')).toBe(false)
    expect(logger.lines[0]).toContain('"kind":"blacklist-add"')
    expect(logger.lines[0]).toContain('"to":"max"')
    expect(logger.lines[0]).toContain('"reason":"unsupported"')
  })

  it('其他错误码 → 不拉黑，原样委派', async () => {
    const { captured, blacklist } = setup()
    await captured.listener(
      { provider: 'p', failure: { code: 'PROVIDER_ERROR', message: 'boom' }, agent: { session: { header: { id: 's' } } } },
      async () => undefined,
    )
    expect(blacklist.blocks('s', 'p', 'm', 'any')).toBe(false)
  })

  it('消息不可解析 → 不拉黑，不抛错', async () => {
    const { captured, blacklist } = setup()
    await captured.listener(
      { provider: 'p', failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'weird shape' }, agent: { session: { header: { id: 's' } } } },
      async () => undefined,
    )
    expect(blacklist.blocks('s', 'p', 'm', 'x')).toBe(false)
  })

  it('载荷缺失 agent/session → 归入空会话桶，仍拉黑', async () => {
    const { captured, blacklist } = setup()
    await captured.listener(
      { provider: 'p', failure: UNSUPPORTED_FAILURE },
      async () => undefined,
    )
    expect(blacklist.blocks('', 'my-gateway', 'm-1', 'max')).toBe(true)
  })

  it('红线 4：观察路径异常 → 吞掉并委派 next', async () => {
    const { captured } = setup()
    // payload.failure 为 null 时 typeof 检查短路不抛；构造一个 code getter 抛错的对象逼近异常路径
    const hostile = { get code(): string { throw new Error('boom') }, message: 'x' }
    const action = await captured.listener({ failure: hostile }, async () => 'delegated')
    expect(action).toBe('delegated')
  })
})
