/**
 * hermit-core — D3：Budget预扣实结 + P/M确认链 + M1事件日志 + dispatch_task/task_status/budget_status 聚合。
 *
 * 派发全流程（03 §3.2 五闸门 + 13 §三 + 15 §二/三 + 11 M1）：
 *   ①权限分级 → P/M 弹三要素确认（userQuestions 程序化，fail-closed）
 *   ⑤预算预扣（hold，日/月闸校验，超额分级拒绝）
 *   → startContinuable 起子代理 → M1 落 task_dispatched
 *   → subagent/end 完成态追踪 → 预算实结（settle 多退少补）→ M1 落 completed/failed
 * 依赖注入（A3）：budget/permission/memory 以同仓相对导入引入（preset 作用域内共享模块图）。
 * @module hermit-core
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
// 同仓相对导入（monorepo 兄弟包；不能裸名 import——web profile 的 node_modules 只 link 了 hermit-core 自己）
import { budgetApi } from '../../hermit-budget/lib/index.js'
import { confirmHighRisk } from '../../hermit-permission/lib/index.js'
import { record as m1 } from '../../hermit-memory/lib/index.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'hermit-core'
export const inject = ['tools', 'subagents', 'userQuestions']

const PERMISSIONS = ['R', 'W1', 'W2', 'P', 'M']
const MAX_TASKS = 100
const TASKS_FILE = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'hermit-tasks.json')

function loadTasks() { try { return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')) } catch { return {} } }
function saveTasks(map) {
  try {
    fs.mkdirSync(path.dirname(TASKS_FILE), { recursive: true })
    const tmp = TASKS_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8')
    fs.copyFileSync(tmp, TASKS_FILE); fs.unlinkSync(tmp)
  } catch { /* 尽力而为（B2） */ }
}
function prune(map) {
  const entries = Object.entries(map)
  if (entries.length <= MAX_TASKS) return map
  const terminal = entries.filter(([, t]) => t.status !== 'working')
    .sort((a, b) => ((a[1].endedAt ?? a[1].startedAt ?? 0) - (b[1].endedAt ?? b[1].startedAt ?? 0)))
  for (const [k] of terminal.slice(0, entries.length - MAX_TASKS)) delete map[k]
  return map
}

export function apply(ctx) {
  const tasks = prune(loadTasks())
  const budget = budgetApi()

  const dispatch = defineTool({
    name: 'dispatch_task',
    description:
      '把需要后台执行的复杂任务（R2：整理文档/写代码/批量处理/跨工具跑腿/联网调研）委派给子代理异步执行。' +
      '调用后立即返回，前台不阻塞；子代理完成后会用 report 把结果汇报回来，届时你再即兴转告主人。' +
      '闲聊/简单问答（R0/R1）不要调用本工具，直接回答即可。拿不准权限级别就往高升一级。' +
      'P（对外发布）/M（金钱）级会自动弹确认问主人，别自己跳过。幂等：同一 idempotency_key 不重复派发。',
    parameters: {
      intent: { type: 'string', required: true, description: '任务意图的完整描述（含必要上下文与期望产出）' },
      label: { type: 'string', description: '简短任务标签（≤24字）' },
      permission: { type: 'string', enum: PERMISSIONS, description: '操作权限级别：R只读/W1可逆写/W2不可逆写/P对外发布/M金钱' },
      complexity: { type: 'string', enum: ['low', 'medium', 'high'], description: '任务复杂度（影响预扣额与推理档位）' },
      privacy: { type: 'string', enum: ['full', 'brief_only'], description: 'brief_only=涉隐私未授权，只传语义摘要' },
      idempotency_key: { type: 'string', description: '可选幂等键' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean' }, route: { type: 'string' }, task_id: { type: 'string' },
          status: { type: 'string' }, summary: { type: 'string' }, error: { type: 'string' } },
      },
      render: (args, value) => [{ type: 'text', text: value.ok ? value.summary : ('派发失败：' + value.error) }],
    },
    async execute(args, exec) {
      const perm = args.permission ?? 'R'
      const label = (args.label ?? args.intent).slice(0, 24)
      const key = args.idempotency_key ?? args.intent.trim().slice(0, 64)

      // 幂等
      const existing = tasks[key]
      if (existing && existing.status === 'working') {
        return { ok: true, route: 'R2-a', task_id: existing.taskId, status: 'already_running',
          summary: `「${existing.label}」已经在办了（任务 ${existing.taskId}），还没完——好了我告诉你。`, error: '' }
      }

      // 闸门①：P/M 三要素确认链（程序化弹窗，fail-closed，不靠模型自觉）
      if (perm === 'P' || perm === 'M') {
        const conf = await confirmHighRisk(ctx, { permission: perm, intent: args.intent, label })
        if (!conf.ok) return fail('blocked', `${perm} 级确认服务不可用，按「宁可误拒」先拦下（fail-closed）。`) 
        if (!conf.confirmed) {
          m1('perm_decision', key, `${perm} 级「${label}」主人拒绝`, 'denied')
          return fail('blocked', `主人没点头，这个我就不做了。`)
        }
        m1('perm_decision', key, `${perm} 级「${label}」主人确认放行`, 'approved')
      }

      // 闸门⑤：预算预扣（日/月闸校验；超额=高风险询问路径留给前台话术，这里先拒）
      const hold = budget.hold(key, args.complexity)
      if (!hold.ok) {
        m1('budget_watermark', key, `预扣被拒（${hold.reason} 已用 ${Math.round(hold.used)}/${hold.limit}）`, 'warn')
        return fail('budget-blocked',
          hold.reason === 'daily'
            ? `今天的额度见底了（${Math.round(hold.used)}/${hold.limit} credit）。要紧的事我用自己的脑子先将就，还是主人破例加点？`
            : `这个月的额度不够扣了（${Math.round(hold.used)}/${hold.limit}）。等下个月，还是主人特批？`)
      }

      const parent = exec.agent
      if (!parent) { budget.release(key); return fail('failed', 'dispatch_task 只能在 agent 会话中调用（缺少 parent agent）') }
      if (!ctx.subagents || typeof ctx.subagents.startContinuable !== 'function') {
        budget.release(key)
        return fail('failed', '子代理服务当前不可用。我先记下，等它恢复再派。')
      }

      // R2-a 派发
      try {
        const start = await ctx.subagents.startContinuable({
          provider: 'spawn',
          label,
          request: { parent, prompt: [{ type: 'text', text: buildBrief(args) }] },
          signal: exec.signal,
        })
        const taskId = String(start.childId)
        tasks[key] = { taskId, childId: String(start.childId), label, status: 'working',
          startedAt: Date.now(), perm, complexity: args.complexity ?? 'medium', hold: hold.credits }
        saveTasks(prune(tasks))
        m1('task_dispatched', taskId, `「${label}」${perm}级/${args.complexity ?? 'medium'}复杂度，预扣${hold.credits}c`)
        return { ok: true, route: 'R2-a', task_id: taskId, status: 'dispatched',
          summary: `已接单，「${label}」后台开始办了，好了我告诉你。`, error: '' }
      } catch (e) {
        budget.release(key)
        return fail('failed', `子代理没能起来：${e && e.message ? e.message : String(e)}。要不要我换个法子试试？`)
      }
    },
  })

  const status = defineTool({
    name: 'task_status',
    description: '查询小寄派出去的后台任务状态（在跑的 + 最近完成的/失败的）。主人问「那个任务怎么样了/都办了些什么」时用。',
    parameters: { task_id: { type: 'string', description: '可选：查某个任务；不填则汇总' } },
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
      const done = all.filter(t => t.status !== 'working').sort((a, b) => ((b.endedAt ?? 0) - (a.endedAt ?? 0))).slice(0, 5)
      const parts = []
      if (working.length) parts.push(`在跑 ${working.length} 个：` + working.map(t => `「${t.label}」(已办 ${ago(t.startedAt)})`).join('、'))
      else parts.push('这会儿没有在跑的任务')
      if (done.length) parts.push('最近完成：' + done.map(t => `「${t.label}」${t.status === 'completed' ? '✓' : '✗'}`).join('、'))
      return { summary: parts.join('；') + '。', count: working.length }
    },
  })

  // 完成态追踪：状态机推进 + 预算实结 + M1 落库（三件事一气呵成）
  ctx.effect(() => ctx.on('subagent/end', (info) => {
    const childId = String((info && info.id) ?? '')
    if (!childId) return
    for (const [key, t] of Object.entries(tasks)) {
      if (t.childId === childId && t.status === 'working') {
        const sr = String(info.stopReason ?? '')
        t.status = /complete|success|done/i.test(sr) ? 'completed' : (/cancel/i.test(sr) ? 'cancelled' : 'failed')
        t.stopReason = sr
        t.endedAt = Date.now()
        // 预算实结：MVP-0 按预扣值结（订阅制无边际现金）；R2-c 接真实 usage 后改传 actual
        const s = budget.settle(key, t.hold)
        m1(t.status === 'completed' ? 'task_completed' : 'task_failed', t.taskId,
          `「${t.label}」${t.status}${s.ok ? ` 实结${s.actual}c` : ''}${sr ? `(${sr})` : ''}`)
        saveTasks(tasks)
      }
    }
  }), 'hermit:subagent-end')

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
