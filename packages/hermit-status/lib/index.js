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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
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

/** 向引擎发 POST JSON，返回 {status, body} 或 null。 */
function postEngine(port, path, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload ?? {})
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 1500,
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, body: data }) })
    })
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.on('error', () => { resolve(null) })
    req.write(body)
    req.end()
  })
}

/** 云端/本地判断：本地推理框架 → local，其余按云端 API 处理。 */
function modelLoc(provider) {
  const p = String(provider ?? '').toLowerCase()
  if (/(llama|ollama|local|vllm|llamacpp|gguf|ggml|kobold)/.test(p)) return 'local'
  return 'cloud'
}

/** 读 web profile 的 bundle 清单（host 层插件），标注启用/禁用。 */
function readProfileBundles() {
  try {
    const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
    const pkg = JSON.parse(fs.readFileSync(path.join(home, 'profiles', 'web', 'package.json'), 'utf8'))
    const bundles = pkg?.dsh?.profile?.bundles ?? []
    const disabled = pkg?.dsh?.profile?.disabledBundles ?? []
    return bundles.map((name) => ({ id: name, name, enabled: !disabled.includes(name), kind: 'host' }))
  } catch { return [] }
}

/** 本机已安装的 CLI 工具清单：在 PATH 中探测精选名单（不扫描全 PATH，避免系统噪音）。 */
const KNOWN_CLIS = [
  // DSH / AI 生态
  'dsh', 'bl',
  // 版本控制
  'git', 'gh',
  // 运行时 / 包管理
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'uv', 'pip', 'pip3',
  // 语言工具链
  'python', 'python3', 'cargo', 'rustc', 'go', 'java', 'gcc', 'g++', 'cmake', 'make',
  // 容器 / 云
  'docker', 'kubectl', 'helm', 'terraform', 'aws', 'gcloud', 'az',
  // 系统 / 网络
  'pwsh', 'powershell', 'winget', 'choco', 'scoop', 'wsl', 'ssh', 'curl', 'ffmpeg',
]

/** reg.exe 全路径（受限 PATH 下不依赖 PATH 解析）。 */
const REG_EXE = 'C:\\Windows\\System32\\reg.exe'

/** 读一个注册表环境键的全部值 → {名:值}（Windows）。 */
function readRegistryEnv(key) {
  const map = {}
  try {
    const out = execFileSync(REG_EXE, ['query', key], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s{4}(\S+)\s+REG_\S+\s+(.*)$/)
      if (m) map[m[1]] = m[2].trim()
    }
  } catch { /* 键不可读则返回空 */ }
  return map
}

/** 展开 %VAR% 占位符（注册表 REG_EXPAND_SZ 的 PATH 里常用，如 %NVM_HOME%）。 */
function expandEnvVars(s, env) {
  return String(s).replace(/%([^%]+)%/g, (_m, k) => (env[k] != null ? env[k] : `%${k}%`))
}

function readInstalledClis() {
  try {
    // 进程 PATH 可能因受限启动而残缺：从注册表补齐系统+用户真实 PATH（Windows），否则退回进程 PATH
    const sysEnv = process.platform === 'win32'
      ? readRegistryEnv('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment')
      : {}
    const usrEnv = process.platform === 'win32' ? readRegistryEnv('HKCU\\Environment') : {}
    const env = { ...process.env, ...sysEnv, ...usrEnv }   // 供 %VAR% 展开
    const dirs = []
    const pushDirs = (p) => {
      for (const d of String(p ?? '').split(path.delimiter)) {
        const x = expandEnvVars(d, env).trim()
        if (x && !dirs.includes(x)) dirs.push(x)
      }
    }
    if (process.platform === 'win32') {
      pushDirs(sysEnv.Path)
      pushDirs(usrEnv.Path)
    }
    pushDirs(process.env.PATH)

    const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.ps1'] : ['']
    const found = []
    for (const name of KNOWN_CLIS) {
      let hit = null
      for (const dir of dirs) {
        for (const ext of exts) {
          const p = path.join(dir, name + ext)
          if (fs.existsSync(p)) { hit = p; break }
        }
        if (hit) break
      }
      if (hit) found.push({ name, path: hit })
    }
    return found
  } catch { return [] }
}

/** 状态归一：ok→ok；fake/off→warn（降级）；error/down/missing→down。 */
function norm(status) {
  if (status === 'ok') return 'ok'
  if (status === 'fake' || status === 'off') return 'warn'
  return 'down'
}

/** 引擎模块（modules + toggles）→ 引擎卡片数组（含开关态 toggleable/on）。 */
function enginesOf(modules, toggles) {
  const m = modules ?? {}
  const t = toggles ?? {}
  const mic = m.mic
  const micMuted = !!t.mic_muted
  const cameraOn = !!t.camera_enabled
  const kwsOn = m.kws === 'on'
  const asrReal = m.asr === 'real'
  const ttsOn = m.tts === 'on'
  const bargeOn = m.barge_vad === 'on'
  const wakeMode = t.wake_mode ?? 'voice'
  const wakeStatus = wakeMode === 'voice' ? 'ok' : (wakeMode === 'hotkey' ? 'warn' : 'down')
  const wakeDetail = wakeMode === 'voice' ? '语音唤醒' : (wakeMode === 'hotkey' ? '按键唤醒' : '已关闭')
  return [
    // 麦克风：三态——使用中(ok绿) / 已断开(down红) / 已关闭(off灰)
    { id: 'mic', label: '麦克风', status: micMuted ? 'off' : (mic === 'ok' ? 'ok' : 'down'), detail: micMuted ? '已关闭' : (mic === 'ok' ? '使用中' : '已断开'), toggleable: true, on: !micMuted },
    // 摄像头：三态——使用中(ok绿, 待真实摄像头) / 已断开(down红) / 已关闭(off灰)
    { id: 'camera', label: '摄像头', status: cameraOn ? 'down' : 'off', detail: cameraOn ? '已断开' : '已关闭', toggleable: true, on: cameraOn },
    // 以下：绿=正常 / 红=错误
    // 唤醒：三态——语音唤醒(ok绿) / 按键唤醒(warn橙) / 关闭=免唤醒持续对话(down红)
    { id: 'kws', label: '唤醒', status: wakeStatus, detail: wakeDetail, toggleable: true, mode: wakeMode },
    { id: 'asr', label: '识别', status: asrReal ? 'ok' : 'down', detail: asrReal ? '正常' : '错误' },
    { id: 'tts', label: '合成', status: ttsOn ? 'ok' : 'down', detail: ttsOn ? '正常' : '错误' },
    { id: 'barge', label: '打断', status: bargeOn ? 'ok' : 'down', detail: bargeOn ? '正常' : '错误' },
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

  // 思考/运行状态：订阅 agent/status（host 根 ctx 可监听），维护当前会话的运行态
  const agentState = { running: false, status: 'idle', sessionId: null }
  ctx.effect(() => ctx.on('agent/status', ({ agent, status }) => {
    agentState.running = status === 'running'
    agentState.status = status ?? 'idle'
    agentState.sessionId = agent?.id ?? null
  }), 'hermit-status:agent-status')

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

      const engines = enginesOf(modules, engineUp ? (eng.toggles ?? {}) : {})
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
        // 思考/运行态 + 输出态（说话）：供左侧状态面板
        agent: {
          running: agentState.running,
          status: agentState.status,
          sessionId: agentState.sessionId,
          thinking: agentState.running,
          speaking: engineUp && eng.state === 'speaking',
        },
        engines,
        models: modelsOf(models, llmSel),
        toggles: engineUp ? (eng.toggles ?? null) : null,
      }
      const body = JSON.stringify(payload)
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(body)
    },
  }), 'hermit-status:route')

  // 实时电平路由（供侧边栏波形可视化，客户端高频轮询；代理引擎 8301 /level）
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/hermit/level',
    handler: async (_req, res) => {
      const probe = await probeEngine(healthzPort, '/level')
      if (probe === null || probe.status !== 200) {
        const body = JSON.stringify({ ok: false, levels: [], peak: 0, speaking: false, mic_active: false })
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(body)
        return
      }
      try {
        const data = JSON.parse(probe.body)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(data))
      } catch {
        const body = JSON.stringify({ ok: false, levels: [], peak: 0, speaking: false, mic_active: false })
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(body)
      }
    },
  }), 'hermit-status:level-route')

  // 资源目录路由（右侧「插件/技能/MCP」tab）：汇总三类可用资源
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/hermit/catalog',
    handler: async (_req, res) => {
      // 插件：profile bundles（host 层）
      const plugins = readProfileBundles()

      // 技能：skills 服务目录
      let skills = []
      try {
        const skillsSvc = ctx.get('skills')
        if (skillsSvc && typeof skillsSvc.list === 'function') {
          const list = await skillsSvc.list()
          skills = (list ?? []).map((s) => ({ name: s?.name ?? '', description: s?.description ?? '' }))
        }
      } catch { /* skills 不可用时降级 */ }

      // MCP：从 tools registry 提取 mcp__<server>__<tool>，按 server 分组
      let mcps = []
      try {
        const toolsSvc = ctx.get('tools')
        if (toolsSvc && typeof toolsSvc.schemas === 'function') {
          const schemas = toolsSvc.schemas() ?? []
          const byServer = new Map()
          for (const s of schemas) {
            const nm = s?.name ?? ''
            if (!nm.startsWith('mcp__')) continue
            const rest = nm.slice(5)
            const idx = rest.indexOf('__')
            if (idx < 0) continue
            const server = rest.slice(0, idx)
            if (!byServer.has(server)) byServer.set(server, { name: server, tools: [] })
            byServer.get(server).tools.push(rest.slice(idx + 2))
          }
          mcps = Array.from(byServer.values())
        }
      } catch { /* MCP tools 不可用时降级 */ }

      // CLI：本机 PATH 上已安装的 CLI 工具清单
      const clis = readInstalledClis()

      const body = JSON.stringify({ ok: true, plugins, skills, mcps, clis })
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(body)
    },
  }), 'hermit-status:catalog-route')

  // 引擎开关路由（左侧面板的麦克风/唤醒开关）：转发到引擎 8301 /engine/mic | /engine/wake
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/hermit/engine',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
        return
      }
      let raw = ''
      for await (const chunk of req) raw += chunk
      let body = {}
      try { body = JSON.parse(raw) } catch { /* 空体按 {} 处理 */ }
      const module = body.module
      const on = !!body.on
      if (module !== 'mic' && module !== 'wake' && module !== 'camera') {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'module must be mic|wake|camera' }))
        return
      }
      const enginePath = '/engine/' + module
      const payload = module === 'wake' ? { mode: body.mode ?? 'voice' } : { on }
      const r = await postEngine(healthzPort, enginePath, payload)
      if (r === null) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'engine unreachable' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(r.body)
    },
  }), 'hermit-status:engine-toggle-route')

  // 唤醒快捷键路由（右 Shift）：转发到引擎 /engine/trigger_wake
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/hermit/wake',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
        return
      }
      const r = await postEngine(healthzPort, '/engine/trigger_wake', { keyword: '快捷键' })
      if (r === null) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'engine unreachable' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(r.body)
    },
  }), 'hermit-status:wake-route')

  // 上次会话路由：4080 单会话模型——返回最近一个有内容的会话 id（供客户端启动时恢复）
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/hermit/last-session',
    handler: async (_req, res) => {
      let sessionId = null
      try {
        // 用持久化后端的 listSnapshots() 读磁盘会话：revision 串 "dev:ino:size:mtime:ctime" 里含文件大小，
        // 空白会话只有 header 行（压缩后 ~几百字节），有内容会话 >1KB；据此找最近一个有内容的主会话
        const persistence = ctx.get('sessionPersistence')
        if (persistence && typeof persistence.listSnapshots === 'function') {
          const snaps = await persistence.listSnapshots()
          const sizeOf = (rev) => Number(String(rev ?? '').split(':')[2]) || 0
          const mains = snaps
            .filter((s) => sizeOf(s?.revision) > 1000 && !s?.header?.parentSession)
            .sort((a, b) => (b?.header?.createdAt ?? 0) - (a?.header?.createdAt ?? 0))
          sessionId = mains[0]?.header?.id ?? null
        }
      } catch { /* 持久化服务不可用则返回 null */ }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ ok: true, sessionId }))
    },
  }), 'hermit-status:last-session-route')

  // host 侧 voiceBridge：跨 realm 触发 TTS 发声（agent 平面 hermit-core Arbiter 消费）。
  // 走引擎 HTTP /engine/tts 端点——不依赖 isolate realm 里的 ctx.voice 服务（host 拿不到）。
  // speak 用 fire-and-forget（与 ctx.voice.speak 的同步语义一致：立即返回乐观 delivered），
  // 播报生命周期由引擎的 state 事件（speaking→idle）驱动 Arbiter 锁复位。
  ctx.effect(() => ctx.provide('voiceBridge', {
    speak: (args) => {
      const utterance_id = 'utt_' + Math.random().toString(36).slice(2, 10)
      const text = String(args?.text ?? '').trim()
      if (!text) return { utterance_id, delivered: false, reason: 'empty-text' }
      postEngine(healthzPort, '/engine/tts', {
        utterance_id, text,
        priority: args?.priority ?? 'normal',
        source: args?.source ?? 'arbiter',
        rate: args?.rate ?? 1.0,
      }).catch(() => {})
      return { utterance_id, delivered: true }
    },
    stopSpeaking: () => {
      postEngine(healthzPort, '/engine/tts/stop', {}).catch(() => {})
    },
  }), 'hermit-status:voice-bridge')
}
