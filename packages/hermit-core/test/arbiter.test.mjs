/**
 * arbiter.test.mjs — M1-B Arbiter 纯逻辑单测（mock bridge + mock on）
 * 运行：node packages/hermit-core/test/arbiter.test.mjs
 */
import { createArbiter } from '../lib/arbiter.js'

let passed = 0
let failed = 0
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`) }
  else { failed++; console.log(`  ❌ ${name} ${extra}`) }
}

/** 可注入时钟 + 记录 speak 调用的 mock 环境 */
function makeEnv({ silentMs = 2000 } = {}) {
  let t = 1000
  const calls = []
  const listeners = {}
  const bridge = {
    speak(args) { calls.push({ ...args, at: t }); return { utterance_id: 'x', delivered: true } },
  }
  const env = {
    now: () => t,
    tick(ms) { t += ms },
    calls,
    emit(name, payload) { (listeners[name] || []).forEach(cb => cb(payload)) },
    arb: null,
    bridge,
  }
  env.arb = createArbiter({
    getBridge: () => env.bridge,
    on: (name, cb) => {
      (listeners[name] = listeners[name] || []).push(cb)
      return () => { listeners[name] = (listeners[name] || []).filter(c => c !== cb) }
    },
    now: () => t,
    silentMs,
  })
  return env
}

console.log('T1 urgent 立即派发（非 speaking、未 pause）')
{
  const e = makeEnv()
  const id = e.arb.submit({ text: '主人，任务失败了', priority: 'urgent' })
  check('urgent 立即 speak', e.calls.length === 1, JSON.stringify(e.calls))
  check('text 正确', e.calls[0]?.text === '主人，任务失败了')
  check('priority=urgent', e.calls[0]?.priority === 'urgent')
  check('返回 id', typeof id === 'string' && id.startsWith('arb_'))
  check('派发即出队', e.arb.pendingCount() === 0)
}

console.log('T2 normal 需沉默窗口')
{
  const e = makeEnv()
  e.arb.submit({ text: '「X」办好了', priority: 'normal' })
  check('沉默窗口内不派发', e.calls.length === 0)
  e.tick(2500) // 超过 silentMs
  e.arb.submit({ text: '「Y」也办好了', priority: 'normal' }) // 再次 submit 触发 schedule
  check('沉默超时后派发', e.calls.length === 1, JSON.stringify(e.calls))
}

console.log('T3 batch ≥3 合并')
{
  const e = makeEnv()
  e.tick(3000)
  e.arb.submit({ text: 'A', priority: 'batch' })
  e.arb.submit({ text: 'B', priority: 'batch' })
  check('2 条 batch 不派发', e.calls.length === 0)
  e.arb.submit({ text: 'C', priority: 'batch' })
  check('3 条合并派发', e.calls.length === 1)
  check('合并文本', e.calls[0]?.text === 'A；B；C')
  check('合并 priority=batch', e.calls[0]?.priority === 'batch')
}

console.log('T4 pause 暂停 / resume 恢复')
{
  const e = makeEnv()
  e.tick(3000)
  e.arb.pause()
  e.arb.submit({ text: 'X', priority: 'normal' })
  check('pause 后不派发', e.calls.length === 0)
  e.arb.resume()
  check('resume 后派发', e.calls.length === 1)
}

console.log('T5 speaking 中不派发，结束复位后派发')
{
  const e = makeEnv()
  e.tick(3000)
  e.arb.setSpeaking(true)
  e.arb.submit({ text: 'X', priority: 'urgent' })
  check('speaking 中不派发', e.calls.length === 0)
  e.arb.setSpeaking(false)
  check('setSpeaking(false) 触发派发', e.calls.length === 1)
}

console.log('T6 barge_in 退回重述')
{
  const e = makeEnv()
  e.tick(3000)
  e.arb.submit({ text: 'X', priority: 'normal' })   // 派发
  e.arb.setSpeaking(false)                           // barge_in 前置复位
  e.emit('voice/barge_in', { pending_resume: '这条汇报的内容是：' + '很长的内容'.repeat(12) })
  check('barge 后重述入队并派发', e.calls.length === 2, JSON.stringify(e.calls.map(c => c.text)))
  check('重述带前缀且截断', e.calls[1]?.text.startsWith('刚说到一半——') && e.calls[1]?.text.includes('…'))
}

console.log('T7 bridge 缺席 → no-op')
{
  const listeners = {}
  const arb = createArbiter({ getBridge: () => undefined, on: (n, cb) => { listeners[n] = cb; return () => {} } })
  const id = arb.submit({ text: 'X', priority: 'urgent' })
  check('返回 id 但入队不派发', typeof id === 'string' && arb.pendingCount() === 1)
}

console.log('T8 speak 失败（delivered:false）→ 乐观锁复位可再派发')
{
  let fail = true
  const e = makeEnv()
  e.bridge.speak = (args) => { e.calls.push(args); return fail ? { utterance_id: 'x', delivered: false } : { utterance_id: 'x', delivered: true } }
  e.tick(3000)
  e.arb.submit({ text: 'X', priority: 'urgent' })
  check('delivered:false 后复位（再次 submit 可派发）', e.calls.length === 1)
  fail = false
  e.tick(3000)
  e.arb.submit({ text: 'Y', priority: 'urgent' })
  check('复位后再次派发成功', e.calls.length === 2)
}

console.log('T9 voice/state 事件接线')
{
  const e = makeEnv()
  e.tick(3000)
  e.emit('voice/state', { from: 'idle', to: 'speaking' })
  e.arb.submit({ text: 'X', priority: 'urgent' })
  check('speaking 事件阻止派发', e.calls.length === 0)
  e.emit('voice/state', { from: 'speaking', to: 'idle' })
  check('idle 事件触发派发', e.calls.length === 1)
  e.emit('voice/state', { from: 'idle', to: 'listening' })
  e.arb.submit({ text: 'Y', priority: 'urgent' })
  check('listening（用户开口）暂停派发', e.calls.length === 1)
  e.tick(5000)
  e.emit('voice/state', { from: 'listening', to: 'idle' })
  check('回到 idle 恢复派发', e.calls.length === 2)
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed) process.exit(1)
