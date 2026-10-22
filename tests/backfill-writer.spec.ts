import { describe, expect, it, vi } from 'vitest'
import { BackfillWriter, type SettingsFacadeLike, type SettingsDescriptorLike } from '../src/backfill/writer.js'
import { DecisionLog } from '../src/observability/decision-log.js'
import type { LoggerLike } from '../src/types.js'

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

/** 可控的 settings 假件：记录 mutate 调用，可编程失败。 */
function fakeSettings(overrides: {
  user?: unknown
  revision?: number
  mutate?: (ns: string, ops: readonly { op: string; path: string[]; value?: unknown }[], revision?: number) => Promise<void>
} = {}) {
  const calls: { ns: string; ops: readonly { op: string; path: string[]; value?: unknown }[]; revision: number | undefined }[] = []
  const descriptors: SettingsDescriptorLike[] = [{
    ns: 'llm-pi-ai',
    revision: overrides.revision ?? 7,
    value: overrides.user,
    user: overrides.user,
  }]
  const mutate = overrides.mutate ?? vi.fn(async () => {})
  const facade: SettingsFacadeLike = {
    describe: () => descriptors,
    mutate: async (ns, ops, revision) => {
      calls.push({ ns, ops, revision })
      await mutate(ns, ops, revision)
    },
  }
  return { facade, calls }
}

function setup(overrides: Parameters<typeof fakeSettings>[0] = {}) {
  const logger = stubLogger()
  const decisions = new DecisionLog(logger)
  const { facade, calls } = fakeSettings(overrides)
  const writer = new BackfillWriter({ settings: facade, logger, decisions })
  return { writer, calls, logger, decisions }
}

const OPS = [{ op: 'set' as const, path: ['providers', 'gw', 'models', 'm1', 'reasoningEfforts'], value: { high: 'high' } }]

describe('BackfillWriter（M4.2 最小路径写）', () => {
  it('以 describe 的 revision 执行 mutate（乐观并发）', async () => {
    const { writer, calls } = setup({ revision: 7 })
    const outcome = await writer.write(OPS)
    expect(outcome).toEqual({ kind: 'written', ops: 1 })
    expect(calls).toHaveLength(1)
    expect(calls[0].ns).toBe('llm-pi-ai')
    expect(calls[0].revision).toBe(7)
    expect(calls[0].ops[0].path).toEqual(['providers', 'gw', 'models', 'm1', 'reasoningEfforts'])
  })

  it('空 ops → 直接返回不调用 mutate', async () => {
    const { writer, calls } = setup()
    expect(await writer.write([])).toEqual({ kind: 'written', ops: 0 })
    expect(calls).toHaveLength(0)
  })

  it('readUserDoc 读 describe().user 层', () => {
    const { writer } = setup({ user: { providers: { gw: { models: [{ id: 'm' }] } } } })
    expect(writer.readUserDoc()).toEqual({ providers: { gw: { models: [{ id: 'm' }] } } })
  })

  it('user 缺失 → 空对象', () => {
    const { writer } = setup()
    expect(writer.readUserDoc()).toEqual({})
  })

  it('无 llm-pi-ai 描述符时 revision 为 -1，mutate 不传 revision', async () => {
    const logger = stubLogger()
    const decisions = new DecisionLog(logger)
    const calls: { revision: number | undefined }[] = []
    const facade: SettingsFacadeLike = {
      describe: () => [],
      mutate: async (_ns, _ops, revision) => { calls.push({ revision }) },
    }
    const writer = new BackfillWriter({ settings: facade, logger, decisions })
    await writer.write(OPS)
    expect(calls[0].revision).toBeUndefined()
  })

  it('写成功 → 决策日志记 backfill-write', async () => {
    const { writer, logger } = setup()
    await writer.write(OPS)
    expect(logger.lines[0]).toContain('"kind":"backfill-write"')
    expect(logger.lines[0]).toContain('wrote 1 op(s)')
  })
})

describe('BackfillWriter（M4.3 HMR 防护）', () => {
  it('HMR 嵌套拒绝 → 延后入队 + 只警告一次', async () => {
    const { writer, calls, logger } = setup({
      mutate: async () => { throw new Error('HMR transactions cannot be nested') },
    })
    const first = await writer.write(OPS)
    expect(first.kind).toBe('hmr-deferred')
    expect(logger.lines[0]).toContain('deferred to next settings change')
    // 第二次写入：仍在延后队列（未触发 settings 事件），警告不重复
    const second = await writer.write(OPS)
    expect(second.kind).toBe('hmr-deferred')
    const warnLines = logger.lines.filter((l) => l.includes('settings write refused'))
    expect(warnLines).toHaveLength(1)
    expect(calls).toHaveLength(2)
  })

  it('settings/document-updated 事件到来 → 延后队列重试写入', async () => {
    const { writer, calls } = setup({
      mutate: vi.fn()
        .mockRejectedValueOnce(new Error('HMR transactions cannot be nested'))
        .mockResolvedValueOnce(undefined),
    })
    await writer.write(OPS)
    expect(calls).toHaveLength(1)
    // 模拟宿主设置变更事件
    const listeners: (() => void)[] = []
    const ctx = { on: (_e: string, l: () => void) => { listeners.push(l); return () => true } }
    writer.register(ctx)
    listeners[0]()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(calls).toHaveLength(2)
  })
})

describe('BackfillWriter（M4.5 同时编辑 / revision 冲突）', () => {
  it('SETTINGS_CONFLICT → 重读一次再写；成功则 written', async () => {
    const { writer, calls } = setup({
      mutate: vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error('settings namespace "llm-pi-ai" changed since it was read (expected revision 7, now 8)'), { code: 'SETTINGS_CONFLICT' }))
        .mockResolvedValueOnce(undefined),
    })
    const outcome = await writer.write(OPS)
    expect(outcome).toEqual({ kind: 'written', ops: 1 })
    expect(calls).toHaveLength(2)
  })

  it('重试仍冲突 → 放弃（conflict-skipped，不抢写）', async () => {
    const conflict = Object.assign(
      new Error('settings namespace "llm-pi-ai" changed since it was read (expected revision 7, now 8)'),
      { code: 'SETTINGS_CONFLICT' },
    )
    const { writer, calls, logger } = setup({ mutate: vi.fn().mockRejectedValue(conflict) })
    const outcome = await writer.write(OPS)
    expect(outcome.kind).toBe('conflict-skipped')
    expect(calls).toHaveLength(2)
    expect(logger.lines.some((l) => l.includes('revision conflict'))).toBe(true)
  })

  it('普通错误 → error 结果 + 决策日志', async () => {
    const { writer, logger } = setup({ mutate: async () => { throw new Error('disk full') } })
    const outcome = await writer.write(OPS)
    expect(outcome).toEqual({ kind: 'error', message: 'disk full' })
    expect(logger.lines[0]).toContain('"kind":"backfill-error"')
  })
})

describe('BackfillWriter（M4.5 路由默认 maybeWriteRouteDefault）', () => {
  it('allSupportDefault 通过 → 写 route reasoning', async () => {
    const { writer, calls } = setup({
      user: { providers: { gw: { models: [{ id: 'm', reasoningEfforts: { high: 'high' } }] } } },
    })
    const written = await writer.maybeWriteRouteDefault('gw', 'high', [{ high: 'high' }])
    expect(written).toBe(true)
    expect(calls[0].ops[0]).toEqual({ op: 'set', path: ['providers', 'gw', 'reasoning'], value: 'high' })
  })

  it('某模型不支持 → 不写（失效模式 #2）', async () => {
    const { writer, calls } = setup()
    const written = await writer.maybeWriteRouteDefault('gw', 'high', [{ high: 'high' }, { low: 'low' }])
    expect(written).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('当前已是该档 → 幂等不写', async () => {
    const { writer, calls } = setup({
      user: { providers: { gw: { reasoning: 'high', models: [] } } },
    })
    const written = await writer.maybeWriteRouteDefault('gw', 'high', [{ high: 'high' }])
    expect(written).toBe(false)
    expect(calls).toHaveLength(0)
  })
})

describe('BackfillWriter（dry-run 报告）', () => {
  it('logMissing 写入决策日志（grep backfill 命中）', () => {
    const { writer, logger } = setup()
    writer.logMissing([{ route: 'gw', modelId: 'm1' }, { route: 'gw', modelId: 'm2' }], 'dry-run')
    expect(logger.lines[0]).toContain('"kind":"backfill-skipped"')
    expect(logger.lines[0]).toContain('dry-run')
    expect(logger.lines[0]).toContain('gw/m1,gw/m2')
  })

  it('guardLegality 对齐官方校验', () => {
    const { writer } = setup()
    expect(writer.guardLegality({ high: 'high' })).toEqual({ ok: true })
    expect(writer.guardLegality({}).ok).toBe(false)
  })
})
