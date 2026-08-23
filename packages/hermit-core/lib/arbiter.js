/**
 * arbiter.js — M1-B 汇报时机仲裁（03 §3.3 + 07 §六 + 26 §A.4）
 *
 * 职责：接收「任务汇报/主动发起」条目 → 按优先级×时机矩阵决定何时发声。
 * 只消费 speak 出口（经 voiceBridge 桥；isolate 下父 realm 拿不到 ctx.voice 本体）。
 * 纯逻辑核心 + 注入事件钩子：事件接线在 hermit-core/index.js，本模块可独立单测。
 *
 * 时机矩阵（03 §3.3）：
 *  - urgent（P0-urgent）：非 speaking 且未 pause → 立即派发（插队最前）
 *  - normal（P0/P1）：用户沉默 > silentMs 才派发；speaking 中等待 voice/state idle
 *  - batch（P2）：攒批 ≥3 条合并，或 batchWindowMs 到期（MVP 简化，07 调度器后续增强）
 *
 * 铁律：打断不罚（12 §4.1）——barge_in 后被打断内容退回队列缩写重述，不丢。
 * 降级：bridge 缺席（语音引擎不在）→ 全部 no-op，纯文本模式（26 §五 D3）。
 */
export function createArbiter({
  getBridge,
  on,
  now = Date.now,
  silentMs = 2000,          // normal 汇报需用户沉默窗口（03：沉默 >2s）
  batchWindowMs = 5 * 60 * 1000,  // batch 攒批窗口
}) {
  const queue = []
  let paused = false        // 用户开口 → 暂停派发（03 §3.3 pause）
  let speaking = false      // TTS 播报中（乐观锁 + voice/state 校准）
  let lastUserSpeech = now()
  let batchTimer = null

  function voice() { return getBridge ? getBridge() : undefined }

  /** 入队并尝试派发。返回条目 id（幂等/追踪用）。 */
  function submit({ text, priority = 'normal', source = 'task' }) {
    if (!text || !String(text).trim()) return null
    const id = 'arb_' + now().toString(36) + '_' + Math.random().toString(36).slice(2, 6)
    queue.push({ id, text: String(text).trim(), priority, source, ts: now(), resumed: false })
    schedule()
    return id
  }

  /** 用户开口 → 暂停派发（队列不丢） */
  function pause() { paused = true; clearBatchTimer() }

  /** 恢复派发（用户沉默结束 / 语义间隙） */
  function resume() { paused = false; schedule() }

  function pendingCount() { return queue.length }

  /** 外部校准说话态（speak 乐观锁失败时复位；voice/state 事件亦校准） */
  function setSpeaking(v) { speaking = !!v; if (!v) schedule() }

  function schedule() {
    if (!voice()) return            // 引擎不在 → 纯文本降级，不派发
    if (paused || speaking || !queue.length) return
    const batch = collectBatch()
    if (!batch) return
    const text = batch.length === 1 ? batch[0].text : batch.map(e => e.text).join('；')
    const priority = batch.length > 1 ? 'batch' : batch[0].priority
    queue.splice(0, batch.length)   // 派发即出队；barge-in 退回时重新 submit
    speaking = true                 // 乐观锁
    let r = null
    try { r = voice().speak({ text, priority, source: 'arbiter' }) } catch { r = null }
    if (!r || r.delivered === false) speaking = false   // 未送达 → 恢复可派发（引擎 down/send 失败）
  }

  function collectBatch() {
    // urgent 插队最前（07：P0-urgent 穿透一切，P0 汇报 normal 不插队）
    const ui = queue.findIndex(e => e.priority === 'urgent')
    if (ui >= 0) return [queue[ui]]
    // normal：需要用户沉默窗口（03：当前话题结束或沉默 >2s）
    if (now() - lastUserSpeech < silentMs) return null
    const normals = queue.filter(e => e.priority !== 'batch')
    if (normals.length) return [normals[0]]
    // batch：≥3 条合并，或窗口到期
    const batches = queue.filter(e => e.priority === 'batch')
    if (batches.length >= 3) return batches.slice(0, 3)
    if (batches.length && !batchTimer) {
      batchTimer = setTimeout(() => { batchTimer = null; schedule() }, batchWindowMs)
    }
    return null
  }

  function clearBatchTimer() { if (batchTimer) { clearTimeout(batchTimer); batchTimer = null } }

  // 事件接线（跨 realm 事件：未 isolate 的事件名两边 isolate key 同为 undefined → 可传播）
  const disposers = []
  if (on) {
    disposers.push(on('voice/state', (e) => {
      const to = e && e.to
      if (to === 'speaking') { speaking = true; return }
      if (to === 'listening') { paused = true; lastUserSpeech = now(); return }   // 用户开口
      if (to === 'idle') { speaking = false; paused = false; schedule() }         // 说完/播完 → 语义间隙
    }))
    disposers.push(on('voice/transcript.partial', () => { lastUserSpeech = now(); paused = true }))
    disposers.push(on('voice/barge_in', (e) => {
      speaking = false
      // 打断不罚（12 §4.1）：被打断内容退回队列，缩写重述
      if (e && e.pending_resume) {
        const t = String(e.pending_resume).trim()
        if (t) submit({ text: '刚说到一半——' + t.slice(0, 60) + (t.length > 60 ? '…' : ''), priority: 'normal', source: 'barge_resume' })
      }
      schedule()
    }))
  }

  return {
    submit, pause, resume, pendingCount, setSpeaking,
    dispose() { disposers.forEach(d => d()); clearBatchTimer() },
  }
}
