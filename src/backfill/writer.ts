/**
 * llm-pi-ai user 层的最小路径回填写入器（计划 M4.2/M4.3/M4.5）。
 *
 * - **最小路径写**：settings.mutate 只改目标叶子（llm-pi-ai 的 providers 整树
 *   声明 volatile，config.ts:353），不覆盖用户已声明的档位（失效模式 #1）；
 * - **revision 乐观并发**：describe() 取 revision 传入 mutate；冲突
 *   （SettingsConflictError / code 'SETTINGS_CONFLICT'）重读一次再写，
 *   仍冲突则放弃（不抢写，失效模式 #7）；
 * - **HMR 防护**（4.3）：写被拒于嵌套事务（'HMR transactions cannot be
 *   nested'）时警告一次并延后到下次 settings/document-updated（a114 实证）；
 * - **合法性守卫**（4.4）：写前过 plan.checkBackfillLegality，非法一律拒绝。
 */
import type { DecisionLog } from '../observability/decision-log.js'
import type { LoggerLike } from '../types.js'
import { checkBackfillLegality, routeDefaultAllowed, type ReasoningEfforts, type SettingsPathOpLike } from './plan.js'

/** settings 服务的消费面（SettingsForms 的子集）。 */
export interface SettingsFacadeLike {
  describe(): SettingsDescriptorLike[]
  mutate(ns: string, ops: readonly SettingsPathOpLike[], expectedRevision?: number): Promise<void>
}

/** describe() 描述符的消费面（SettingsDescriptor 子集）。 */
export interface SettingsDescriptorLike {
  ns: string
  revision: number
  value?: unknown
  user?: unknown
}

/** HMR 嵌套事务的拒绝消息（a114 thinking-effort.js:62 实证字符串）。 */
const HMR_NESTED = 'HMR transactions cannot be nested'

/** 冲突错误码（settings/src/index.ts:47）。 */
const CONFLICT_CODE = 'SETTINGS_CONFLICT'

/** 目标命名空间（llm-pi-ai 的 profile entry id）。 */
const NS = 'llm-pi-ai'

export interface WriterDeps {
  settings: SettingsFacadeLike
  logger: LoggerLike
  decisions: DecisionLog
}

/** 写入结果。 */
export type WriteOutcome =
  | { kind: 'written'; ops: number }
  | { kind: 'conflict-skipped' }
  | { kind: 'hmr-deferred' }
  | { kind: 'error'; message: string }

/**
 * 回填写入器（有状态：HMR 延后队列 + 已警告标记）。
 * register() 挂 settings/document-updated 监听，延后队列在事件到来时重试。
 */
export class BackfillWriter {
  private pending: { ops: SettingsPathOpLike[] } | undefined
  private hmrWarned = false

  constructor(private readonly deps: WriterDeps) {}

  /**
   * 注册 HMR 延后的重试监听（settings/document-updated，ns+revision）。
   * 0.1.x 与 0.2.x 同源事件名（peterwangze 实证），单名注册即可。
   */
  register(ctx: { on: (event: string, listener: (...args: unknown[]) => void) => unknown }): void {
    ctx.on('settings/document-updated', () => {
      const pending = this.pending
      if (pending === undefined) return
      this.pending = undefined
      void this.writeOps(pending.ops)
    })
  }

  /**
   * 执行一次回填（ops 由调用方经 plan.planBackfill 生成）。
   * @param ops 最小路径 ops（非空才调用）
   */
  async write(ops: SettingsPathOpLike[]): Promise<WriteOutcome> {
    if (ops.length === 0) return { kind: 'written', ops: 0 }
    return this.writeOps(ops)
  }

  /** 读 user 层文档（describe().user）；缺失返回 {}。 */
  readUserDoc(): Record<string, unknown> {
    const descriptor = this.deps.settings.describe().find((row) => row.ns === NS)
    const user = descriptor?.user
    return typeof user === 'object' && user !== null ? user as Record<string, unknown> : {}
  }

  /** dry-run 报告：缺失清单写入决策日志（grep 'backfill' 命中）。 */
  logMissing(missing: readonly { route: string; modelId: string }[], note?: string): void {
    this.deps.decisions.append({
      kind: 'backfill-skipped',
      provider: NS,
      model: '',
      to: String(missing.length),
      reason: note ?? 'dry-run',
      sessionId: missing.map((m) => `${m.route}/${m.modelId}`).join(','),
    })
  }

  /** 写前合法性守卫（M4.4）。 */
  guardLegality(efforts: ReasoningEfforts): { ok: true } | { ok: false; reason: string } {
    return checkBackfillLegality(efforts)
  }

  /** 当前 revision；describe 无该 ns 时 -1。 */
  revision(): number {
    return this.deps.settings.describe().find((row) => row.ns === NS)?.revision ?? -1
  }

  private async writeOps(ops: SettingsPathOpLike[]): Promise<WriteOutcome> {
    const base = this.revision()
    try {
      await this.deps.settings.mutate(NS, ops, base >= 0 ? base : undefined)
      this.deps.decisions.append({
        kind: 'backfill-write',
        provider: NS,
        model: '',
        reason: `wrote ${ops.length} op(s)`,
      })
      return { kind: 'written', ops: ops.length }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes(HMR_NESTED)) {
        this.pending = { ops }
        if (!this.hmrWarned) {
          this.hmrWarned = true
          this.deps.logger.info('[think-intensity] settings write refused (HMR transaction); deferred to next settings change')
          this.deps.decisions.append({ kind: 'backfill-deferred', provider: NS, model: '', reason: 'hmr-nested' })
        }
        return { kind: 'hmr-deferred' }
      }
      const code = (error as { code?: string }).code
      if (code === CONFLICT_CODE || message.includes('changed since it was read')) {
        // 失效模式 #7：不抢写——重读一次；文档仍变则放弃本次
        this.deps.logger.info('[think-intensity] settings revision conflict; re-reading once')
        try {
          const retryRevision = this.revision()
          await this.deps.settings.mutate(NS, ops, retryRevision >= 0 ? retryRevision : undefined)
          this.deps.decisions.append({ kind: 'backfill-write', provider: NS, model: '', reason: `wrote ${ops.length} op(s) after re-read` })
          return { kind: 'written', ops: ops.length }
        } catch {
          this.deps.decisions.append({ kind: 'backfill-skipped', provider: NS, model: '', reason: 'revision-conflict' })
          return { kind: 'conflict-skipped' }
        }
      }
      this.deps.decisions.append({ kind: 'backfill-error', provider: NS, model: '', reason: message })
      return { kind: 'error', message }
    }
  }

  /**
   * 路由默认写入（D9 / M4.5）：allSupportDefault 通过才写。
   * @param route 路由 key
   * @param candidate 候选默认档
   * @param modelEfforts 该路由各模型的档位声明（回填后）
   * @returns 是否实际执行了写入
   */
  async maybeWriteRouteDefault(
    route: string,
    candidate: string | undefined,
    modelEfforts: readonly (ReasoningEfforts | false | undefined)[],
  ): Promise<boolean> {
    const doc = this.readUserDoc()
    const providers = (doc as { providers?: Record<string, { reasoning?: unknown }> }).providers
    const current = typeof providers?.[route]?.reasoning === 'string' ? providers[route].reasoning as string : undefined
    if (!routeDefaultAllowed({ current, candidate, modelEfforts })) return false
    const op: SettingsPathOpLike = { op: 'set', path: ['providers', route, 'reasoning'], value: candidate }
    const outcome = await this.writeOps([op])
    return outcome.kind === 'written'
  }
}
