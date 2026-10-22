import { describe, expect, it } from 'vitest'
import { EffortBlacklist } from '../src/blacklist.js'

describe('EffortBlacklist（会话内自愈黑名单）', () => {
  it('add 后 blocks 返回 true；未 add 的组合不阻断', () => {
    const blacklist = new EffortBlacklist()
    expect(blacklist.blocks('s1', 'p', 'm', 'high')).toBe(false)
    blacklist.add('s1', 'p', 'm', 'high')
    expect(blacklist.blocks('s1', 'p', 'm', 'high')).toBe(true)
    expect(blacklist.blocks('s1', 'p', 'm', 'low')).toBe(false)
  })

  it('按会话隔离：同一组合只阻断所在会话', () => {
    const blacklist = new EffortBlacklist()
    blacklist.add('s1', 'p', 'm', 'high')
    expect(blacklist.blocks('s2', 'p', 'm', 'high')).toBe(false)
  })

  it('按 (provider, model, level) 精确匹配：换模型不阻断', () => {
    const blacklist = new EffortBlacklist()
    blacklist.add('s1', 'p', 'm1', 'high')
    expect(blacklist.blocks('s1', 'p', 'm2', 'high')).toBe(false)
    expect(blacklist.blocks('s1', 'p2', 'm1', 'high')).toBe(false)
  })

  it('重复 add 幂等', () => {
    const blacklist = new EffortBlacklist()
    blacklist.add('s1', 'p', 'm', 'high')
    blacklist.add('s1', 'p', 'm', 'high')
    expect(blacklist.blocks('s1', 'p', 'm', 'high')).toBe(true)
  })

  it('每会话条目有上限：超限后忽略新增', () => {
    const blacklist = new EffortBlacklist()
    for (let i = 0; i < 40; i++) blacklist.add('s1', 'p', `m${i}`, 'high')
    // 前 32 个在界内（含 m0），第 33+ 个被忽略（m40 不存在，m39 也应被忽略）
    expect(blacklist.blocks('s1', 'p', 'm0', 'high')).toBe(true)
    expect(blacklist.blocks('s1', 'p', 'm31', 'high')).toBe(true)
    expect(blacklist.blocks('s1', 'p', 'm39', 'high')).toBe(false)
  })

  it('会话数有上限：超限淘汰最早会话', () => {
    const blacklist = new EffortBlacklist()
    for (let i = 0; i < 70; i++) blacklist.add(`s${i}`, 'p', 'm', 'high')
    // s0..s5 已被淘汰（70 - 64 = 6），s6 起仍在
    expect(blacklist.blocks('s0', 'p', 'm', 'high')).toBe(false)
    expect(blacklist.blocks('s5', 'p', 'm', 'high')).toBe(false)
    expect(blacklist.blocks('s6', 'p', 'm', 'high')).toBe(true)
    expect(blacklist.blocks('s69', 'p', 'm', 'high')).toBe(true)
  })
})
