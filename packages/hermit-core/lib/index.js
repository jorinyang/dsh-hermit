/**
 * hermit-core — D2：Task 状态机 + 完成态追踪 + 持久化 + dispatch_task/task_status。
 *
 * 状态机：created → dispatched → working → completed|failed（→ reported 由前台即兴组织，非本层职责）
 * 持久化：$DSH_HOME/hermit-tasks.json（dsh-pet 同款 JSON 模式；D3 MemoryHub 再升 storage.domain）
 * 完成态：监听 subagent/end（作用域过滤到自己派的孩子），按 childId 匹配推进状态
 *   注：V3 结论只否定用 subagent/end「生成汇报」（那是子代理 report 工具的事），
 *   用于「知道结束了 + 更新任务状态」正合适——不碰 handle、不取内容，只读终态。
 * 自恢复（TSECS B1/B2）：幂等派发、优雅降级、崩溃后从磁盘恢复任务表、监听与工具全部可逆。
 * @module hermit-core
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'hermit-core'
export const inject = ['tools', 'subagents']

const PERMISSIONS = ['R', 'W1', 'W2', 'P', 'M']
const MAX_TASKS = 100 // 注册表上限：防无限膨胀，超了丢最老的已终态任务
const TASKS_FILE = path.join(
  process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'),
  'hermit-tasks.json',
)

function loadTasks() {
  try { return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')) } catch { return {} }
}
function saveTasks(map) {
  try {
    fs.mkdirSync(path.dirname(TASKS_FILE), { recursive: true })
    const tmp = TASKS_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8')
    fs.copyFileSync(tmp, TASKS_FILE) // Windows 上 rename 到已存在文件不可靠，copy 覆盖
    fs.unlinkSync(tmp)
  } catch { /* 持久化尽力而为：失败不阻塞派发（B2） */ }
}
function prune(map) {
  const entries = Object.entries(map)
  if (entries.length <= MAX_TASKS) return map
  const terminal = entries.filter(([, t]) => t.status !== 'working')
    .sort((a, b) => ((a[1].endedAt ?? a[1].startedAt ?? 0) - (b[1].endedAt ?? b[1].startedAt ?? 0)))
  const drop = terminal.slice(0, entries.length - MAX_TASKS)
  for (const [k] of drop) delete map[k]
  return map
}

export function apply(ctx) {
  // 持久化任务注册表：进程启动即从磁盘恢复（崩溃/重启不丢——B2 自恢复）
  const tasks = prune(loadTasks()) // taskKey -> { taskId, childId, label, status, startedAt, endedAt?, stopReason? }

  const dispatch = defineTool({
    name: 'dispatch_task',
    description:
      '把需要后台执行的复杂任务（R2：整理文档/写代码/批量处理/跨工具跑腿/联网调研）委派给子代理异步执行。' +
      '调用后立即返回，前台不阻塞；子代理完成后会用 report 把结果汇报回来，届时你再即兴转告主人。' +
      '闲聊/简单问答（R0/R1）不要调用本工具，直接回答即可。拿不准权限级别就往高升一级。' +
      '幂等：同一 idempotency_key 重复调用不会重复起子代理。',
    parameters: {
      intent: { type: 'string', required: true, description: '任务意图的完整描述（含必要上下文与期望产出）' },
      label: { type: 'string', description: '简短任务标签（≤24字，用于标识）' },
      permission: { type: 'string', enum: PERMISSIONS, description: '操作权限级别：R只读/W1可逆写/W2不可逆写/P对外发布/M金钱' },
      complexity: { type: 'string', enum: ['low', 'medium', 'high'], description: '任务复杂度（影响推理档位）' },
      privacy: { type: 'string', enum: ['full', 'brief_only'], description: 'brief_only=涉隐私未授权，只传语义摘要不传原始数据' },
      idempotency_key: { type: 'string', description: '可选幂等键：同一键重复调用返回在飞任务，不重复派发' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          route: { type: 'string' },
          task_id: { type: 'string' },
          status: { type: 'string' },
          summary: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (args, value) => [{ type: 'text', text: value.ok ? value.summary : ('派发失败：' + value.error) }],
    },
    async execute(args, exec) {
      const perm = args.permission ?? 'R'
      const label = (args.label ?? args.intent).slice(0, 24)
      const key = args.idempotency_key ?? args.intent.trim().slice(0, 64)

      // 闸门① 硬规则：P/M 级必须逐次确认（确认链 MVP-0 后置，先拦截）
      if (perm === 'P' || perm === 'M') {
        return fail('blocked', `${perm} 级操作必须主人逐次确认（确认链 MVP-0 后置，已拦截）。请主人明确授权后再派。`)
      }
      // 幂等：同一键已有在飞任务 → 返回它（重启后也从磁盘表识别，不重复派发）
      const existing = tasks[key]
      if (existing && existing.status === 'working') {
        return { ok: true, route: 'R2-a', task_id: existing.taskId, status: 'already_running',
          summary: `「${existing.label}」已经在办了（任务 ${existing.taskId}），还没完——好了我告诉你。`, error: '' }
      }
      // 优雅降级：parent / subagents 不可用时结构化报错，不崩前台
      const parent = exec.agent
      if (!parent) return fail('failed', 'dispatch_task 只能在 agent 会话中调用（缺少 parent agent）')
      if (!ctx.subagents || typeof ctx.subagents.startContinuable !== 'function') {
        return fail('failed', '子代理服务当前不可用（subagents 未挂载）。我先记下，等它恢复再派。')
      }
      // R2-a：起 continuable 子代理异步执行；完成后子代理用 report 回报父会话
      try {
        const start = await ctx.subagents.startContinuable({
          provider: 'spawn',
          label,
          request: { parent, prompt: [{ type: 'text', text: buildBrief(args) }] },
          signal: exec.signal,
        })
        const taskId = String(start.childId)
        tasks[key] = { taskId, childId: String(start.childId), label, status: 'working', startedAt: Date.now() }
        saveTasks(prune(tasks))
        return { ok: true, route: 'R2-a', task_id: taskId, status: 'dispatched',
          summary: `已接单，「${label}」后台开始办了，好了我告诉你。`, error: '' }
      } catch (e) {
        return fail('failed', `子代理没能起来：${e && e.message ? e.message : String(e)}。要不要我换个法子试试？`)
      }
    },
  })

  // task_status —— 「那个任务怎么样了」全量应答（working + 最近终态）
  const status = defineTool({
    name: 'task_status',
    description: '查询小寄派出去的后台任务状态（在跑的 + 最近完成的/失败的）。主人问「那个任务怎么样了/都办了些什么」时用。',
    parameters: {
      task_id: { type: 'string', description: '可选：查某个任务；不填则汇总全部' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string' }, count: { type: 'number' } } },
      render: (args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args) {
      const all = Object.values(tasks)
      if (args.task_id) {
        const t = all.find(x => x.taskId === args.task_id || x.label === args.task_id)
        if (!t) return { summary: `没找到任务「${args.task_id}」。`, count: 0 }
        return { summary: describe(t), count: 1 }
      }
      const working = all.filter(t => t.status === 'working').sort((a, b) => a.startedAt - b.startedAt)
      const done = all.filter(t => t.status !== 'working')
        .sort((a, b) => ((b.endedAt ?? 0) - (a.endedAt ?? 0))).slice(0, 5)
      const parts = []
      if (working.length) parts.push(`在跑 ${working.length} 个：` + working.map(t => `「${t.label}」(已办 ${ago(t.startedAt)})`).join('、'))
      else parts.push('这会儿没有在跑的任务')
      if (done.length) parts.push('最近完成：' + done.map(t => `「${t.label}」${t.status === 'completed' ? '✓' : '✗'}`).join('、'))
      return { summary: parts.join('；') + '。', count: working.length }
    },
  })

  // 完成态追踪：subagent/end 按作用域过滤到自己派的孩子，按 childId 匹配推进状态机。
  // 只读终态（stopReason），不碰 handle、不取内容——内容走子代理 report（V3 结论）。
  ctx.effect(() => ctx.on('subagent/end', (info) => {
    const childId = String((info && info.id) ?? '')
    if (!childId) return
    let dirty = false
    for (const t of Object.values(tasks)) {
      if (t.childId === childId && t.status === 'working') {
        const sr = String(info.stopReason ?? '')
        t.status = /complete|success|done/i.test(sr) ? 'completed' : (/cancel/i.test(sr) ? 'cancelled' : 'failed')
        t.stopReason = sr
        t.endedAt = Date.now()
        dirty = true
      }
    }
    if (dirty) saveTasks(tasks)
  }), 'hermit:subagent-end')

  // 统一注册，效应可逆（A2）：卸载即撤工具 + 监听器
  ctx.effect(() => {
    const d1 = ctx.tools.register(dispatch)
    const d2 = ctx.tools.register(status)
    return () => { d1(); d2() }
  }, 'hermit:core-tools')
}

function fail(status, error) { return { ok: false, route: 'R2-a', task_id: '', status, summary: '', error } }
function ago(ts) { return Math.max(1, Math.round((Date.now() - ts) / 1000)) + ' 秒' }
function describe(t) {
  if (t.status === 'working') return `「${t.label}」还在跑，已办 ${ago(t.startedAt)}。`
  const tail = t.stopReason ? `（${t.stopReason}）` : ''
  return `「${t.label}」已${t.status === 'completed' ? '完成' : (t.status === 'cancelled' ? '取消' : '失败')}${tail}。`
}

function buildBrief(args) {
  const lines = [
    '你是小寄（Hermit）派出的执行子代理。请独立完成下面这个任务。',
    '',
    `【任务】${args.intent}`,
  ]
  if (args.complexity) lines.push(`【复杂度】${args.complexity}`)
  lines.push(`【权限级别】${args.permission ?? 'R'}（R只读/W1可逆写/W2不可逆写/P对外发布/M金钱）——越权操作一律拒绝。`)
  if (args.privacy === 'brief_only') lines.push('【隐私】本任务涉隐私未授权：不要读取/外传原始隐私数据，只处理语义摘要。')
  lines.push('', '完成后：调用 report 工具，把「结果摘要 + 产物链接/路径 + 建议下一步」汇报回父会话（小寄会转告主人）。失败了也如实汇报原因 + 补救建议。')
  return lines.join('\n')
}
