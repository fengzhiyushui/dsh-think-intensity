import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StatsCollector, resolveDshHome, statsFilePath } from '../src/observability/stats.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'think-intensity-stats-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function entry(overrides: Partial<{ provider: string; model: string; effort: string; finish: 'ok' | 'error' | 'aborted'; reasoningTokens: number; durationMs: number }> = {}) {
  return {
    time: Date.now(),
    provider: overrides.provider ?? 'gw',
    model: overrides.model ?? 'm',
    effort: overrides.effort,
    purpose: undefined,
    sessionId: 's1',
    durationMs: overrides.durationMs ?? 100,
    finish: overrides.finish ?? 'ok',
    inputTokens: 10,
    outputTokens: 20,
    reasoningTokens: overrides.reasoningTokens,
  }
}

describe('StatsCollector（M3.2 统计落盘）', () => {
  it('record 聚合 count/ok/failed/tokens/duration', () => {
    const stats = new StatsCollector(undefined, 60_000)
    stats.record(entry({ effort: 'high', reasoningTokens: 5, durationMs: 100 }))
    stats.record(entry({ effort: 'high', reasoningTokens: 7, durationMs: 200, finish: 'error' }))
    const snap = stats.snapshot()
    const agg = snap.totals.get('gw|m|high')
    expect(agg).toBeDefined()
    expect(agg?.count).toBe(2)
    expect(agg?.ok).toBe(1)
    expect(agg?.failed).toBe(1)
    expect(agg?.reasoningTokens).toBe(12)
    expect(agg?.durationMsTotal).toBe(300)
    expect(snap.recent).toHaveLength(2)
  })

  it('无档位键用 - 占位（undefined effort 不冲突）', () => {
    const stats = new StatsCollector(undefined, 60_000)
    stats.record(entry({ effort: undefined }))
    stats.record(entry({ effort: 'high' }))
    const snap = stats.snapshot()
    expect(snap.totals.has('gw|m|-')).toBe(true)
    expect(snap.totals.has('gw|m|high')).toBe(true)
  })

  it('flush 写原子文件（tmp → rename），schema 1', async () => {
    const file = join(dir, 'stats.json')
    const stats = new StatsCollector(file, 60_000)
    stats.record(entry({ effort: 'high' }))
    await stats.flush()
    const raw = JSON.parse(await readFile(file, 'utf8'))
    expect(raw.schema).toBe(1)
    expect(raw.totals['gw|m|high'].count).toBe(1)
    expect(raw.recent).toHaveLength(1)
    // tmp 文件已被 rename 消费
    await expect(stat(`${file}.tmp`)).rejects.toThrow()
  })

  it('flush 创建缺失的 storages 目录', async () => {
    const file = join(dir, 'nested', 'storages', 'stats.json')
    const stats = new StatsCollector(file, 60_000)
    stats.record(entry())
    await stats.flush()
    const raw = JSON.parse(await readFile(file, 'utf8'))
    expect(raw.schema).toBe(1)
  })

  it('record 间隔 ≥ intervalMs 时自动调度落盘', async () => {
    const file = join(dir, 'auto.json')
    const stats = new StatsCollector(file, 30)
    stats.record(entry())
    // 30ms 后计时器触发；等待足够久让 flush 完成
    await new Promise((resolve) => setTimeout(resolve, 120))
    const raw = JSON.parse(await readFile(file, 'utf8'))
    expect(raw.totals['gw|m|-'].count).toBe(1)
  })

  it('load 恢复历史聚合', async () => {
    const file = join(dir, 'load.json')
    const first = new StatsCollector(file, 60_000)
    first.record(entry({ effort: 'high', reasoningTokens: 42 }))
    await first.flush()
    const second = new StatsCollector(file, 60_000)
    await second.load()
    const agg = second.snapshot().totals.get('gw|m|high')
    expect(agg?.count).toBe(1)
    expect(agg?.reasoningTokens).toBe(42)
  })

  it('load 对缺失/损坏文件静默从零开始', async () => {
    const missing = new StatsCollector(join(dir, 'nope.json'), 60_000)
    await missing.load()
    expect(missing.snapshot().totals.size).toBe(0)
    const corrupt = join(dir, 'corrupt.json')
    await writeFile(corrupt, '{not json', 'utf8')
    const collector = new StatsCollector(corrupt, 60_000)
    await collector.load()
    expect(collector.snapshot().totals.size).toBe(0)
  })

  it('写失败静默（目录被占位为文件时不抛错）', async () => {
    const blocker = join(dir, 'blocker')
    await writeFile(blocker, 'not a dir', 'utf8')
    const file = join(blocker, 'stats.json')
    const stats = new StatsCollector(file, 60_000)
    stats.record(entry())
    await expect(stats.flush()).resolves.toBeUndefined()
  })

  it('filePath 为 undefined 时纯内存工作（flush 直接返回）', async () => {
    const stats = new StatsCollector(undefined, 60_000)
    stats.record(entry())
    await expect(stats.flush()).resolves.toBeUndefined()
    expect(stats.snapshot().totals.size).toBe(1)
  })

  it('dispose 清计时器并兜底落盘', async () => {
    const file = join(dir, 'dispose.json')
    const stats = new StatsCollector(file, 60_000)
    stats.record(entry())
    await stats.dispose()
    const raw = JSON.parse(await readFile(file, 'utf8'))
    expect(raw.totals['gw|m|-'].count).toBe(1)
  })

  it('recent 上限 100：超出淘汰最早', () => {
    const stats = new StatsCollector(undefined, 60_000)
    for (let i = 0; i < 120; i++) stats.record(entry({ model: `m${i}` }))
    expect(stats.snapshot().recent).toHaveLength(100)
    expect(stats.snapshot().recent[0].model).toBe('m20')
  })
})

describe('resolveDshHome / statsFilePath（路径解析）', () => {
  it('DSH_HOME 显式优先', () => {
    expect(resolveDshHome({ DSH_HOME: 'D:/custom/dsh' })).toBe('D:/custom/dsh')
  })

  it('DSH_HOME 空串视为未设置 → 回退 ~/.dsh', () => {
    const home = resolveDshHome({ DSH_HOME: '' })
    expect(home).toBeDefined()
    expect(home?.endsWith('.dsh')).toBe(true)
  })

  it('未设置 DSH_HOME → ~/.dsh', () => {
    const home = resolveDshHome({})
    expect(home).not.toBe('')
    expect(home?.endsWith('.dsh')).toBe(true)
  })

  it('statsFilePath = <home>/storages/think-intensity-stats.json', () => {
    expect(statsFilePath('D:/x')).toBe(join('D:/x', 'storages', 'think-intensity-stats.json'))
  })
})
