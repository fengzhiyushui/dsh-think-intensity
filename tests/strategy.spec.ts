import { describe, expect, it } from 'vitest'
import { decideLevel } from '../src/strategy.js'

describe('decideLevel（决策链：显式 > 子 agent > 全局默认）', () => {
  it('场景 5：种子已有档位（显式 off）→ 不覆盖', () => {
    const decision = decideLevel(
      { defaultLevel: 'high', providers: [] },
      { seedEffort: 'off', provider: 'my-gateway', isSubagent: false },
    )
    expect(decision).toBeUndefined()
  })

  it('defaultLevel 留空 → 不干预', () => {
    const decision = decideLevel(
      { defaultLevel: undefined, providers: [] },
      { seedEffort: undefined, provider: 'my-gateway', isSubagent: false },
    )
    expect(decision).toBeUndefined()
  })

  it('defaultLevel 空字符串视为留空 → 不干预', () => {
    const decision = decideLevel(
      { defaultLevel: '', providers: [] },
      { seedEffort: undefined, provider: 'my-gateway', isSubagent: false },
    )
    expect(decision).toBeUndefined()
  })

  it('providers 白名单不包含该路由 → 不干预', () => {
    const decision = decideLevel(
      { defaultLevel: 'high', providers: ['other-gateway'] },
      { seedEffort: undefined, provider: 'my-gateway', isSubagent: false },
    )
    expect(decision).toBeUndefined()
  })

  it('providers 白名单命中 → 返回默认档', () => {
    const decision = decideLevel(
      { defaultLevel: 'high', providers: ['my-gateway'] },
      { seedEffort: undefined, provider: 'my-gateway', isSubagent: false },
    )
    expect(decision).toBe('high')
  })

  it('providers 为空数组 → 对全部路由生效', () => {
    const decision = decideLevel(
      { defaultLevel: 'low', providers: [] },
      { seedEffort: undefined, provider: 'any-gateway', isSubagent: false },
    )
    expect(decision).toBe('low')
  })

  it('M2.1：子 agent + subagentLevel → 优先于 defaultLevel', () => {
    const decision = decideLevel(
      { defaultLevel: 'high', subagentLevel: 'max', providers: [] },
      { seedEffort: undefined, provider: 'my-gateway', isSubagent: true },
    )
    expect(decision).toBe('max')
  })

  it('M2.1：子 agent 但 subagentLevel 留空 → 回落 defaultLevel', () => {
    const decision = decideLevel(
      { defaultLevel: 'high', subagentLevel: undefined, providers: [] },
      { seedEffort: undefined, provider: 'my-gateway', isSubagent: true },
    )
    expect(decision).toBe('high')
  })

  it('M2.1：子 agent 也受 providers 白名单约束', () => {
    const decision = decideLevel(
      { defaultLevel: 'high', subagentLevel: 'max', providers: ['other'] },
      { seedEffort: undefined, provider: 'my-gateway', isSubagent: true },
    )
    expect(decision).toBeUndefined()
  })

  it('M2.1：非子 agent 会话不使用 subagentLevel', () => {
    const decision = decideLevel(
      { defaultLevel: 'high', subagentLevel: 'max', providers: [] },
      { seedEffort: undefined, provider: 'my-gateway', isSubagent: false },
    )
    expect(decision).toBe('high')
  })
})
