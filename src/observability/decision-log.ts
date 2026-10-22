import type { LoggerLike } from '../types.js'

/** 一条结构化决策记录（M3.3：可供 M5 UI 或人工 grep）。 */
export interface DecisionRecord {
  /** 毫秒时间戳。 */
  time: number
  /** inject=注入档位；strip=剥离继承档位；skip=放弃注入；blacklist-add=自愈拉黑；
   *  backfill-write/backfill-deferred/backfill-skipped/backfill-error=M4 配置回填。 */
  kind: 'inject' | 'strip' | 'skip' | 'blacklist-add'
    | 'backfill-write' | 'backfill-deferred' | 'backfill-skipped' | 'backfill-error'
  provider: string
  model: string
  /** 决策时的种子档位（inject/skip 时为决策前值）。 */
  from?: string
  /** 注入/剥离的目标档位。 */
  to?: string
  /** default | subagent | purpose:<name> | blacklist | no-capability | unsupported |
   *  hmr-nested | revision-conflict 等。 */
  reason?: string
  sessionId?: string
}

/** 内存环上限：决策日志是观测窗，不是账本。 */
const MAX_ENTRIES = 200

/** 结构化前缀：`grep 'decision {"kind"'` 可稳定命中。 */
const LOG_PREFIX = '[think-intensity] decision '

/**
 * 有界决策日志：环缓冲（M5 UI 读取）+ 结构化 logger 行（人工 grep）。
 * append 不抛错（观测路径零侵入）。
 */
export class DecisionLog {
  private readonly entries: DecisionRecord[] = []

  constructor(private readonly logger: LoggerLike) {}

  append(record: Omit<DecisionRecord, 'time'>): void {
    try {
      const full: DecisionRecord = { time: Date.now(), ...record }
      this.entries.push(full)
      if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES)
      this.logger.info(LOG_PREFIX + JSON.stringify(full))
    } catch {
      // 观测路径不冒泡（计划 M3：拔掉不影响主流程）
    }
  }

  /** 最近决策快照（M5 UI 消费）。 */
  recent(): readonly DecisionRecord[] {
    return [...this.entries]
  }
}
