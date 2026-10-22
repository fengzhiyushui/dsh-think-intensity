import type { StrategyConfig } from './types.js'

/** 一次决策的请求侧输入。 */
export interface StrategyInput {
  /** 宿主装配后的种子档位；非 undefined 视为显式选择。 */
  seedEffort: string | undefined
  /** 请求路由的 provider key。 */
  provider: string
  /** 会话来源是否为子 agent（session.header.origin === 'subagent'）。 */
  isSubagent: boolean
}

/** providers 白名单过滤（空数组 = 全部生效）。 */
function filteredByProviders(config: StrategyConfig, provider: string): boolean {
  return config.providers.length > 0 && !config.providers.includes(provider)
}

/**
 * 决策链（计划 §7.2：显式 > 子 agent 默认 > 全局默认；红线 2：显式值永远优先，
 * 只补"没选"的请求）。purpose 分档在 llm/stream 钩子单独处理（辅助调用不经本链）。
 * @returns 要注入的档位；undefined = 不干预。
 */
export function decideLevel(config: StrategyConfig, input: StrategyInput): string | undefined {
  if (input.seedEffort !== undefined) return undefined
  if (filteredByProviders(config, input.provider)) return undefined
  if (input.isSubagent && config.subagentLevel) return config.subagentLevel
  if (config.defaultLevel) return config.defaultLevel
  return undefined
}

export { filteredByProviders }
