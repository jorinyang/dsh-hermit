/**
 * bridge-scope.test.mjs — 验证 isolate 语义：isolate 服务对父不可见，未 isolate 服务（voiceBridge）跨 realm 可见。
 * 运行：node packages/hermit-core/test/bridge-scope.test.mjs
 */
import { Context, Service } from '@deepseek-ai/cordis'

let passed = 0, failed = 0
const check = (name, cond, extra = '') => { cond ? (passed++, console.log(`  ✅ ${name}`)) : (failed++, console.log(`  ❌ ${name} ${extra}`)) }

// 模拟 hermit-voice：isolate realm 内提供 voice（isolate）+ voiceBridge（未 isolate）
class FakeVoice extends Service {
  constructor(ctx) { super(ctx, 'voice') }
  speak(args) { return { utterance_id: 'x', delivered: true, echoed: args.text } }
}

const root = new Context()
// 与 agent.cordis.yml 相同结构：voice 组 isolate: {voice: true}
const voiceRealm = root.isolate('voice')
voiceRealm.plugin(FakeVoice)

// hermit-voice apply 里补的桥（未 isolate）：svc() 取 voice 本体
voiceRealm.provide('voiceBridge', {
  speak: (args) => { const v = voiceRealm.get('voice'); return v ? v.speak(args) : null },
})

// 等 Service 异步注册完成（cordis plugin 启动在 fiber 内）
await new Promise(r => setTimeout(r, 50))

// 父 realm（hermit-core 所在）的视角
check('父 get voice = undefined（isolate 隔离）', root.get('voice') === undefined)
const bridge = root.get('voiceBridge')
check('父 get voiceBridge 可见（未 isolate 跨 realm）', !!bridge && typeof bridge.speak === 'function')
if (bridge) {
  const r = bridge.speak({ text: '主人，「X」办好了', priority: 'normal' })
  check('桥 speak 转发到 voice 本体', r && r.delivered && r.echoed === '主人，「X」办好了', JSON.stringify(r))
}
// 软依赖安全：桥缺席时父逻辑 no-op（get 返回 undefined 不抛）
check('桥缺席场景 get 返回 undefined 不抛', (() => { try { return root.get('no-such-bridge') === undefined } catch { return false } })())

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed) process.exit(1)
