import type { Context } from '@deepseek-ai/cordis'
import type { HookDeps } from './agent-request.js'

/** agent/request-error waterfall 的载荷子集（runtime-types.ts:353 的结构子集）。 */
interface RequestErrorPayload {
  provider?: string
  failure?: { message?: string; code?: string }
  agent?: { session?: { header?: { id?: unknown } } }
  signal?: AbortSignal
}

/** 重试决策动作：原样委派（本插件只观察，不干预重试策略）。 */
type RequestErrorAction = unknown

/** 宿主稳定错误消息：`provider "X" model "Y" does not support reasoning effort "Z"`
 *  （packages/llm/llm/src/index.ts:921/:930 两种变体同构）。 */
const UNSUPPORTED_MESSAGE = /provider "([^"]+)" model "([^"]+)" does not support reasoning effort "([^"]+)"/

/** 边界收窄：同 agent-request.ts 的理由（generated scope 类型不随 npm 再导出）。 */
type WidenedOn = (
  event: 'agent/request-error',
  listener: (payload: RequestErrorPayload, next: () => Promise<RequestErrorAction>) => Promise<RequestErrorAction>,
  options?: { prepend?: boolean; global?: boolean },
) => unknown

/**
 * 注册 agent/request-error 自愈钩子（计划 M2.3 / 报告 §7.4 场景 7）。
 *
 * - 该事件在流级失败（finish.kind === 'error'）时发出（agent-loop/src/agent.ts:511），
 *   `llm/stream` 注入的档位若在适配器边界被拒，错误码
 *   `UNSUPPORTED_REASONING_EFFORT` 会经此路径浮现；
 * - 识别后把 (provider, model, level) 加入**会话内**黑名单（不持久化，避免
 *   误判固化），后续注入自动跳过——不重试、不无限循环；
 * - 只观察：决策动作原样 `next()` 委派，不改宿主重试行为；
 * - 红线 4：观察路径异常吞掉，不影响事件链。
 */
export function registerRequestErrorHook(ctx: Context, deps: HookDeps): void {
  const on = ctx.on as unknown as WidenedOn
  on('agent/request-error', async (payload, next) => {
    try {
      const failure = payload.failure
      if (failure?.code === 'UNSUPPORTED_REASONING_EFFORT' && typeof failure.message === 'string') {
        const match = UNSUPPORTED_MESSAGE.exec(failure.message)
        if (match !== null) {
          const [, provider, model, level] = match
          const sessionId = payload.agent?.session?.header?.id
          const sessionKey = sessionId === undefined ? '' : String(sessionId)
          deps.blacklist.add(sessionKey, provider, model, level)
          deps.decisions.append({
            kind: 'blacklist-add',
            provider,
            model,
            to: level,
            reason: 'unsupported',
            sessionId: sessionKey,
          })
        }
      }
    } catch {
      // 观察 hook 不冒泡（红线 4）
    }
    return next()
  }, { global: true })
}
