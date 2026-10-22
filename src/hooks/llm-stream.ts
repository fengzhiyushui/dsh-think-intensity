import type { Context } from '@deepseek-ai/cordis'
import type { StrategyConfig } from '../types.js'
import type { HookDeps } from './agent-request.js'

/** llm/stream waterfall 的 options 子集（GenerateOptions 的策略相关字段）。 */
interface StreamOptions {
  provider?: string
  model?: string
  reasoningEffort?: string
  /** 辅助调用分类（compaction / session-title）；普通对话请求不携带。 */
  purpose?: string
  sessionId?: unknown
  signal?: AbortSignal
}

/** 流分片：只做转发，不消费内容。 */
type StreamChunk = unknown

/** llm 运行时作用域事件的边界收窄（同 agent-request.ts 的理由）。 */
type WidenedOn = (
  event: 'llm/stream',
  listener: (options: StreamOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>,
  options?: { prepend?: boolean; global?: boolean },
) => unknown

/**
 * 注册 llm/stream 钩子：为携带 purpose 的辅助调用（compaction / session-title）
 * 按 `purposeLevels` 注入档位（计划 M2.2 双钩子模式）。
 *
 * - **异步生成器形状**：llm 运行时同步消费 waterfall 返回值（llm/src/index.ts:1174
 *   直接 return ctx.waterfall(...)，不做 await），因此监听器必须同步返回
 *   AsyncIterable——async 生成器调用即返回生成器，函数体内先 `await` 守卫、
 *   原地变更 options，再 `yield* next()` 委派内层；适配器查找发生在终端
 *   continuation（即 next() 内），变更先于校验生效；
 * - **冻结检测（红线 7）**：主对话请求到达本事件时已被深度冻结
 *   （llm-streaming.zh.md:769），只读放行；仅未冻结的辅助调用可原地修改；
 * - 显式档位（reasoningEffort 已设）不打扰（红线 2）；
 * - 注入前过能力守卫 + 会话黑名单（红线 3 / 场景 7）；
 * - 红线 4：守卫异常吞掉后照常放行流。
 */
export function registerLlmStreamHook(
  ctx: Context,
  deps: HookDeps,
  readConfig: () => StrategyConfig,
): void {
  const on = ctx.on as unknown as WidenedOn
  on('llm/stream', async function* purposeLevelListener(options, next) {
    try {
      await applyPurposeLevel(deps, readConfig, options)
    } catch {
      // 注入路径失败不影响流本身（红线 4）
    }
    yield* next()
  }, { global: true })
}

/** purpose 决策 + 能力守卫；通过后原地写入档位（options 未冻结）。 */
async function applyPurposeLevel(
  deps: HookDeps,
  readConfig: () => StrategyConfig,
  options: StreamOptions,
): Promise<void> {
  const purpose = options.purpose
  if (purpose === undefined) return
  if (Object.isFrozen(options)) return
  if (options.reasoningEffort !== undefined) return
  const config = readConfig()
  const level = config.purposeLevels[purpose]
  if (level === undefined) return
  const provider = String(options.provider ?? '')
  const model = String(options.model ?? '')
  if (config.providers.length > 0 && !config.providers.includes(provider)) return
  const sessionId = options.sessionId === undefined ? '' : String(options.sessionId)
  if (deps.blacklist.blocks(sessionId, provider, model, level)) {
    deps.decisions.append({ kind: 'skip', provider, model, to: level, reason: 'blacklist', sessionId })
    return
  }
  const info = await deps.llm.resolveModelInfo(provider, model, options.signal)
  const efforts = info.reasoning?.efforts ?? []
  if (!efforts.some((effort) => effort.id === level)) return
  options.reasoningEffort = level
  deps.decisions.append({
    kind: 'inject',
    provider,
    model,
    to: level,
    reason: `purpose:${purpose}`,
    sessionId,
  })
}
