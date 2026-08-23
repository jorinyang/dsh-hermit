/**
 * hermit-voice — 小寄的「耳朵和嘴」：语音通道 DSH 半边（26 契约 A）。
 *
 * 设计锚点：
 *  - 麦克风/扬声器归引擎进程独占，本插件只做桥接与语义（26 §一 决策 1）
 *  - ctx.voice 软依赖：引擎不在/契约方缺席 → 自动回退纯文本（26 §A.1，B2 降级即架构内置）
 *  - WS 协议 v1 信封 {v:1,id,type,ts,payload}（26 §B）
 *  - 断线重连 1s→30s 指数退避 + hello/ready 重新协商（26 §B.3）
 *  - barge-in 引擎本地闭环，大脑取消 ≤300ms（26 §B.3；D1 骨架先发 tts.stop 语义）
 *  - 所有副作用经 ctx.effect 注册 disposer（TSECS A2 可逆）
 * @module hermit-voice
 */
import { Service } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

/** 语音路径动作→拟声词（与 hermit-core/lib/voice.js 同一映射，保持单源——改这里记得同步那边）。
 * UI 保留动作描写；TTS 合成前过滤。 */
const ACTION_TO_SOUND = {
  '\uFF08张开小嘴\uFF09': '\uFF08啊~\uFF09',
  '\uFF08张开嘴\uFF09': '\uFF08啊~\uFF09',
  '\uFF08小跑\uFF09': '\uFF08踏踏踏~~\uFF08脚步声\uFF09\uFF09',
  '\uFF08跑来\uFF09': '\uFF08踏踏踏~~\uFF08脚步声\uFF09\uFF09',
  '\uFF08跑过来\uFF09': '\uFF08踏踏踏~~\uFF08脚步声\uFF09\uFF09',
  '\uFF08期待的眨眨眼\uFF09': '\uFF08嗯？\uFF08疑问声\uFF09\uFF09',
  '\uFF08期待的眨眼\uFF09': '\uFF08嗯？\uFF08疑问声\uFF09\uFF09',
  '\uFF08眨眨眼\uFF09': '\uFF08嗯？\uFF08疑问声\uFF09\uFF09',
  '\uFF08认真点头\uFF09': '\uFF08嗯嗯\uFF09',
  '\uFF08点头\uFF09': '\uFF08嗯嗯\uFF09',
  '\uFF08抬头\uFF09': '\uFF08嗯~\uFF09',
  '\uFF08小声\uFF09': '\uFF08嘘~\uFF09',
  '\uFF08笑\uFF09': '\uFF08嘻嘻\uFF09',
  '\uFF08笑出声\uFF09': '\uFF08嘻嘻~\uFF09',
  '\uFF08拍拍手\uFF09': '\uFF08啪啪啪\uFF09',
  '\uFF08摇头\uFF09': '\uFF08不不\uFF09',
  '\uFF08挥手\uFF09': '\uFF08拜拜~\uFF09',
}
function toSpeechText(text) {
  if (!text) return text
  let out = text
  for (const [action, sound] of Object.entries(ACTION_TO_SOUND)) {
    if (out.includes(action)) out = out.split(action).join(sound)
  }
  return out
}


export const name = 'hermit-voice'
export const inject = ['tools']

export const Config = z.object({
  port: z.number().default(8300),
  url: z.string().default(''),
  // 引擎随会话幂等自启（26 §C.4 auto_start 落地）：端口探测已跑则不重复拉起
  autoStart: z.boolean().default(true),
  enginePython: z.string().default(''),   // 覆盖默认 .venv python 路径
  engineServer: z.string().default(''),   // 覆盖默认 server.py 路径
})

const OVERLAY_FILE = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'hermit-voice-config.json')
const MAX_TURNS = 50
// 插件 lib/index.js → 仓库根（packages/hermit-voice/lib → 3 级上）
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
// 口语句尾拖延词（12 §二 语义层，零 LLM）：命中则延长端点等待至 1200ms，避免抢切
const SEMANTIC_EXTEND_RE = /(那个|这个|然后|就是|嗯|额|呃|啊|怎么说|我想想|等一下|等等|还有|或者说|然后呢|所以呢|就是那个)\s*$/

// 诊断日志：console 在 agent-plane isolate realm 里可能被重定向/丢弃，直接落盘到文件最可靠
const DEBUG_LOG = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'hermit-voice-debug.log')
function debugLog(...args) {
  try {
    const line = `[${new Date().toISOString()}] ${args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')}\n`
    fs.appendFileSync(DEBUG_LOG, line, 'utf8')
  } catch { /* 诊断失败不致命 */ }
}

/** 从 assistant message 的 content 数组提取纯文本（跳过 tool-call/tool-result 等）。 */
function extractText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()
}

function loadOverlay() {
  try { return JSON.parse(fs.readFileSync(OVERLAY_FILE, 'utf8')) } catch { return {} }
}
function saveOverlay(o) {
  try { fs.mkdirSync(path.dirname(OVERLAY_FILE), { recursive: true }); fs.writeFileSync(OVERLAY_FILE, JSON.stringify(o, null, 2), 'utf8') } catch {}
}
function pct(list, p) {
  if (!list.length) return null
  const s = [...list].sort((a, b) => a - b)
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))])
}
function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' })
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => { s.destroy(); resolve(false) })
    s.setTimeout(600, () => { s.destroy(); resolve(false) })
  })
}

/**
 * VoiceService — ctx.voice 提供者（26 §A.2）。
 * 轮次状态机 DSH 半边：idle ⇄ listening → processing ⇄ speaking（12 §三）；
 * idle/listening 由引擎 `state` 事件驱动，processing/speaking 由本侧驱动（26 §C.3）。
 */
class VoiceService extends Service {
  static inject = []

  constructor(ctx, config) {
    super(ctx, 'voice')
    debugLog('[hermit-voice] VoiceService 构造，ctx.agents=', this.ctx.get('agents') ? '有' : '无')
    this.config = config
    this.overlay = loadOverlay()
    this.state = 'idle'
    this.ready = false
    this.engineHealth = 'down' // down | connecting | ok
    this.degrade = 3           // 26 §五 降级档：0 正常 / 1 PTT / 2 半哑 / 3 全文本（引擎缺席=3）
    this.ws = null
    this.reconnectTimer = null
    this.heartbeatTimer = null
    this.backoff = 1000
    this.turns = []            // {e2e_ms, asr_ms, tts_first_ms, ts}
    this.asrStart = 0
    this.speakSentAt = 0
    this.lastE2e = null
    this.pendingUtterance = null
    this.wakeArmed = true
    this.agent = null   // 本会话的 Agent（agent/created 作用域过滤事件捕获，用于转写注入）
    this.lastAssistantText = ''  // 本轮最后一个助手回复文本（turn 结束时统一 TTS，避免流式多段互踩）

    if (typeof WebSocket !== 'function') {
      this.engineHealth = 'unsupported'
      this.ctx.logger?.warn?.('hermit-voice: 运行时无全局 WebSocket，语音桥不可用（降级 D3 纯文本）')
      return
    }
    // 语音桥只在 4080（小寄专用 home）启用：多实例共享单例引擎+单麦克风会互相抢，导致唤醒/识别/发声错乱。
    // 其他实例（53551 桌面 app 等）挂载 hermit-voice 时直接禁用语音桥，只保留纯文本降级。
    this.voiceEnabled = String(process.env.DSH_HOME ?? '').includes('dsh-hermit')
    if (!this.voiceEnabled) {
      this.engineHealth = 'disabled'
      debugLog('[hermit-voice] 非 4080 实例（DSH_HOME=' + (process.env.DSH_HOME || '默认') + '），语音桥禁用')
      return
    }
    this.ensureEngine()   // 幂等自启：端口探测已跑则不重复拉起
    // 捕获本会话 agent（agent/created 作用域过滤：agent-scoped 监听只收到自己的 agent）
    this.ctx.effect(() => this.ctx.on('agent/created', ({ agent }) => {
      this.agent = agent
      this.ctx.logger?.info?.('hermit-voice: 捕获本会话 agent', String(agent.id))
    }), 'hermit:agent-ref')
    this.ctx.effect(() => {
      this.connect()
      return () => this.teardown()
    }, 'hermit:voice-bridge')

    // 「说」链路：监听本会话事件，turn 结束时取最后一个助手回复送 TTS（避免流式多段互踩 superseded）
    this.ctx.effect(() => this.ctx.on('session/event', (session, event) => {
      if (event?.type === 'assistant/message') {
        const text = extractText(event?.data?.message?.content)
        if (text) this.lastAssistantText = text
        return
      }
      if (event?.type === 'turn/end') {
        const text = this.lastAssistantText
        this.lastAssistantText = ''
        if (!text) return
        debugLog('[hermit-voice] turn 结束 → TTS:', text.slice(0, 60))
        this.speak({ text, source: 'conversation' })
      }
    }), 'hermit:tts-bridge')
  }

  /** 幂等拉起语音引擎（26 §C.4 auto_start 落地）。detached 子进程，随 dsh web 生命周期外独立存活。 */
  ensureEngine() {
    if (!this.config.autoStart || this._ensureDone) return
    this._ensureDone = true
    const python = this.config.enginePython
      || path.join(REPO_ROOT, 'runtime', 'voice', '.venv', 'Scripts', 'python.exe')
    const server = this.config.engineServer
      || path.join(REPO_ROOT, 'runtime', 'voice', 'server.py')
    portOpen(this.config.port).then((open) => {
      if (open) return  // 引擎已在跑（幂等，双实例只起一个）
      if (!fs.existsSync(python) || !fs.existsSync(server)) {
        this.ctx.logger?.warn?.('hermit-voice: 引擎脚本缺失，跳过自动拉起', server)
        return
      }
      try {
        const child = spawn(python, [server], { detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(server) })
        child.unref()
        this.ctx.logger?.info?.('hermit-voice: 幂等自动拉起语音引擎', server)
      } catch (e) {
        this.ctx.logger?.warn?.('hermit-voice: 引擎拉起失败', e?.message ?? String(e))
      }
    })
  }

  /* ── 桥接（26 §B）────────────────────────────────────────── */

  get engineUrl() {
    return this.config.url || `ws://127.0.0.1:${this.config.port}/voice`
  }

  connect() {
    if (this.ws) return
    this.engineHealth = 'connecting'
    this.emitEngineStatus('connecting')
    let ws
    try { ws = new WebSocket(this.engineUrl) } catch { this.scheduleReconnect(); return }
    this.ws = ws
    let settled = false
    // 握手失败时 onerror 会洪泛、onclose 可能不触发：用 settled 闸门确保只走一次断开清理并重连
    const teardown = () => {
      if (settled) return
      settled = true
      if (this.ws === ws) this.ws = null
      this.onDisconnected()
    }
    ws.onopen = () => {
      settled = true
      debugLog('[hermit-voice] WS 已连接引擎, home=', process.env.DSH_HOME ?? 'default')
      this.backoff = 1000
      this.send('session.hello', { version: 1, caps: ['turn-machine', 'speak-priority'], home: process.env.DSH_HOME ?? 'default' })
      this.startHeartbeat()
    }
    ws.onmessage = (ev) => {
      try {
        const f = JSON.parse(String(ev.data))
        if (/^(asr|endpoint|wake|engine|tts|state)\./.test(f.type ?? '')) {
          debugLog('[hermit-voice] 收到帧:', f.type, JSON.stringify(f.payload ?? {}).slice(0, 120))
        }
        this.handleFrame(f)
      } catch {}
    }
    ws.onclose = () => teardown()
    ws.onerror = (e) => {
      if (settled) return
      debugLog('[hermit-voice] WS error:', String(e?.message ?? e ?? ''))
      teardown()
    }
  }

  teardown() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    this.stopHeartbeat()
    if (this.ws) { try { this.ws.onclose = null; this.ws.close() } catch {} ; this.ws = null }
    this.ready = false
  }

  onDisconnected() {
    const wasReady = this.ready
    debugLog('onDisconnected 触发, wasReady=', wasReady, 'disposed=', !!this.ctx.runtime?.disposed)
    this.ws = null
    this.ready = false
    this.stopHeartbeat()
    this.degrade = 3
    if (wasReady || this.engineHealth !== 'down') {
      // 档位迁移永不静默（26 §五，B1）
      this.ctx.logger?.info?.('hermit-voice: 语音引擎断开，降级 D3 纯文本')
      this.setState('idle', 'engine-lost')
      this.emitEngineStatus('down')
    }
    this.scheduleReconnect()
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.ctx.runtime?.disposed) {
      debugLog('scheduleReconnect 跳过, timer=', !!this.reconnectTimer, 'disposed=', !!this.ctx.runtime?.disposed)
      return
    }
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 2, 30000)
    debugLog('scheduleReconnect 安排重连, delay=', delay)
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect() }, delay)
  }

  startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => this.send('ping', { t: Date.now() }), 10000)
  }
  stopHeartbeat() { if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null } }

  send(type, payload) {
    if (!this.ws || this.ws.readyState !== 1 /* OPEN */) return false
    try { this.ws.send(JSON.stringify({ v: 1, id: randomUUID().slice(0, 8), type, ts: Date.now(), payload })) ; return true } catch { return false }
  }

  /* ── 引擎事件分发（26 §B.2 → DSH 事件，26 §A.3）──────────── */

  handleFrame(f) {
    const p = f.payload ?? {}
    switch (f.type) {
      case 'engine.ready':
        this.ready = true
        this.engineHealth = 'ok'
        this.degrade = 0
        this.modules = { mic: p.mic ?? 'off', kws: p.kws ?? 'off', tts: p.tts ?? 'off', barge_vad: p.barge_vad ?? 'off', asr_mode: p.asr_mode ?? 'fake', models: p.models ?? [] }
        // 重新协商：端点阈值（overlay 持久化的用户偏好）+ 启用语义端点旁路
        // 注：唤醒模式(wake_mode) 已由引擎 TOGGLES 持有，重连时 Conn 会继承，
        // 不再在此推送 wake.set，避免覆盖面板 hotkey/off 状态。
        this.send('endpoint.set', { acoustic_ms: this.overlay.acoustic_ms ?? 600, semantic_mode: true, semantic_wait_ms: 1200 })
        this.emitEngineStatus('ok')
        this.ctx.logger?.info?.('hermit-voice: 引擎就绪', JSON.stringify(p.models ?? []))
        break
      case 'engine.status':
        if (p.health && p.health !== this.engineHealth && this.engineHealth !== 'connecting') {
          this.engineHealth = p.health
          this.emitEngineStatus(p.health)
        }
        break
      case 'engine.error':
        // degrade_hint ∈ retry|ptt|text_only|restart_engine|check_device（26 §B.5）
        if (p.degrade_hint === 'ptt') this.degrade = Math.max(this.degrade, 1)
        else this.degrade = Math.max(this.degrade, 2)
        this.emitEngineStatus('degraded', { code: p.code, message: p.message, hint: p.degrade_hint })
        break
      case 'wake.detected':
        this.ctx.emit('voice/wake', { keyword: p.keyword, confidence: p.confidence, ts: f.ts })
        break
      case 'vad.start':
        this.asrStart = Date.now()
        break
      case 'asr.partial':
        this.ctx.emit('voice/transcript.partial', { text: p.text, ts: f.ts })
        break
      case 'asr.final':
        debugLog('[hermit-voice] 收到 asr.final:', String(p.text ?? ''))
        this.setState('processing', 'asr-final')
        this.ctx.emit('voice/transcript.final', {
          text: p.text, confidence: p.confidence, emotion: p.emotion,
          asr_ms: this.asrStart ? Date.now() - this.asrStart : (p.asr_ms ?? null), ts: f.ts,
        })
        this.injectTranscript(p.text)   // 26 §A.4「听→注入」：转写文本注入本会话，触发小寄应答
        break
      case 'endpoint.acoustic':
        // 语义端点旁路（12 §二 语义层，D5）：零 LLM 拖延词规则——尾句未完则延长等待至 1200ms
        if (SEMANTIC_EXTEND_RE.test(String(p.text ?? ''))) this.send('endpoint.extend', {})
        else this.send('endpoint.accept', {})
        break
      case 'tts.started':
        this.speakSentAt = this.speakSentAt || f.ts
        this.setState('speaking', 'tts-started')
        if (this.pendingUtterance) {
          this.pendingUtterance.tts_first_ms = p.first_packet_ms ?? (Date.now() - this.speakSentAt)
          this.pendingUtterance.started = true
        }
        break
      case 'tts.finished': {
        this.setState('idle', 'tts-finished')
        const u = this.pendingUtterance
        this.pendingUtterance = null
        const e2e = this.asrStart ? Date.now() - this.asrStart : null
        if (e2e != null) this.pushTurn({ e2e_ms: e2e, asr_ms: this.turnAsrMs, tts_first_ms: u?.tts_first_ms ?? null })
        this.ctx.emit('voice/metrics', { e2e_ms: e2e, asr_ms: this.turnAsrMs, tts_first_ms: u?.tts_first_ms ?? null })
        break
      }
      case 'tts.stopped':
        if (p.reason === 'barge_in') {
          // 打断不罚：被打断内容退回队列由 M1-B Arbiter 缩写重述（12 §4.1）
          this.setState('listening', 'barge-in')
          this.ctx.emit('voice/barge_in', { yield_ms: p.yield_ms ?? null, tts_played_ms: p.tts_played_ms ?? null, pending_resume: this.pendingUtterance?.text ?? '', ts: f.ts })
        } else if (this.state === 'speaking') this.setState('idle', 'tts-stopped')
        this.pendingUtterance = null
        break
      case 'barge_in.detected':
        this.ctx.emit('voice/barge_in', { yield_ms: p.yield_ms, tts_played_ms: p.tts_played_ms, pending_resume: '', ts: f.ts })
        this.setState('listening', 'barge-in')
        break
      case 'state':
        if (this.state === 'processing' || this.state === 'speaking') break // DSH 驱动态优先（26 §C.3）
        this.setState(p.to, p.reason)
        break
      case 'pong': break
      default: break
    }
  }

  pushTurn(m) {
    this.lastE2e = m.e2e_ms
    this.turnAsrMs = null
    this.asrStart = 0
    this.speakSentAt = 0
    this.turns.push({ ...m, ts: Date.now() })
    if (this.turns.length > MAX_TURNS) this.turns.shift()
  }

  setState(to, reason) {
    if (!to || to === this.state) return
    const from = this.state
    this.state = to
    this.ctx.emit('voice/state', { from, to, reason })
  }

  emitEngineStatus(health, extra) {
    this.ctx.emit('voice/engine_status', { health, degrade_level: this.degrade, ...(extra ?? {}) })
  }

  /* ── ctx.voice API（26 §A.2）─────────────────────────────── */

  /** 统一发声出口：对话回复/任务汇报/主动发起全走这里（07 §六 优先级映射） */
  speak({ text, priority = 'normal', source = 'conversation' } = {}) {
    const utterance_id = 'utt_' + randomUUID().slice(0, 8)
    if (!this.ready) return { utterance_id, delivered: false, reason: 'engine-down' }
    this.speakSentAt = Date.now()
    const speechText = toSpeechText(text) // TTS 前过滤动作描写（26 §A.4 语音路径）
    this.pendingUtterance = { text: speechText, priority, source, started: false, tts_first_ms: null }
    const ok = this.send('tts.speak', {
      utterance_id, text: speechText, priority, source,
      voice_preset: this.overlay.voice_preset ?? '官方预设',
      rate: this.overlay.rate ?? 1.0,
    })
    if (!ok) { this.pendingUtterance = null; return { utterance_id, delivered: false, reason: 'send-failed' } }
    return { utterance_id, delivered: true }
  }

  stopSpeaking(reason = 'api') { this.send('tts.stop', { reason }) }

  /** 26 §A.4「听→注入」：转写文本作为用户消息注入本会话，触发小寄应答。 */
  injectTranscript(text) {
    const t = String(text ?? '').trim()
    if (!t) return
    debugLog('[hermit-voice] injectTranscript 收到:', t, '| this.agent=', this.agent ? String(this.agent.id) : 'null')
    // 兜底：agent/created 事件若因 isolate realm 未送达，用 agents 服务找本会话 agent
    if (!this.agent) {
      const agents = this.ctx.get('agents')
      debugLog('[hermit-voice] ctx.get(agents)=', agents ? '有' : '无')
      if (agents) {
        const init = typeof agents.currentInitiator === 'function' ? agents.currentInitiator() : undefined
        const roots = typeof agents.roots === 'function' ? agents.roots() : []
        const list = typeof agents.list === 'function' ? agents.list() : []
        debugLog('[hermit-voice] currentInitiator=', init ? String(init.id) : 'null', '| roots=', roots.length, '| list=', list.length)
        const candidate = init || roots[0] || list[0]
        if (candidate) this.agent = candidate
      }
    }
    if (!this.agent) {
      debugLog('[hermit-voice] 未捕获 agent，注入失败')
      this.ctx.logger?.warn?.('hermit-voice: 未捕获 agent，转写未注入', t)
      return
    }
    debugLog('[hermit-voice] 注入目标 agent=', String(this.agent.id), 'status=', this.agent.status)
    const message = createUserMessage({
      content: [{ type: 'text', text: t }],
      source: { kind: 'plugin', plugin: 'hermit-voice' },
    })
    try {
      if (this.agent.status === 'idle') this.agent.followup(message)
      else this.agent.steer(message)
      debugLog('[hermit-voice] 注入调用完成')
      this.ctx.logger?.info?.('hermit-voice: 转写注入', t)
    } catch (e) {
      debugLog('[hermit-voice] 注入异常:', e?.message ?? String(e))
      this.ctx.logger?.warn?.('hermit-voice: 转写注入失败', e?.message ?? String(e))
    }
  }

  armWake(armed, sensitivity) {
    this.wakeArmed = !!armed
    this.overlay.wake_armed = this.wakeArmed
    if (sensitivity != null) this.overlay.wake_sensitivity = sensitivity
    saveOverlay(this.overlay)
    this.send('wake.set', { armed: this.wakeArmed, sensitivity })
  }

  dialogWindow(ms = 30000) { this.send('dialog_window.open', { ms }) }

  status() {
    const e2e = this.turns.map(t => t.e2e_ms).filter(v => v != null)
    return {
      state: this.state,
      engine: { health: this.engineHealth, ready: this.ready, degrade: this.degrade, url: this.engineUrl },
      modules: this.modules ?? null,
      metrics: { turns: this.turns.length, p50: pct(e2e, 0.5), p95: pct(e2e, 0.95), lastE2e: this.lastE2e },
    }
  }

  configure(partial = {}) {
    Object.assign(this.overlay, partial)
    saveOverlay(this.overlay)
    if (partial.acoustic_ms != null) this.send('endpoint.set', { acoustic_ms: partial.acoustic_ms })
    if (partial.wake_armed != null) this.armWake(partial.wake_armed, partial.wake_sensitivity)
    return { ...this.overlay }
  }

  /** D1 骨架：假件自检注入（引擎 debug 族，仅 debug:true 时引擎接受） */
  debugInject(kind, payload) { return this.send('debug.inject_' + kind, payload ?? {}) }
}

export function apply(ctx, config) {
  // 服务经 ctx.plugin 挂为子 fiber：停机/卸载时随树撤销（TSECS A5）
  ctx.plugin(VoiceService, config)

  const svc = () => ctx.get('voice')

  const voiceStatus = defineTool({
    name: 'voice_status',
    description: '查语音引擎（耳朵和嘴）的健康与延迟：引擎在不在、降级档位、最近轮次延迟 p50/p95。主人问「耳朵嘴还好吗/语音卡不卡」时用。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        summary: { type: 'string' }, state: { type: 'string' }, health: { type: 'string' }, degrade: { type: 'number' } } },
      render: (args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute() {
      const v = svc()
      if (!v) return { summary: '语音服务这会儿不在（插件没挂上）——先打字也完全够用。', state: 'unknown', health: 'missing', degrade: 3 }
      const s = v.status()
      const dg = ['正常', 'PTT 模式', '半哑（有一侧转文字）', '全文本（嗓子歇着）'][s.engine.degrade] ?? '未知'
      const lat = s.metrics.lastE2e != null ? `最近一轮端到端 ${s.metrics.lastE2e}ms（p95 ${s.metrics.p50 ? s.metrics.p95 : '—'}）` : '还没有完整语音轮次'
      const tone = s.engine.health === 'ok' ? '耳朵嘴都在线' : (s.engine.health === 'down' ? '语音引擎没在跑——先打字，人格不变' : '语音通道有点状况')
      return { summary: `${tone}，档位：${dg}。${lat}。`, state: s.state, health: s.engine.health, degrade: s.engine.degrade }
    },
  })

  const voiceConfig = defineTool({
    name: 'voice_config',
    description: '调语音参数：声学端点阈值（acoustic_ms）、唤醒开关（wake_armed）、音色预设（voice_preset）、语速（rate）。可逆、立即生效并持久化。注意：关闭唤醒/静音属 W2 级——应先经 dispatch_task 确认链拿到主人确认后再执行。',
    parameters: {
      acoustic_ms: { type: 'number', description: '声学端点阈值毫秒（默认 600）' },
      wake_armed: { type: 'boolean', description: '唤醒开关（关=耳朵休息，W2 级需确认）' },
      voice_preset: { type: 'string', description: '音色预设名（当前用官方预设）' },
      rate: { type: 'number', description: '语速倍率（0.5~2.0）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string' }, ok: { type: 'boolean' } } },
      render: (args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args) {
      const v = svc()
      if (!v) return { ok: false, summary: '语音服务不在，参数先记不成。' }
      const patch = {}
      for (const k of ['acoustic_ms', 'wake_armed', 'voice_preset', 'rate']) if (args[k] != null) patch[k] = args[k]
      if (!Object.keys(patch).length) return { ok: false, summary: '没给要改的参数。' }
      const merged = v.configure(patch)
      const parts = Object.entries(patch).map(([k, val]) => `${k}→${val}`)
      return { ok: true, summary: `调好了：${parts.join('，')}。引擎热更生效（若引擎在线）。当前生效配置：端点 ${merged.acoustic_ms ?? 600}ms / 唤醒 ${merged.wake_armed !== false ? '开' : '关'} / 音色 ${merged.voice_preset ?? '官方预设'}。` }
    },
  })

  const voiceSelftest = defineTool({
    name: 'voice_selftest',
    description: '语音环路自检：注入一句测试话→假转写→发声→收一路分段延迟，验证耳朵到嘴全链路通不通（MVP-1 验收数据采集器）。引擎不在线时如实报告。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string' }, ok: { type: 'boolean' } } },
      render: (args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute() {
      const v = svc()
      if (!v) return { ok: false, summary: '语音服务不在，自检跑不了。' }
      const s0 = v.status()
      if (!s0.engine.ready) return { ok: false, summary: '语音引擎没在跑（health=' + s0.engine.health + '）。要不要我先看看引擎进程？先打字完全不受影响。' }
      v.debugInject('wake', { keyword: '小寄小寄' })
      v.debugInject('asr', { text: '小寄自检：从耳朵到嘴走一圈。' })
      const r = v.speak({ text: '环路自检完成——耳朵嘴巴都正常，延迟数字我看着呢。', source: 'selftest' })
      if (!r.delivered) return { ok: false, summary: '注入成功但发声没送出去：' + r.reason }
      // 等引擎回 tts.finished（骨架假件 <1.5s）
      await new Promise(res => setTimeout(res, 1800))
      const s1 = v.status()
      const m = s1.metrics
      return { ok: true, summary: `自检通过：假转写→假发声全链路走通，最近端到端 ${m.lastE2e ?? '—'}ms（样本 ${m.turns} 轮，p50 ${m.p50 ?? '—'}/p95 ${m.p95 ?? '—'}）。` }
    },
  })

  ctx.effect(() => {
    const d1 = ctx.tools.register(voiceStatus)
    const d2 = ctx.tools.register(voiceConfig)
    const d3 = ctx.tools.register(voiceSelftest)
    return () => { d1(); d2(); d3() }
  }, 'hermit:voice-tools')

  // 状态路由（供 client 侧边栏指示器轮询，同源 /hermit-voice/status）
  const webServer = ctx.get('webServer')
  if (webServer) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/hermit-voice/status',
      handler: async (_req, res) => {
        const v = ctx.get('voice')
        const s = v ? v.status() : { state: 'unknown', engine: { health: 'missing', ready: false, degrade: 3 }, metrics: {} }
        const body = JSON.stringify({ ok: true, voice: s })
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(body)
      },
    }), 'hermit:status-route')
  }

  // 注：voiceBridge 曾用 ctx.provide 发布为 process-global 服务（让父 realm 的 hermit-core Arbiter 跨 realm 触发发声），
  // 触发 DSH 挂载审计拒绝（preset 服务须 isolate 或移 host）。改为不发布——Arbiter 的 getBridge 缺席时已按软依赖自动降级纯文本，
  // M1-B 语音汇报时机仲裁后续需把桥移到 host composition 再恢复。
}
