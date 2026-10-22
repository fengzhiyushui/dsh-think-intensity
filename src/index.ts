import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { EffortBlacklist } from './blacklist.js'
import { BackfillWriter, type SettingsFacadeLike } from './backfill/writer.js'
import { detectMissing, planBackfill, type ReasoningEfforts } from './backfill/plan.js'
import { registerAgentRequestHook, type HookDeps } from './hooks/agent-request.js'
import { registerLlmStreamHook } from './hooks/llm-stream.js'
import { registerRequestErrorHook } from './hooks/request-error.js'
import { DecisionLog } from './observability/decision-log.js'
import { StatsCollector, resolveDshHome, statsFilePath } from './observability/stats.js'
import { registerStreamObserverHook } from './observability/stream-observer.js'
import type { LlmFacadeLike, StrategyConfig } from './types.js'

export const name = 'dsh-think-intensity'

export const inject = ['llm', 'settings']

/**
 * 插件配置（声明式设置：0.1.7+ 宿主据此外推设置表单）。
 * 全部字段 volatile：改动即时生效，无需重载插件。
 */
export const Config = Schema.object({
  /** 全局默认思考档（DSH 档位 id）；留空 = 不干预。 */
  defaultLevel: Schema.string().volatile(),
  /** 子 agent 会话（origin === 'subagent'）的默认档；留空 = 回落到 defaultLevel。 */
  subagentLevel: Schema.string().volatile(),
  /** 生效的 provider 路由白名单；留空 = 全部生效。 */
  providers: Schema.array(Schema.string()).default([]).volatile(),
  /** 辅助调用（purpose 携带 compaction / session-title 等）分档：purpose → 档位 id。 */
  purposeLevels: Schema.dict(Schema.string()).default({}).volatile(),
  /** 统计落盘最小间隔（毫秒）。 */
  statsFlushMs: Schema.number().default(30_000).volatile(),
  /** M4 回填总开关：false = 只检测+报告（dry-run），true = 写入缺失声明。 */
  backfillEnabled: Schema.boolean().default(false).volatile(),
  /** M4 回填档位表（key=七档之一，value=wire 值；off 可为 null）。空 = 不写。 */
  backfillLevels: Schema.dict(Schema.union([Schema.string(), Schema.const(null)])).default({}).volatile(),
  /** M4 路由默认候选档：仅当该路由所有模型都支持时写入（D9 allSupportDefault）。 */
  routeDefaultLevel: Schema.string().volatile(),
})

export type ResolvedConfig = ReturnType<typeof Config>

export function apply(ctx: Context, config: ResolvedConfig) {
  // 边界收窄：dsh 的 llm/settings 服务类型随 @deepseek-ai/dsh-* 包声明，npm
  // 消费方只依赖结构子集（见 types.ts），此处按已声明注入读取。
  const llm = (ctx as unknown as { llm: LlmFacadeLike }).llm
  const settings = (ctx as unknown as { settings: SettingsFacadeLike }).settings
  const readConfig = (): StrategyConfig => ({
    defaultLevel: config.defaultLevel.get(),
    subagentLevel: config.subagentLevel.get(),
    providers: config.providers.get(),
    purposeLevels: config.purposeLevels.get(),
  })

  const blacklist = new EffortBlacklist()
  const decisions = new DecisionLog(ctx.logger)
  const home = resolveDshHome()
  const stats = new StatsCollector(home !== undefined ? statsFilePath(home) : undefined, config.statsFlushMs.get())
  void stats.load()

  const deps: HookDeps = { llm, logger: ctx.logger, blacklist, decisions, stats }
  registerAgentRequestHook(ctx, deps, readConfig)
  registerLlmStreamHook(ctx, deps, readConfig)
  registerRequestErrorHook(ctx, deps)
  registerStreamObserverHook(ctx, deps)

  // M4：回填写入器（HMR 延后监听 + 启动一次检测/回填通道）
  const writer = new BackfillWriter({ settings, logger: ctx.logger, decisions })
  writer.register(ctx as unknown as { on: (event: string, listener: (...args: unknown[]) => void) => unknown })
  void runBackfillPass(writer, config)

  // 卸载兜底：最后一次统计落盘（ctx.effect 的清理函数随插件卸载执行）
  ctx.effect(() => () => { void stats.dispose() })

  ctx.logger.info('[think-intensity] hooks registered: agent/request + llm/stream + agent/request-error + observer + backfill')
}

/**
 * 启动时的一次回填通道（M4.1/M4.2）：
 * - backfillEnabled=false → 只检测，决策日志记摘要（dry-run）；
 * - backfillEnabled=true → 合法性守卫 → 最小路径写（只补缺失，保留用户值）。
 * 本函数不抛错（配置回填失败不影响插件其余能力）。
 */
async function runBackfillPass(writer: BackfillWriter, config: ResolvedConfig): Promise<void> {
  try {
    const doc = writer.readUserDoc()
    const missing = detectMissing(doc as Parameters<typeof detectMissing>[0])
    if (missing.length === 0) return
    const levels = config.backfillLevels.get()
    if (Object.keys(levels).length === 0) {
      // 未配置档位：纯报告（决策日志可 grep）
      writer.logMissing(missing)
      return
    }
    const legality = writer.guardLegality(levels)
    if (!legality.ok) {
      writer.logMissing(missing, `backfill skipped: ${legality.reason}`)
      return
    }
    if (!config.backfillEnabled.get()) {
      writer.logMissing(missing, `dry-run: ${missing.length} model(s) missing declarations`)
      return
    }
    const { ops } = planBackfill(doc as Parameters<typeof planBackfill>[0], levels)
    const outcome = await writer.write(ops)
    if (outcome.kind === 'written' && outcome.ops > 0) {
      // 路由默认（D9）：仅 allSupportDefault 通过才写
      const routeDefault = config.routeDefaultLevel.get()
      if (routeDefault !== undefined) {
        const routes = new Set(missing.map((m) => m.route))
        const models = (doc as { providers?: Record<string, { models?: readonly { reasoningEfforts?: unknown }[] }> })
          .providers
        for (const route of routes) {
          const efforts = (models?.[route]?.models ?? []).map((m) => (
            m.reasoningEfforts === undefined
              ? (levels as ReasoningEfforts | false | undefined)
              : (m.reasoningEfforts as ReasoningEfforts | false | undefined)
          ))
          await writer.maybeWriteRouteDefault(route, routeDefault, efforts)
        }
      }
    }
  } catch {
    // 回填通道失败不影响插件其余能力（红线 4 的同源精神）
  }
}
