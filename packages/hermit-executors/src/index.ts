/**
 * tool：llama.cpp 本地 / DeepSeek·Kimi 云端 / 外部框架 CLI（03 §4.2）
 *
 * D0 骨架占位——实现见 24 §三。遵循 TSECS：inject 声明依赖 / apply 注册效应与 disposer。
 * @module hermit-executors
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const name = 'hermit-executors'
export const inject: string[] = []

export interface Config {}
export const Config = z.object({})

export function apply(_ctx: Context, _config: Config): void {
  // TODO(D1): 实现。所有副作用必须经 _ctx.effect(...) 注册 disposer（TSECS A2 可逆）。
}
