/**
 * 会话内自愈黑名单：记录被 `UNSUPPORTED_REASONING_EFFORT` 拒绝的
 * (provider, model, level) 组合，后续注入跳过（报告 §7.4 场景 7）。
 *
 * - **不持久化**：进程内存态，随会话消失，避免误判固化（peterwangze 实证决策）；
 * - 有界：会话数与每会话条目数都有上限，防长期运行泄漏。
 */

/** 单个会话最多记录的组合数；超出后忽略新增（黑名单是优化不是账本）。 */
const MAX_ENTRIES_PER_SESSION = 32

/** 最多保留的会话数；超出后淘汰最早插入的会话。 */
const MAX_SESSIONS = 64

function keyOf(provider: string, model: string, level: string): string {
  return `${provider}\u0000${model}\u0000${level}`
}

export class EffortBlacklist {
  private readonly sessions = new Map<string, Set<string>>()

  /** 该 (provider, model, level) 在此会话内是否被拉黑。 */
  blocks(sessionId: string, provider: string, model: string, level: string): boolean {
    return this.sessions.get(sessionId)?.has(keyOf(provider, model, level)) === true
  }

  /** 拉黑一个组合；同键幂等。 */
  add(sessionId: string, provider: string, model: string, level: string): void {
    let entries = this.sessions.get(sessionId)
    if (entries === undefined) {
      if (this.sessions.size >= MAX_SESSIONS) {
        const oldest = this.sessions.keys().next().value
        if (oldest !== undefined) this.sessions.delete(oldest)
      }
      entries = new Set()
      this.sessions.set(sessionId, entries)
    }
    if (entries.size < MAX_ENTRIES_PER_SESSION) entries.add(keyOf(provider, model, level))
  }
}
