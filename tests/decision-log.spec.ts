import { describe, expect, it, vi } from 'vitest'
import { DecisionLog } from '../src/observability/decision-log.js'
import type { LoggerLike } from '../src/types.js'

function stubLogger(): LoggerLike & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    info: (...args: unknown[]) => { lines.push(args.map(String).join(' ')) },
  }
}

/** 会抛错的 logger：验证观测路径不冒泡。 */
function hostileLogger(): LoggerLike & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    info: () => { throw new Error('logger exploded') },
  }
}

describe('DecisionLog（M3.3 结构化决策日志）', () => {
  it('append 写入环缓冲 + 输出结构化 JSON 行（稳定前缀）', () => {
    const logger = stubLogger()
    const log = new DecisionLog(logger)
    log.append({ kind: 'inject', provider: 'p', model: 'm', from: undefined, to: 'high', reason: 'default', sessionId: 's1' })
    expect(log.recent()).toHaveLength(1)
    expect(log.recent()[0].kind).toBe('inject')
    expect(logger.lines[0]).toContain('[think-intensity] decision ')
    expect(logger.lines[0]).toContain('"kind":"inject"')
    expect(logger.lines[0]).toContain('"to":"high"')
  })

  it('record 带 time 字段', () => {
    const log = new DecisionLog(stubLogger())
    const before = Date.now()
    log.append({ kind: 'skip', provider: 'p', model: 'm', to: 'high', reason: 'blacklist' })
    expect(log.recent()[0].time).toBeGreaterThanOrEqual(before)
  })

  it('环缓冲上限 200：超出淘汰最早', () => {
    const log = new DecisionLog(stubLogger())
    for (let i = 0; i < 250; i++) {
      log.append({ kind: 'skip', provider: 'p', model: `m${i}`, reason: 'blacklist' })
    }
    const recent = log.recent()
    expect(recent).toHaveLength(200)
    expect(recent[0].model).toBe('m50')
    expect(recent[recent.length - 1].model).toBe('m249')
  })

  it('logger 抛错 → append 不冒泡（观测零侵入）', () => {
    const log = new DecisionLog(hostileLogger())
    expect(() => log.append({ kind: 'inject', provider: 'p', model: 'm', to: 'high' })).not.toThrow()
    expect(log.recent()).toHaveLength(1)
  })

  it('recent() 返回数组级快照：外部增删不影响内部', () => {
    const log = new DecisionLog(stubLogger())
    log.append({ kind: 'inject', provider: 'p', model: 'm', to: 'high' })
    const snapshot = log.recent()
    snapshot.push({ time: 1, kind: 'skip', provider: 'p', model: 'm' })
    expect(log.recent()).toHaveLength(1)
  })

  it('JSON 行含 time 与 reason（grep 可命中）', () => {
    const logger = stubLogger()
    const log = new DecisionLog(logger)
    log.append({ kind: 'blacklist-add', provider: 'gw', model: 'm', to: 'max', reason: 'unsupported', sessionId: 's' })
    const line = logger.lines[0]
    const json = JSON.parse(line.slice(line.indexOf('{'))) as { time: number; reason: string }
    expect(json.time).toBeGreaterThan(0)
    expect(json.reason).toBe('unsupported')
  })
})
