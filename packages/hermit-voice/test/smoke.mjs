/**
 * smoke.mjs — hermit-voice 插件离线冒烟（node test/smoke.mjs，需引擎已在 127.0.0.1:8300）。
 * 真 cordis Context + 假 tools 服务 + 真 WS 桥连引擎骨架：验证服务注册/桥接/事件/工具三连。
 */
import { Context, Service } from '@deepseek-ai/cordis'
import * as voice from '../lib/index.js'

class FakeTools extends Service {
  static registered = []
  constructor(ctx) { super(ctx, 'tools') }
  register(tool) { FakeTools.registered.push(tool.name); return () => {} }
}

const results = []
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? '  ' + detail : ''}`) }

const ctx = new Context()
const rtTools = ctx.plugin(FakeTools)
const rtVoice = ctx.plugin(voice, { port: 8300 })

const events = []
for (const ev of ['voice/state', 'voice/engine_status', 'voice/transcript.final', 'voice/metrics', 'voice/wake', 'voice/barge_in']) {
  ctx.on(ev, (p) => events.push([ev, p]))
}

await new Promise(r => setTimeout(r, 1500)) // 桥接：connect → hello → ready

console.log('== service ==')
const v = ctx.get('voice')
check('ctx.voice 可用', !!v)
const s = v.status()
check('engine.ready 协商', s.engine.ready === true && s.engine.health === 'ok', `degrade=${s.engine.degrade}`)

console.log('== tools ==')
check('注册 3 个工具', FakeTools.registered.filter(n => n.startsWith('voice_')).length === 3, FakeTools.registered.join(','))

console.log('== bridge loop ==')
v.debugInject('wake', { keyword: '小寄小寄' })
v.debugInject('asr', { text: '冒烟测试一句话。' })
await new Promise(r => setTimeout(r, 700))
const r1 = v.speak({ text: '冒烟发声。', source: 'selftest' })
check('speak delivered', r1.delivered === true, r1.utterance_id)
await new Promise(r => setTimeout(r, 5000)) // 真 TTS 合成(~1.4s)+播放(~1s)，等 tts.finished 到位
check('voice/wake 事件', events.some(([e]) => e === 'voice/wake'))
check('voice/transcript.final 事件', events.some(([e]) => e === 'voice/transcript.final'))
check('voice/state 到 processing', events.some(([e, p]) => e === 'voice/state' && p.to === 'processing'))
check('voice/metrics 事件（端到端）', events.some(([e]) => e === 'voice/metrics'))
const s2 = v.status()
check('metrics 采样入账', s2.metrics.turns >= 1 && s2.metrics.lastE2e > 0, `lastE2e=${s2.metrics.lastE2e}ms`)

console.log('== dispose（A2 可逆，LIFO）==')
rtVoice.dispose(); rtTools.dispose()
await new Promise(r => setTimeout(r, 400))
const v2 = ctx.get('voice')
check('dispose 后服务下线/桥断开', !v2 || v2.ready !== true, `ctx.get('voice')=${v2 ? 'stale-ready=' + v2.ready : 'undefined'}`)

const failed = results.filter(([, ok]) => !ok)
console.log(`\n===== ${results.length - failed.length}/${results.length} passed =====`)
process.exit(failed.length ? 1 : 0)
