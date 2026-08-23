/**
 * proactive.js — 07 主动发起调度器（MVP-1：调度器 + 守卫链 + MVP 活动感知 + P1 关怀 + 反馈闭环 + user_directives）。
 *
 * 管家风：克制、有事才报（07 §一）。P0 由事件驱动不走本调度器（走 Arbiter.urgent），
 * 本调度器负责 P1 关怀类的周期试探 + 反馈闭环自校准 + user_directives 持久化。
 *
 * 反机械感三件套（07 §3.1，N.E.K.O 同款）：基础间隔 + 有界抖动 ±5min + 概率跳过 0.3。
 * 入口守卫链 fail-closed 全规则零 LLM（07 §3.2）。
 * @module hermit-core/proactive
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BASE_INTERVAL_MS = 20 * 60 * 1000   // 基础间隔 20min
const JITTER_MS = 5 * 60 * 1000           // 有界抖动 ±5min
const SKIP_PROB = 0.3                     // 概率跳过
const SILENCE_AWAY_MS = 30 * 60 * 1000    // 对话沉默 >30min 且无任务 → 视为离开
const DEEP_NIGHT = { start: 23, end: 7 }  // 深夜 23:00-07:00

// P1 关怀类（07 §七.2 五条全上，每条独立频率上限/冷却）
const CARE_ITEMS = [
  { id: 'sedentary', text: '主人盯屏好一会儿了，起来走走、喝口水？', intervalMs: 90 * 60 * 1000, nightOnly: false },
  { id: 'water', text: '主人，喝口水吧——你忙起来总忘。', intervalMs: 120 * 60 * 1000, nightOnly: false },
  { id: 'eye_rest', text: '眼睛歇半分钟、看看远处？我帮你记着点。', intervalMs: 60 * 60 * 1000, nightOnly: false },
  { id: 'late_night', text: '都快半夜了，主人早点睡，我在这儿守着。', intervalMs: 24 * 3600 * 1000, nightOnly: true },
  { id: 'sleep', text: '主人昨晚睡得晚，今晚早点休息？', intervalMs: 24 * 3600 * 1000, nightOnly: true },
]

const STATE_FILE = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'hermit-proactive.json')

function loadState() {
  const def = { silenceUntil: 0, intervalMs: BASE_INTERVAL_MS, skipProb: SKIP_PROB, feedback: [], careLast: {}, directives: {}, lastProactiveAt: 0 }
  try { return { ...def, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } } catch { return def }
}
function saveState(s) {
  try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8') } catch {}
}

export function createProactiveScheduler({ getArbiter, on, now = Date.now }) {
  const state = loadState()
  let timer = null
  let lastUserSpeechAt = now()
  let busy = false
  let pendingP0 = false
  let aiPendingQuestion = false

  function arbiter() { return getArbiter ? getArbiter() : undefined }

  /* ── 活动感知（MVP 简化：对话沉默 + 本地时间；系统 idle 留 MVP-2）────────── */
  function isDeepNight() { const h = new Date().getHours(); return h >= DEEP_NIGHT.start || h < DEEP_NIGHT.end }
  function userAway() { return now() - lastUserSpeechAt > SILENCE_AWAY_MS }

  /* ── 入口守卫链（fail-closed，全规则零 LLM，07 §3.2）──────────────────── */
  function guardPass() {
    if (now() < state.silenceUntil) return false          // ① 静默期（别烦我/连续负面暂停）
    if (busy) return false                                 // ② 前一轮主动发起未完成
    if (pendingP0) return false                            // ③ 有未读 P0 汇报 → P1 让路
    if (isDeepNight()) return false                        // ④ 深夜免打扰（P1 深夜项在 pick 里单放行，此处统一先拒）
    if (userAway()) return false                           // ④ 活动感知：离开
    if (aiPendingQuestion) return false                    // ⑤ AI 刚问了未答 → 不抢话头
    return true
  }

  /* ── 调度主循环（反机械感三件套）────────────────────────────────────── */
  function scheduleNext() {
    if (timer) clearTimeout(timer)
    const jitter = (Math.random() * 2 - 1) * JITTER_MS
    const delay = Math.max(60 * 1000, state.intervalMs + jitter)
    timer = setTimeout(() => { timer = null; tick() }, delay)
  }

  function tick() {
    if (!guardPass()) { scheduleNext(); return }
    if (Math.random() < state.skipProb) { scheduleNext(); return }  // 概率跳过
    const item = pickCareItem()
    if (!item) { scheduleNext(); return }
    const a = arbiter()
    if (a && typeof a.submit === 'function') {
      a.submit({ text: item.text, priority: 'normal', source: 'proactive' })
    }
    state.careLast[item.id] = now()
    state.lastProactiveAt = now()
    saveState(state)
    scheduleNext()
  }

  /** 选一个到期且符合时段的关怀项（轮询公平：取最久未触发者） */
  function pickCareItem() {
    const night = isDeepNight()
    const due = CARE_ITEMS
      .filter((it) => (it.nightOnly ? night : !night))
      .filter((it) => now() - (state.careLast[it.id] || 0) >= it.intervalMs)
      .sort((a, b) => (state.careLast[a.id] || 0) - (state.careLast[b.id] || 0))
    return due[0] || null
  }

  /* ── 反馈闭环（07 §五：响应率驱动主动性自校准）────────────────────── */
  function recordResponse(kind) {
    state.feedback.push({ kind, at: now() })
    if (state.feedback.length > 10) state.feedback.shift()
    const recent = state.feedback.slice(-10)
    if (recent.length >= 5) {
      const rate = recent.filter((f) => f.kind === 'respond').length / recent.length
      if (rate < 0.3) {
        state.intervalMs = Math.min(2 * 3600 * 1000, Math.round(state.intervalMs * 1.5))
        state.skipProb = Math.min(0.8, state.skipProb + 0.1)
      }
    }
    if (recent.filter((f) => f.kind === 'negative').length >= 2) {
      state.silenceUntil = now() + 24 * 3600 * 1000  // 连续 2 次负面 → 暂停 24h
    }
    saveState(state)
  }

  /* ── user_directives（07 §五：显式偏好，渲染进 system prompt）────────── */
  function setDirective(key, value) { state.directives[key] = value; saveState(state) }
  function getDirectives() { return { ...state.directives } }
  function directivesLine() {
    const entries = Object.entries(state.directives)
    if (!entries.length) return ''
    return '主人明确交代过的偏好（永久生效，务必遵守）：' + entries.map(([k, v]) => `${k}=${v}`).join('；')
  }

  /* ── 事件接线 ──────────────────────────────────────────────────────── */
  const disposers = []
  if (on) {
    disposers.push(on('session/event', (_s, ev) => {
      const t = ev && ev.type
      if (t === 'user/message') { lastUserSpeechAt = now(); aiPendingQuestion = false; return }
      if (t === 'assistant/message') {
        const txt = extractText(ev && ev.data && ev.data.message && ev.data.message.content)
        // 开放问题检测（07 §3.2.5）：AI 尾句是问句且未获答 → 抑制主动发起
        aiPendingQuestion = /[?？]\s*$/.test(txt)
      }
    }))
    // 用户负面反馈（"别烦我/再见"）→ 进入静默期（07 §3.2.1）
    disposers.push(on('session/event', (_s, ev) => {
      if (ev && ev.type === 'user/message') {
        const txt = extractText(ev.data && ev.data.message && ev.data.message.content)
        if (/别烦我|别吵|闭嘴|安静|再见|拜拜/.test(txt)) {
          state.silenceUntil = now() + 24 * 3600 * 1000
          saveState(state)
        }
      }
    }))
  }

  scheduleNext()

  return {
    recordResponse, setDirective, getDirectives, directivesLine,
    silence(ms = 24 * 3600 * 1000) { state.silenceUntil = now() + ms; saveState(state) },
    setBusy(v) { busy = !!v },
    setPendingP0(v) { pendingP0 = !!v },
    dispose() { if (timer) clearTimeout(timer); disposers.forEach((d) => d()) },
  }
}

function extractText(content) {
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('').trim()
}
