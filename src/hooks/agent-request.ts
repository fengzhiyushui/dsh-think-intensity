import type { Context } from '@deepseek-ai/cordis'
import { guardInjection } from '../capability.js'
import { decideLevel } from '../strategy.js'
import type { EffortBlacklist } from '../blacklist.js'
import type { DecisionLog } from '../observability/decision-log.js'
import type { StatsCollector } from '../observability/stats.js'
import type { LlmFacadeLike, LoggerLike, StrategyConfig } from '../types.js'

/** agent/request waterfall 的载荷子集。 */
interface AgentRequestPayload {
  signal?: AbortSignal
  agent?: SessionCarrier
}

/** 子 agent 判据与会话 id 的最小读取面（SessionHeader 的结构子集）。 */
interface SessionCarrier {
  session?: { header?: { origin?: string; id?: unknown } }
}

/** 从载荷提取会话 id（缺失时用空串：黑名单按会话隔离，无会话归入同一桶）。 */
function sessionIdOf(payload: AgentRequestPayload): string {
  const id = payload.agent?.session?.header?.id
  return id === undefined ? '' : String(id)
}

/** 子 agent 判据：session.header.origin === 'subagent'（官方 SessionHeader.origin）。 */
function isSubagent(payload: AgentRequestPayload): boolean {
  return payload.agent?.session?.header?.origin === 'subagent'
}

/** waterfall 种子配置的结构子集（LlmCallConfig 的策略相关字段）。 */
interface SeedConfig {
  provider?: string
  model?: string
  reasoningEffort?: string
}

/** dsh-agent 的 generated scope 事件类型不随 npm 再导出，与 dsh-thinking-levels
 *  相同：在边界对 ctx.on 做一次显式收窄，收窄面只有本事件（红线 6：不依赖
 *  未公开内部结构，只按公开事件键接线）。 */
type WidenedOn = (
  event: 'agent/request',
  listener: (payload: AgentRequestPayload, next: () => Promise<SeedConfig>) => Promise<SeedConfig>,
  options?: { prepend?: boolean; global?: boolean },
) => unknown

export interface HookDeps {
  llm: LlmFacadeLike
  logger: LoggerLike
  blacklist: EffortBlacklist
  /** 结构化决策日志（M3.3）。 */
  decisions: DecisionLog
  /** 流统计（M3.1/M3.2，观测钩子消费）。 */
  stats: StatsCollector
}

/**
 * 注册 agent/request 策略钩子（主对话请求）。
 *
 * - `{ prepend: true, global: true }`：prepend 让本插件处于 waterfall 最外层，
 *   `await next()` 之后拿到宿主模型选择装配的最终种子（宿主装配同监听本事件，
 *   未选档时会剥离继承档位，见 packages/core/agent/src/model-selection.ts:96）；
 *   global 让根上下文的监听器收到 agent 作用域分发的事件。
 * - 红线 1：先 `await next()` 再决策，不短路宿主装配；
 * - 红线 4：策略路径任何异常吞掉并返回原请求（next() 自身的失败原样上抛）；
 * - 自愈（§7.4 场景 7）：黑名单命中的档位不注入，等待下次请求自然降级；
 * - 副作用只经 ctx.on 注册，插件卸载时由框架自动清理（红线 5）。
 */
export function registerAgentRequestHook(
  ctx: Context,
  deps: HookDeps,
  readConfig: () => StrategyConfig,
): void {
  const on = ctx.on as unknown as WidenedOn
  on('agent/request', async (payload, next) => {
    const seed = await next()
    try {
      const config = readConfig()
      const seedEffort = seed.reasoningEffort
      const provider = String(seed.provider ?? '')
      const model = String(seed.model ?? '')
      const sessionId = sessionIdOf(payload)
      const wanted = decideLevel(config, { seedEffort, provider, isSubagent: isSubagent(payload) })
      if (wanted === undefined && seedEffort === undefined) {
        // 无事可做：既没有要注入的档位，也没有要剥离的继承档位，
        // 省掉一次 resolveModelInfo（零配置下每个请求都省）。
        return seed
      }
      if (wanted !== undefined && deps.blacklist.blocks(sessionId, provider, model, wanted)) {
        deps.decisions.append({ kind: 'skip', provider, model, to: wanted, reason: 'blacklist', sessionId })
        return seed
      }
      const outcome = await guardInjection(deps.llm, provider, model, wanted, seedEffort, payload?.signal)
      if (outcome.action === 'inject') {
        deps.decisions.append({
          kind: 'inject',
          provider,
          model,
          from: seedEffort,
          to: outcome.level,
          reason: isSubagent(payload) ? 'subagent' : 'default',
          sessionId,
        })
        return { ...seed, reasoningEffort: outcome.level }
      }
      if (outcome.action === 'strip') {
        deps.decisions.append({
          kind: 'strip',
          provider,
          model,
          from: seedEffort,
          reason: 'no-capability',
          sessionId,
        })
        const { reasoningEffort: _stripped, ...rest } = seed
        return rest
      }
      return seed
    } catch {
      return seed
    }
  }, { prepend: true, global: true })
}
