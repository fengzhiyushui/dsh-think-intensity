import type { Context } from '@deepseek-ai/cordis'
import type { HookDeps } from '../hooks/agent-request.js'

/** llm/stream options 的观测子集。 */
interface ObservedOptions {
  provider?: string
  model?: string
  reasoningEffort?: string
  purpose?: string
  sessionId?: unknown
}

/** usage 块的 TokenUsage 子集。 */
interface UsageLike {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
}

/** 流分片：透传不消费，仅按结构识别 usage/finish。 */
type StreamChunk = unknown

/** 边界收窄：同 agent-request.ts 的理由。 */
type WidenedOn = (
  event: 'llm/stream',
  listener: (options: ObservedOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>,
  options?: { prepend?: boolean; global?: boolean },
) => unknown

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 注册 llm/stream 只读观测钩子（M3.1）。
 *
 * - **零侵入**：逐块原样 yield；观测逻辑全部 try/catch，任何异常不影响转发，
 *   源流的错误/提前结束对消费者保持原样（finally 兜底记录）；
 * - 采集：usage 块（TokenUsage.inputTokens/outputTokens/reasoningTokens，
 *   llm/src/types.ts:175）、finish 块（error/aborted 归一化由运行时保证，
 *   types.ts:467）、流耗时；
 * - **档位惰性读取**：effort 在流结束（finally）时才从 options 读取——
 *   更内层的 purpose 注入发生在流迭代期间，入口快照会漏掉它；
 * - 适配器 throw 会被运行时归一化为 error finish 块（types.ts:467），
 *   但透传包装自身仍捕获 for-await 异常并把 finish 记为 error 后原样上抛。
 */
export function registerStreamObserverHook(ctx: Context, deps: HookDeps): void {
  const on = ctx.on as unknown as WidenedOn
  on('llm/stream', async function* streamObserver(options, next) {
    const startedAt = Date.now()
    const sessionId = options.sessionId === undefined ? '' : String(options.sessionId)
    let usage: UsageLike | undefined
    let finish: 'ok' | 'error' | 'aborted' = 'ok'
    try {
      for await (const chunk of next()) {
        try {
          if (isRecord(chunk)) {
            if (chunk.type === 'usage' && isRecord(chunk.usage)) {
              usage = chunk.usage as UsageLike
            } else if (chunk.type === 'finish' && isRecord(chunk.reason)) {
              const kind = chunk.reason.kind
              if (kind === 'error') finish = 'error'
              else if (kind === 'aborted') finish = 'aborted'
            }
          }
        } catch {
          // 单块观测失败不影响转发
        }
        yield chunk
      }
    } catch (error) {
      finish = 'error'
      throw error
    } finally {
      try {
        deps.stats.record({
          time: startedAt,
          provider: String(options.provider ?? ''),
          model: String(options.model ?? ''),
          // 惰性读取：内层注入已在此刻生效
          effort: options.reasoningEffort,
          purpose: options.purpose,
          sessionId,
          durationMs: Date.now() - startedAt,
          finish,
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
          reasoningTokens: usage?.reasoningTokens,
        })
      } catch {
        // 观测路径不冒泡
      }
    }
  }, { global: true })
}
