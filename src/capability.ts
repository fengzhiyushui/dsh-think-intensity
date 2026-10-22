import type { LlmFacadeLike } from './types.js'

/** 守卫结论：注入 / 剥离 / 放行。 */
export type GuardOutcome =
  | { action: 'inject'; level: string }
  | { action: 'strip' }
  | { action: 'leave' }

/**
 * 能力守卫（红线 3：注入前必须过能力校验，守卫失败宁可不注入）。
 *
 * 规则（报告 §7.3 / §6.1.6 实证）：
 * - 模型未上报任何档位（`reasoningEfforts: false` 或元数据缺失）：种子档位
 *   会被 `UNSUPPORTED_REASONING_EFFORT` 拒绝 → 剥离（场景 6）；
 * - 种子已有档位（用户显式选择或宿主装配结果）→ 不打扰（红线 2）；
 * - 目标档位不在 efforts 中 → 不注入；
 * - 全部通过 → 注入目标档位（wire 值映射由适配器 thinkingLevelMap 完成，
 *   例如 `high: ultra` 时网关收到 ultra，场景 3）。
 *
 * 本函数不吞异常：llm 调用失败由调用方按红线 4 放行原请求。
 */
export async function guardInjection(
  llm: LlmFacadeLike,
  provider: string,
  model: string,
  wanted: string | undefined,
  seedEffort: string | undefined,
  signal?: AbortSignal,
): Promise<GuardOutcome> {
  const info = await llm.resolveModelInfo(provider, model, signal)
  const efforts = info.reasoning?.efforts ?? []
  if (efforts.length === 0) {
    return seedEffort !== undefined ? { action: 'strip' } : { action: 'leave' }
  }
  if (seedEffort !== undefined) return { action: 'leave' }
  if (wanted === undefined) return { action: 'leave' }
  if (!efforts.some((effort) => effort.id === wanted)) return { action: 'leave' }
  return { action: 'inject', level: wanted }
}
