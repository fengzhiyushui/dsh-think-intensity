import { describe, expect, it } from 'vitest'
import { guardInjection } from '../src/capability.js'
import type { LlmFacadeLike, ResolvedModelInfoLike } from '../src/types.js'

function llmOf(info: ResolvedModelInfoLike | Error): LlmFacadeLike {
  return {
    resolveModelInfo: () => (info instanceof Error ? Promise.reject(info) : Promise.resolve(info)),
  }
}

describe('guardInjection（M1 能力守卫）', () => {
  it('场景 1：模型无 reasoningEfforts → 不注入（leave）', async () => {
    const outcome = await guardInjection(llmOf({}), 'p', 'm', 'high', undefined)
    expect(outcome).toEqual({ action: 'leave' })
  })

  it('场景 6：非推理模型（reasoningEfforts: false → reasoning 缺失）+ 种子档位 → 剥离', async () => {
    const outcome = await guardInjection(llmOf({}), 'p', 'm', undefined, 'high')
    expect(outcome).toEqual({ action: 'strip' })
  })

  it('模型有档位、种子已有档位 → 不打扰（显式优先）', async () => {
    const outcome = await guardInjection(
      llmOf({ reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } }),
      'p', 'm', 'low', 'off',
    )
    expect(outcome).toEqual({ action: 'leave' })
  })

  it('场景 3：目标档位在 efforts 中 → 注入该档位（wire 映射由适配器完成）', async () => {
    const outcome = await guardInjection(
      llmOf({ reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } }),
      'p', 'm', 'high', undefined,
    )
    expect(outcome).toEqual({ action: 'inject', level: 'high' })
  })

  it('目标档位不在 efforts 中 → 守卫失败宁可不注入', async () => {
    const outcome = await guardInjection(
      llmOf({ reasoning: { efforts: [{ id: 'off' }, { id: 'low' }] } }),
      'p', 'm', 'max', undefined,
    )
    expect(outcome).toEqual({ action: 'leave' })
  })

  it('wanted 为空 → 不注入', async () => {
    const outcome = await guardInjection(
      llmOf({ reasoning: { efforts: [{ id: 'high' }] } }),
      'p', 'm', undefined, undefined,
    )
    expect(outcome).toEqual({ action: 'leave' })
  })

  it('resolveModelInfo 抛错 → 异常上抛（由调用方按红线 4 放行）', async () => {
    await expect(
      guardInjection(llmOf(new Error('gateway down')), 'p', 'm', 'high', undefined),
    ).rejects.toThrow('gateway down')
  })
})
