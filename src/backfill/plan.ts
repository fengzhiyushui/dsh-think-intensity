/**
 * 缺失声明检测 + dry-run（计划 M4.1）+ 合法性守卫（M4.4）。
 * 纯函数：不触碰 settings，只做扫描与计划，可完整单测。
 */

/** 官方七档词汇（pi-ai 标准升级顺序，catalog.ts:75-83）。 */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

/** 一个模型声明的档位表：key=档位，value=wire 值；off 可为 null（支持但不发送）。 */
export type ReasoningEfforts = Partial<Record<ThinkingLevel, string | null>>

/** 回填配置的校验结果。 */
export type LegalityCheck =
  | { ok: true }
  | { ok: false; reason: string }

/**
 * 对齐官方 catalog 校验（catalog.ts:719-762 的四种拒绝）：
 * - 空字典 → 拒绝（失效模式 #4：插件一装配置加载失败）；
 * - 只声明 off → 拒绝；
 * - 非 off 档位给 null → 拒绝；
 * - 非 off 档位给空串 → 拒绝；
 * - 未知档位 key → 拒绝（目录外的档位会被 pin 为 null，声明无意义）。
 */
export function checkBackfillLegality(efforts: ReasoningEfforts): LegalityCheck {
  const keys = Object.keys(efforts)
  if (keys.length === 0) return { ok: false, reason: 'empty reasoningEfforts' }
  for (const key of keys) {
    if (!(THINKING_LEVELS as readonly string[]).includes(key)) {
      return { ok: false, reason: `unknown level "${key}"` }
    }
    const wire = efforts[key as ThinkingLevel]
    if (wire === null && key !== 'off') {
      return { ok: false, reason: `level "${key}" needs a wire value; only "off" may leave it empty` }
    }
    if (wire === '') return { ok: false, reason: `level "${key}" must not be an empty string` }
  }
  if (!keys.some((key) => key !== 'off')) {
    return { ok: false, reason: 'offers no level beyond off' }
  }
  return { ok: true }
}

/** user 层文档中一个模型条目的最小读取面。 */
export interface ModelEntryLike {
  id?: string
  reasoningEfforts?: false | ReasoningEfforts
}

/** user 层文档中一个路由的最小读取面。 */
export interface RouteLike {
  models?: readonly ModelEntryLike[]
}

/** llm-pi-ai user 层文档的最小读取面。 */
export interface PiAiUserDocLike {
  providers?: Record<string, RouteLike>
}

/** 一个缺失模型：路由 + 模型 id。 */
export interface MissingModel {
  route: string
  modelId: string
}

/**
 * 扫描缺失 `reasoningEfforts` 的模型（M4.1 检测）。
 * 只处理 `models` 列表（`modelOverrides` 不在此列——chuling 的教训）；
 * 已声明（含 `false` 非推理模型与部分声明）的一律跳过，保留用户值。
 */
export function detectMissing(doc: PiAiUserDocLike): MissingModel[] {
  const missing: MissingModel[] = []
  for (const [route, entry] of Object.entries(doc.providers ?? {})) {
    for (const model of entry?.models ?? []) {
      if (model.reasoningEfforts === undefined && typeof model.id === 'string') {
        missing.push({ route, modelId: model.id })
      }
    }
  }
  return missing
}

/** dry-run 输出：将写入的 mutate 操作 + 人类可读摘要。 */
export interface BackfillPlan {
  /** settings.mutate 的 ops（M4.2 最小路径写）。 */
  ops: SettingsPathOpLike[]
  /** 人类可读摘要（dry-run 报告）。 */
  summary: string
}

/** settings.mutate op 的结构子集（settings/src/index.ts:367）。 */
export interface SettingsPathOpLike {
  op: 'set' | 'unset'
  path: string[]
  value?: unknown
}

/**
 * 生成回填计划（M4.1 → M4.2 的桥）。
 * @param doc llm-pi-ai user 层文档
 * @param efforts 配置的档位表（已过合法性守卫）
 * @returns ops + 摘要；无缺失时 ops 为空
 */
export function planBackfill(doc: PiAiUserDocLike, efforts: ReasoningEfforts): BackfillPlan {
  const missing = detectMissing(doc)
  const ops: SettingsPathOpLike[] = missing.map(({ route, modelId }) => ({
    op: 'set',
    path: ['providers', route, 'models', modelId, 'reasoningEfforts'],
    value: { ...efforts },
  }))
  const summary = missing.length === 0
    ? 'no missing declarations'
    : `would backfill ${missing.length} model(s): ${missing.map((m) => `${m.route}/${m.modelId}`).join(', ')}`
  return { ops, summary }
}

/** 路由默认防护的读取面：路由默认档 + 该路由模型的档位声明。 */
export interface RouteDefaultInput {
  /** 路由当前默认档（user 层）；undefined = 未设置。 */
  current?: string
  /** 候选默认档（配置）。 */
  candidate?: string
  /** 该路由所有模型的档位表（已含回填后的声明）。 */
  modelEfforts: readonly (ReasoningEfforts | false | undefined)[]
}

/**
 * allSupportDefault 校验（D9 / 失效模式 #2，chuling 实证防护）：
 * 路由默认只有"该路由所有模型都支持该档"时才允许写入，
 * 否则整条路由在"用户没显式选档"的每一次请求都会 UNSUPPORTED_REASONING_EFFORT。
 * @returns 是否可写；false 时必须放弃（宿主不做降级/夹取，报告 §5.4）
 */
export function routeDefaultAllowed(input: RouteDefaultInput): boolean {
  if (input.candidate === undefined) return false
  if (input.current === input.candidate) return false
  if (input.modelEfforts.length === 0) return false
  return input.modelEfforts.every((efforts) => {
    if (efforts === false || efforts === undefined) return false
    const wire = efforts[input.candidate as ThinkingLevel]
    return wire !== undefined && wire !== null
  })
}
