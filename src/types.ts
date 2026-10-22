/** 插件内部消费的服务/数据结构子集。
 *
 * 只声明用到的形状，避免依赖未随 npm 再导出的 @deepseek-ai/dsh-* 类型
 * （报告红线 6：只用公开 seam，形状按能力探测与降级，不写死内部结构）。
 */

/** 适配器上报的一个可选档位。 */
export interface EffortInfoLike {
  /** DSH 档位 id（off/low/medium/high/xhigh/max 之一或适配器私有 id）。 */
  id: string
}

/** resolveModelInfo 返回的推理元数据子集。 */
export interface ModelReasoningLike {
  efforts?: readonly EffortInfoLike[]
}

/** ctx.llm.resolveModelInfo 的返回值子集。 */
export interface ResolvedModelInfoLike {
  reasoning?: ModelReasoningLike
}

/** ctx.llm 的消费面子集（llm-streaming.zh.md:1108 的公开签名）。 */
export interface LlmFacadeLike {
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<ResolvedModelInfoLike>
}

/** 决策所需的日志面子集。 */
export interface LoggerLike {
  info(...args: unknown[]): void
  warn?(...args: unknown[]): void
}

/** 策略配置的运行时读取值。 */
export interface StrategyConfig {
  /** 全局默认档；undefined = 不干预。 */
  defaultLevel?: string
  /** 子 agent 会话默认档；undefined = 回落 defaultLevel。 */
  subagentLevel?: string
  /** provider 白名单；空数组 = 全部。 */
  providers: readonly string[]
  /** purpose → 档位（compaction / session-title 等）；空对象 = 不干预辅助调用。 */
  purposeLevels: Readonly<Record<string, string>>
}
