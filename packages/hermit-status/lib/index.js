/**
 * hermit-status — 小寄各模块（麦克风/模型/声音/摄像头）生效状态的 host 层状态面板。
 *
 * 为什么在 host 层（profile bundle）而不是 agent 层（preset）：
 *  - 语音引擎是独立单例进程（ws=8300 / http=8301），其健康状态是 host 级、跨会话共享的；
 *  - DSH 的 client bundle 只由 host loader 的 entries 服务（/plugins/<id>/client.js），
 *    agent 层插件的 dsh.client 不会被浏览器加载（已实测 404）。
 *
 * 本插件职责（单一）：
 *  - host 半边：注册同源 /hermit/status 路由，聚合引擎 8301 /healthz（引擎+模型分开）
 *    与 agentDefaultModel（大脑 LLM 云端模型）→ 返回结构化模块/模型状态；
 *  - client 半边：侧边栏「🦀 Hermit 状态」多栏卡片（指示灯 绿/黄/红 + 云端/本地徽标）。
 * 所有副作用经 ctx.effect 注册 disposer（TSECS A2 可逆）。
 *
 * @module hermit-status
 */
import http from 'node:http'
import z from '@deepseek-ai/schemastery'

export const name = 'hermit-status'
export const inject = ['webServer']

export const Config = z.object({
  wsPort: z.number().default(8300),
  healthzPort: z.number().default(8301),
})

const MODEL_SHORT = {
  'funasr-streaming-paraformer-zh-en': 'Paraformer',
  'kws-zipformer-wenetspeech-3.3M': 'Zipformer',
  'kokoro-multi-lang-v1_0': 'Kokoro',
  'silero-vad': 'Silero',
}

/** 探测引擎 HTTP 端点，返回 {status, body} 或 null（不可达/超时）。 */
function probeEngine(port, path) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 1500 }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, body: data }) })
    })
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.on('error', () => { resolve(null) })
  })
}

/** 云端/本地判断：本地推理框架 → local，其余按云端 API 处理。 */
function modelLoc(provider) {
  const p = String(provider ?? '').toLowerCase()
  if (/(llama|ollama|local|vllm|llamacpp|gguf|ggml|kobold)/.test(p)) return 'local'
  return 'cloud'
}

/** 状态归一：ok→ok；fake/off→warn（降级）；error/down/missing→down。 */
function norm(status) {
  if (status === 'ok') return 'ok'
  if (status === 'fake' || status === 'off') return 'warn'
  return 'down'
}

/** 引擎模块（modules）→ 引擎卡片数组。 */
function enginesOf(modules) {
  const m = modules ?? {}
  const mic = m.mic
  const micStatus = mic === 'ok' ? 'ok' : (mic === 'off' ? 'down' : 'down')
  const micDetail = mic === 'ok' ? '监听中' : (mic === 'off' ? '关' : '异常')
  const asrReal = m.asr === 'real'
  const kwsOn = m.kws === 'on'
  const ttsOn = m.tts === 'on'
  const bargeOn = m.barge_vad === 'on'
  return [
    { id: 'mic', label: '麦克风', status: micStatus, detail: micDetail },
    { id: 'kws', label: '唤醒', status: kwsOn ? 'ok' : 'warn', detail: kwsOn ? '已开' : '关' },
    { id: 'asr', label: '识别', status: asrReal ? 'ok' : 'warn', detail: asrReal ? '流式' : '假件' },
    { id: 'tts', label: '合成', status: ttsOn ? 'ok' : 'warn', detail: ttsOn ? '已开' : '假件' },
    { id: 'barge', label: '打断', status: bargeOn ? 'ok' : 'warn', detail: bargeOn ? 'VAD' : '关' },
    { id: 'camera', label: '摄像头', status: 'down', detail: 'MVP-2' },
  ]
}

/** 引擎模型（models[]）+ 大脑 LLM → 模型卡片数组（含 loc 云端/本地）。 */
function modelsOf(models, llmSel) {
  const out = []
  for (const mdl of models ?? []) {
    const name = mdl.name ?? mdl.kind
    out.push({
      id: mdl.kind,
      label: (mdl.kind ?? '').toUpperCase(),
      name: MODEL_SHORT[name] ?? name,
      loc: 'local',
      status: norm(mdl.status),
    })
  }
  if (llmSel) {
    out.push({
      id: 'llm',
      label: '大脑',
      name: llmSel.model ?? (llmSel.provider ?? 'LLM'),
      provider: llmSel.provider ?? null,
      loc: modelLoc(llmSel.provider),
      status: 'ok',
    })
  } else {
    out.push({ id: 'llm', label: '大脑', name: '未配置', loc: 'cloud', status: 'down' })
  }
  return out
}

export function apply(ctx, config) {
  const wsPort = config?.wsPort ?? 8300
  const healthzPort = config?.healthzPort ?? 8301

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/hermit/status',
    handler: async (_req, res) => {
      const probe = await probeEngine(healthzPort, '/healthz')
      const engineUp = probe !== null && probe.status === 200
      let eng = null
      if (engineUp) {
        try { eng = JSON.parse(probe.body) } catch { engineUp = false }
      }

      const modules = engineUp ? eng.modules : null
      const models = engineUp ? eng.models : []

      // 大脑 LLM：读默认模型选择（无则标记未配置）
      let llmSel = null
      try {
        const svc = ctx.get('agentDefaultModel')
        if (svc && typeof svc.currentSelection === 'function') llmSel = svc.currentSelection()
      } catch { /* 无模型服务时降级 */ }

      const engines = enginesOf(modules)
      const engineHealth = !engineUp ? 'down' : 'ok'

      const payload = {
        ok: true,
        state: engineUp ? (eng.state ?? null) : null,
        engine: {
          health: engineHealth,
          ready: engineUp,
          degrade: engineUp ? 0 : 3,
          url: `ws://127.0.0.1:${wsPort}/voice`,
          uptime_s: engineUp ? (eng.uptime_s ?? null) : null,
        },
        engines,
        models: modelsOf(models, llmSel),
      }
      const body = JSON.stringify(payload)
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(body)
    },
  }), 'hermit-status:route')
}
