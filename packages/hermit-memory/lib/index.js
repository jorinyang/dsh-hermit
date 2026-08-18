/**
 * hermit-memory — MemoryHub M1：跨会话事件日志（11 记忆系统 §二）。
 * M1 记什么：task_dispatched / task_completed / task_failed / perm_decision / budget_watermark
 * 每条：{ts, type, ref_id, brief, sentiment_hint?} —— 只存 brief 不存全文（隐私+体积，11 §二）
 * 用途：「昨天那个文档后来发了吗」的上下文源 + 排障审计（MVP-1 晨间问候接它）
 * M0（工作记忆）= DSH 原生会话持久化+compaction，无需自建。
 * TSECS：追加式日志效应可逆（A2）；JSONL 原子追加（B2 崩溃安全）；上限裁剪防膨胀。
 * @module hermit-memory
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'hermit-memory'
export const inject = []

const M1_FILE = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'hermit-m1-events.jsonl')
const MAX_LINES = 2000

/** 追加一条 M1 事件（供 hermit-core 调用）。崩溃安全：单行 append。 */
export function record(type, refId, brief, sentimentHint) {
  try {
    fs.mkdirSync(path.dirname(M1_FILE), { recursive: true })
    fs.appendFileSync(M1_FILE, JSON.stringify({ ts: Date.now(), type, ref_id: refId, brief: String(brief).slice(0, 200), sentiment_hint: sentimentHint }) + '\n', 'utf8')
    // 上限裁剪（防无限膨胀；丢最老）
    try {
      const lines = fs.readFileSync(M1_FILE, 'utf8').split('\n').filter(Boolean)
      if (lines.length > MAX_LINES) fs.writeFileSync(M1_FILE, lines.slice(-MAX_LINES).join('\n') + '\n', 'utf8')
    } catch { /* 裁剪失败不影响追加 */ }
  } catch { /* 尽力而为（B2） */ }
}

/** 读最近 n 条 M1 事件（供后续晨间问候/审计视图）。 */
export function recent(n = 20) {
  try {
    const lines = fs.readFileSync(M1_FILE, 'utf8').split('\n').filter(Boolean)
    return lines.slice(-n).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

export function apply(_ctx) { /* M1 由 hermit-core 直调；宿主挂载为占位（M2/M3 MVP-1 扩展） */ }
