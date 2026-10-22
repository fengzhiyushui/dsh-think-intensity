import { describe, expect, it } from 'vitest'
import {
  checkBackfillLegality,
  detectMissing,
  planBackfill,
  routeDefaultAllowed,
  DEFAULT_BACKFILL_LEVELS,
  type PiAiUserDocLike,
} from '../src/backfill/plan.js'

describe('checkBackfillLegality（M4.4 对齐官方 catalog 校验）', () => {
  it('空字典 → 拒绝（失效模式 #4）', () => {
    expect(checkBackfillLegality({})).toEqual({ ok: false, reason: 'empty reasoningEfforts' })
  })

  it('只声明 off → 拒绝', () => {
    expect(checkBackfillLegality({ off: null })).toEqual({ ok: false, reason: 'offers no level beyond off' })
  })

  it('非 off 档位给 null → 拒绝', () => {
    const result = checkBackfillLegality({ off: null, high: null })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('only "off" may leave it empty')
  })

  it('非 off 档位给空串 → 拒绝', () => {
    const result = checkBackfillLegality({ high: '' })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('empty string')
  })

  it('未知档位 key → 拒绝', () => {
    const result = checkBackfillLegality({ ultra: 'ultra' as never })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('unknown level')
  })

  it('合法声明（含 off 留空 + 自定义 wire）→ 通过', () => {
    expect(checkBackfillLegality({ off: null, low: 'low', high: 'ultra', max: 'max' })).toEqual({ ok: true })
  })

  it('off 带值也合法', () => {
    expect(checkBackfillLegality({ off: 'disabled', high: 'high' })).toEqual({ ok: true })
  })

  it('DEFAULT_BACKFILL_LEVELS 符合官方 catalog 规范', () => {
    expect(checkBackfillLegality(DEFAULT_BACKFILL_LEVELS)).toEqual({ ok: true })
    expect(DEFAULT_BACKFILL_LEVELS.off).toBe(null)
    expect(DEFAULT_BACKFILL_LEVELS.high).toBe('high')
  })
})

describe('detectMissing（M4.1 缺失检测）', () => {
  const doc: PiAiUserDocLike = {
    providers: {
      'my-gateway': {
        models: [
          { id: 'has-decl', reasoningEfforts: { off: null, high: 'high' } },
          { id: 'has-false', reasoningEfforts: false },
          { id: 'has-partial', reasoningEfforts: { high: 'high' } },
          { id: 'missing-1' },
          { id: 'missing-2' },
        ],
      },
      'other-gateway': {
        models: [{ id: 'missing-3' }],
      },
    },
  }

  it('只报 models 列表中未声明的模型', () => {
    const missing = detectMissing(doc)
    expect(missing).toEqual([
      { route: 'my-gateway', modelId: 'missing-1' },
      { route: 'my-gateway', modelId: 'missing-2' },
      { route: 'other-gateway', modelId: 'missing-3' },
    ])
  })

  it('空文档 → 无缺失', () => {
    expect(detectMissing({})).toEqual([])
    expect(detectMissing({ providers: {} })).toEqual([])
  })

  it('无 models 列表的路由 → 跳过（modelOverrides 不在 M4 范围）', () => {
    expect(detectMissing({ providers: { route: {} } })).toEqual([])
  })
})

describe('planBackfill（M4.1 → M4.2 的桥）', () => {
  const doc: PiAiUserDocLike = {
    providers: { gw: { models: [{ id: 'm1' }, { id: 'm2', reasoningEfforts: { high: 'high' } }] } },
  }
  const efforts = { off: null, low: 'low', high: 'ultra' }

  it('生成最小路径 ops：只补缺失，保留用户值', () => {
    const { ops, summary } = planBackfill(doc, efforts)
    expect(ops).toHaveLength(1)
    expect(ops[0]).toEqual({
      op: 'set',
      path: ['providers', 'gw', 'models', 'm1', 'reasoningEfforts'],
      value: { off: null, low: 'low', high: 'ultra' },
    })
    expect(summary).toContain('would backfill 1 model')
    expect(summary).toContain('gw/m1')
  })

  it('无缺失 → ops 为空', () => {
    const { ops, summary } = planBackfill({ providers: { gw: { models: [{ id: 'm', reasoningEfforts: { high: 'h' } }] } } }, efforts)
    expect(ops).toEqual([])
    expect(summary).toBe('no missing declarations')
  })
})

describe('routeDefaultAllowed（D9 / M4.5 路由默认防护）', () => {
  const supported = { off: null, high: 'high' }

  it('所有模型都支持候选档 → 允许写', () => {
    expect(routeDefaultAllowed({
      candidate: 'high',
      modelEfforts: [supported, { off: null, high: 'high', max: 'max' }],
    })).toBe(true)
  })

  it('某模型不支持 → 拒绝（失效模式 #2：整条路由请求失败）', () => {
    expect(routeDefaultAllowed({
      candidate: 'high',
      modelEfforts: [supported, { off: null, low: 'low' }],
    })).toBe(false)
  })

  it('模型声明为 false（非推理）→ 拒绝', () => {
    expect(routeDefaultAllowed({ candidate: 'high', modelEfforts: [supported, false] })).toBe(false)
  })

  it('模型未声明 → 拒绝', () => {
    expect(routeDefaultAllowed({ candidate: 'high', modelEfforts: [supported, undefined] })).toBe(false)
  })

  it('候选档留空 → 拒绝', () => {
    expect(routeDefaultAllowed({ candidate: undefined, modelEfforts: [supported] })).toBe(false)
  })

  it('当前已是该档 → 拒绝（幂等，不重复写）', () => {
    expect(routeDefaultAllowed({ current: 'high', candidate: 'high', modelEfforts: [supported] })).toBe(false)
  })

  it('路由无模型 → 拒绝', () => {
    expect(routeDefaultAllowed({ candidate: 'high', modelEfforts: [] })).toBe(false)
  })

  it('档位声明了但 wire 为 null（pin 为不支持）→ 拒绝', () => {
    expect(routeDefaultAllowed({
      candidate: 'high',
      modelEfforts: [{ off: null, high: null }],
    })).toBe(false)
  })
})
