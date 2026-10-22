import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 一次模型调用的观测条目（M3.1）。 */
export interface StreamStatEntry {
  time: number
  provider: string
  model: string
  /** 请求携带的档位（注入后、适配器默认物化前）。 */
  effort?: string
  /** 辅助调用分类（compaction / session-title）；主对话为空。 */
  purpose?: string
  sessionId: string
  durationMs: number
  finish: 'ok' | 'error' | 'aborted'
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
}

/** 按 (provider, model, effort) 聚合的累计值。 */
export interface StatAggregate {
  count: number
  ok: number
  failed: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  durationMsTotal: number
}

/** 落盘文件结构（schema 1）。 */
interface StatsFile {
  schema: 1
  savedAt: number
  totals: Record<string, StatAggregate>
  recent: StreamStatEntry[]
}

/** 单聚合键；空档位用 '-' 占位避免键冲突。 */
function keyOf(provider: string, model: string, effort: string | undefined): string {
  return `${provider}|${model}|${effort ?? '-'}`
}

/** 最近条目上限。 */
const MAX_RECENT = 100

/**
 * 统计收集 + 低频落盘（M3.2）。
 *
 * - record 只更新内存聚合；距上次落盘 ≥ flushIntervalMs 时后台落盘一次；
 * - 落盘失败静默（观测不阻塞、不报错干扰主流程）；
 * - dispose() 供插件卸载时兜底落盘；
 * - filePath 为 undefined（无法解析 home）时纯内存工作。
 */
export class StatsCollector {
  private readonly totals = new Map<string, StatAggregate>()
  private readonly recent: StreamStatEntry[] = []
  private lastFlush: number
  private flushing = false
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly filePath: string | undefined,
    private readonly flushIntervalMs: number,
  ) {
    // 从构造时刻起算节流窗：首次 record 不应立即触发落盘，
    // 否则调用方紧跟的显式 flush() 会被 flushing 守卫提前放回（竞态）。
    this.lastFlush = Date.now()
  }

  /** 恢复历史聚合（启动时调用一次；文件缺失/损坏都静默从零开始）。 */
  async load(): Promise<void> {
    if (this.filePath === undefined) return
    try {
      const raw = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<StatsFile>
      if (raw.schema === 1 && typeof raw.totals === 'object' && raw.totals !== null) {
        for (const [key, value] of Object.entries(raw.totals)) {
          if (typeof value?.count === 'number') this.totals.set(key, value)
        }
      }
      this.lastFlush = Date.now()
    } catch {
      // 首次运行或文件损坏：从零聚合
    }
  }

  /** 记录一次调用；必要时调度落盘。 */
  record(entry: StreamStatEntry): void {
    try {
      const key = keyOf(entry.provider, entry.model, entry.effort)
      const agg = this.totals.get(key) ?? {
        count: 0, ok: 0, failed: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, durationMsTotal: 0,
      }
      agg.count += 1
      if (entry.finish === 'ok') agg.ok += 1
      else agg.failed += 1
      agg.inputTokens += entry.inputTokens ?? 0
      agg.outputTokens += entry.outputTokens ?? 0
      agg.reasoningTokens += entry.reasoningTokens ?? 0
      agg.durationMsTotal += entry.durationMs
      this.totals.set(key, agg)
      this.recent.push(entry)
      if (this.recent.length > MAX_RECENT) this.recent.splice(0, this.recent.length - MAX_RECENT)
      this.schedule()
    } catch {
      // 观测路径不冒泡
    }
  }

  /** 当前聚合快照（M5 UI 消费）。 */
  snapshot(): { totals: ReadonlyMap<string, StatAggregate>; recent: readonly StreamStatEntry[] } {
    return { totals: new Map(this.totals), recent: [...this.recent] }
  }

  /** 卸载兜底：立即落盘。 */
  async dispose(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer)
    await this.flush()
  }

  private schedule(): void {
    if (this.filePath === undefined) return
    const since = Date.now() - this.lastFlush
    if (since >= this.flushIntervalMs) {
      void this.flush()
      return
    }
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        void this.flush()
      }, this.flushIntervalMs - since)
      // 宿主进程不因悬垂计时器延迟退出
      ;(this.timer as { unref?: () => void }).unref?.()
    }
  }

  /** 写临时文件后原子改名；失败静默并重置节流窗。 */
  async flush(): Promise<void> {
    if (this.filePath === undefined || this.flushing) return
    this.flushing = true
    this.lastFlush = Date.now()
    try {
      const file: StatsFile = {
        schema: 1,
        savedAt: Date.now(),
        totals: Object.fromEntries(this.totals),
        recent: this.recent,
      }
      const dir = dirname(this.filePath)
      await mkdir(dir, { recursive: true })
      const tmp = `${this.filePath}.tmp`
      await writeFile(tmp, JSON.stringify(file), 'utf8')
      await rename(tmp, this.filePath)
    } catch {
      // 写失败静默（计划 M3.2：不阻塞请求、不干扰主流程）
    } finally {
      this.flushing = false
    }
  }
}

/**
 * 解析 DSH home（peterwangze 同源规则）：`$DSH_HOME`（非空）优先，缺省 `~/.dsh`。
 * @returns home 目录；无法解析时 undefined（统计纯内存）。
 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '' ? env.DSH_HOME : undefined
  if (explicit !== undefined) return explicit
  try {
    return join(homedir(), '.dsh')
  } catch {
    return undefined
  }
}

/** 统计文件路径：<home>/storages/think-intensity-stats.json。 */
export function statsFilePath(home: string): string {
  return join(home, 'storages', 'think-intensity-stats.json')
}
