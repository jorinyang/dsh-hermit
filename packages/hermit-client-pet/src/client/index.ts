/**
 * 桌宠表现层 client 半区。MVP-0 直接复用 dsh-pet（全局 portal 到 document.body），
 * MVP-2 起叠加 Hermit 人格（角色卡/话术/亲密度/情绪调制层）。
 * 挂载与清理必须随 client fiber dispose（TSECS A2 可逆）。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

export const inject = []

export function apply(_ctx: ClientContext): void {
  // TODO(MVP-2): Hermit 人格化桌宠渲染（复用 dsh-pet spritesheet/portal 模式）。
}
