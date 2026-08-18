/**
 * 桌宠表现层 host 半区（17/04）。
 * 复用 dsh-pet 的 PetService 与事件投影；本包负责 Hermit 人格化扩展（角色卡=pet.json、话术、亲密度语义、情绪调制）。
 * D0 骨架占位——实现见 24 §五（MVP-2）。
 * @module hermit-client-pet
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const name = 'hermit-client-pet'
export const inject: string[] = []

export interface Config {}
export const Config = z.object({})

export function apply(_ctx: Context, _config: Config): void {
  // TODO(MVP-2): 桥接 hermit-core 事件到 dsh-pet 动画状态机。
}
