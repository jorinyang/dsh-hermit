/**
 * hermit-core — 小寄的「任务分派中枢」：dispatch_task / task_status / budget_status + 状态机 + 完成态追踪 + 模型路由。
 * 单包多模块（同包 ./ 导入，零跨包解析风险；高内聚单包 + 低耦合内部模块）。
 * 设计锚点：
 *  - R2-a「要动手的走框架」（01 §三）→ dispatch_task 起 continuable 子代理
 *  - ReportEvent = result_summary + suggested_next + artifacts（03 §2.3）→ brief 硬要求子代理 report
 *  - 推理强度由任务驱动（08 §一）→ routeModel 按任务类型选子代理模型（agentOptions）
 *  - 五闸门①②⑤（03 §3.2）+ P/M 三要素确认（15）+ 预算双闸（13）+ M1 事件（11）
 * @module hermit-core
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { budgetApi, spentOn, monthKey, MONTHLY } from './budget.js'
import { confirmHighRisk } from './permission.js'
import { record as m1 } from './memory.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'hermit-core'
export const inject = ['tools', 'subagents', 'userQuestions']

const PERMISSIONS = ['R', 'W1', 'W2', 'P', 'M']
const PERM_ORDER = { R: 0, W1: 1, W2: 2, P: 3, M: 4 }
/** 权限下限硬规则（15 §一「拿不准就升一级，宁严勿纵」的确定性落地）：对任务文本判出最低权限级，前台报低了由工具层抬上去。 */function permissionFloor(text) {
  const t = String(text || '').toLowerCase()
  if (/支付|付款|购买|下单|充值|转账|订阅|付费|订单/.test(t)) return 'M'
  if (/发给|发送给|发到|发布|公开|公网|上传|推送|\bpush\b|publish|github|gitlab|博客|朋友圈|推特|twitter|评论|留言|部署上线|上线|飞书|钉钉|邮件|email|微信|发到.*(?:仓库|网|群|人|同事|朋友)/.test(t)) return 'P'
  if (/删除|覆盖|重命名|移动|格式化|清空|移除/.test(t)) return 'W2'
  if (/新建|创建|写入|保存|生成|写一份|记录|添加|整理成/.test(t)) return 'W1'
  return 'R'
}
const maxPermission = (a, b) => (PERM_ORDER[a] >= PERM_ORDER[b] ? a : b)
const MAX_TASKS = 100
const TASKS_FILE = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'hermit-tasks.json')

function loadTasks() { try { return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')) } catch { return {} } }
function saveTasks(map) {
  try { fs.mkdirSync(path.dirname(TASKS_FILE), { recursive: true });
    const t = TASKS_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(map, null, 2), 'utf8'); fs.copyFileSync(t, TASKS_FILE); fs.unlinkSync(t) } catch {}
}
function prune(map) {
  const entries = Object.entries(map)
  if (entries.length <= MAX_TASKS) return map
  const terminal = entries.filter(([, t]) => t.status !== 'working')
    .sort((a, b) => ((a[1].endedAt ?? a[1].startedAt ?? 0) - (b[1].endedAt ?? b[1].startedAt ?? 0)))
  for (const [k] of terminal.slice(0, entries.length - MAX_TASKS)) delete map[k]
  return map
}

/**
 * routeModel — 按任务类型给子代理选模型（08 §一 推理强度由任务驱动的 R2-a 延伸；纯关键词规则，零 LLM 成本）。
 * provider/model 对照见 DSH settings.yaml 的 llm-pi-ai.providers；可选 args.model_hint 覆盖。
 */
function routeModel(args) {
  const hint = (args.model_hint ?? '').toLowerCase()
  if (hint) return resolveHint(hint)
  const text = ((args.intent ?? '') + ' ' + (args.label ?? '')).toLowerCase()
  const urgent = /紧急|立刻|马上|尽快|urgent|asap|快速|低延迟|秒回/.test(text)
  const toolHeavy = /工具|调用工具|执行|脚本|跑命令|批量处理|文件操作|自动化|批处理|爬取|抓取/.test(text)
  // 长上下文优先于复杂推理：长文/海量/全量 是决定性的上下文需求
  const longCtx = /长文|长文档|几十万|百万字|整库|全库|全网|大规模|海量|所有文件|整个目录|deep dive|深挖|几百|几千|上万|大批量/.test(text) && !toolHeavy
  const heavyReason = /复杂|架构|推理|深度分析|设计|调试|规划|论证/.test(text) && !toolHeavy && !longCtx
  if (urgent) return { provider: 'xiaomi', model: 'mimo-v2.5-pro-ultraspeed', why: '紧急/低延迟' }
  if (longCtx) return { provider: 'kimi-coding', model: 'k3', why: '长文/长上下文' }
  if (heavyReason) return { provider: 'zai-coding-cn', model: 'glm-5.2', why: '复杂推理' }
  if (toolHeavy) return { provider: 'minimax-cn', model: 'MiniMax-M3', why: '工具调用密集' }
  return { provider: 'deepseek', model: 'deepseek-chat', why: '默认高性价比' }
}
function resolveHint(h) {
  if (/kimi|k3|长文/.test(h)) return { provider: 'kimi-coding', model: 'k3', why: '指定长文' }
  if (/minimax|m3|工具/.test(h)) return { provider: 'minimax-cn', model: 'MiniMax-M3', why: '指定工具' }
  if (/glm|5\.2|复杂|推理/.test(h)) return { provider: 'zai-coding-cn', model: 'glm-5.2', why: '指定复杂推理' }
  if (/mimo|ultra|紧急|快/.test(h)) return { provider: 'xiaomi', model: 'mimo-v2.5-pro-ultraspeed', why: '指定紧急' }
  return { provider: 'deepseek', model: 'deepseek-chat', why: '指定/默认' }
}

export function apply(ctx) {
  const tasks = prune(loadTasks())
  const budget = budgetApi()

  const dispatch = defineTool({
    name: 'dispatch_task',
    description:
      '把需要「动手」的任务（读/写文件、执行命令、多步操作、联网调研、批量处理、产出保存）委派给子代理异步执行。' +
      '调用后立即返回，前台不阻塞；子代理完成后会带「结果摘要+建议下一步」回报，你再即兴连概况一起转告主人。' +
      '把复杂/多步/耗时/联网/批量的任务派给后台子代理异步执行；简单可逆的小操作（记条笔记、读个文件）不用派，直接做。但 W2（不可逆写）/P（对外发布）/M（金钱）级无论多简单都必须经我——我会先弹三要素确认卡（userQuestions.ask）问主人，主人点「准了」才执行；这确认卡独立于 DSH 的 Full access/审批开关，Full access 下也照样弹。闲聊/纯只读查询不要调用。幂等：同一 idempotency_key 不重复派发。',
    parameters: {
      intent: { type: 'string', required: true, description: '任务意图完整描述（含上下文与期望产出）' },
      label: { type: 'string', description: '简短任务标签（≤24字）' },
      permission: { type: 'string', enum: PERMISSIONS, description: '操作权限级别：R只读/W1可逆写/W2不可逆写/P对外发布/M金钱' },
      complexity: { type: 'string', enum: ['low', 'medium', 'high'], description: '复杂度（影响预扣额）' },
      privacy: { type: 'string', enum: ['full', 'brief_only'], description: 'brief_only=涉隐私未授权只传语义摘要' },
      model_hint: { type: 'string', description: '可选：指定子代理模型倾向（长文/工具/复杂推理/紧急/性价比）' },
      idempotency_key: { type: 'string', description: '可选幂等键' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean' }, route: { type: 'string' }, task_id: { type: 'string' },
          status: { type: 'string' }, summary: { type: 'string' }, error: { type: 'string' }, model: { type: 'string' } },
      },
      render: (args, value) => [{ type: 'text', text: value.ok ? value.summary : ('派发失败：' + value.error) }],
    },
    async execute(args, exec) {
      try { fs.appendFileSync('C:/Users/Aorus/hermit-dispatch-probe.log', new Date().toISOString() + ' dispatch_task EXECUTED label=' + (args.label||'') + '\n', 'utf8') } catch {}
      const provided = args.permission ?? 'R'
      // 权限下限硬闸门：意图硬规则抬级（前台报低了也会被抬上去，纵深防御不靠前台自觉）
      const floor = permissionFloor(args.intent + ' ' + (args.label || ''))
      const perm = maxPermission(provided, floor)
      const escalated = PERM_ORDER[perm] > PERM_ORDER[provided]
      const label = (args.label ?? args.intent).slice(0, 24)
      const key = args.idempotency_key ?? args.intent.trim().slice(0, 64)
      let confirmRef = null // 确认凭证（15 §二）：P/M 级确认通过后挂上，子代理执行前自检
      const existing = tasks[key]
      if (existing && existing.status === 'working') {
        return { ok: true, route: 'R2-a', task_id: existing.taskId, status: 'already_running',
          summary: `「${existing.label}」已经在办了（任务 ${existing.taskId}），还没完——好了我告诉你。`, error: '', model: '' }
      }
      if (escalated) m1('perm_escalated', key, `意图硬规则把权限从 ${provided} 抬到 ${perm}（宁严勿纵）`, 'escalate')
      if (perm === 'P' || perm === 'M') {
        const conf = await confirmHighRisk(ctx, { permission: perm, intent: args.intent, label }, exec)
        if (!conf.ok) return fail('blocked', `${perm} 级确认服务不可用，按「宁可误拒」先拦下。`)
        if (!conf.confirmed) { m1('perm_decision', key, `${perm} 级「${label}」主人拒绝`, 'denied'); return fail('blocked', '主人没点头，这个我就不做了。') }
        m1('perm_decision', key, `${perm} 级「${label}」主人确认放行`, 'approved')
        confirmRef = 'cfm_' + Date.now().toString(36) // 确认凭证
      }
      const hold = budget.hold(key, args.complexity)
      if (!hold.ok) {
        m1('budget_watermark', key, `预扣被拒（${hold.reason} 已用 ${Math.round(hold.used)}/${hold.limit}）`, 'warn')
        return fail('budget-blocked', hold.reason === 'daily'
          ? `今天的额度见底了（${Math.round(hold.used)}/${hold.limit} credit）。要紧的事我用自己的脑子先将就，还是主人破例加点？`
          : `这个月的额度不够扣了（${Math.round(hold.used)}/${hold.limit}）。等下个月，还是主人特批？`)
      }
      const parent = exec.agent
      if (!parent) { budget.release(key); return fail('failed', 'dispatch_task 只能在 agent 会话中调用（缺少 parent agent）') }
      if (!ctx.subagents || typeof ctx.subagents.startContinuable !== 'function') {
        budget.release(key); return fail('failed', '子代理服务当前不可用。我先记下，等它恢复再派。')
      }
      // 模型路由（08 §一 延伸）：按任务类型给子代理选模型
      const route = routeModel(args)
      try {
        const start = await ctx.subagents.startContinuable({
          provider: 'spawn',
          label,
          request: { parent, prompt: [{ type: 'text', text: buildBrief(args, route, confirmRef) }], agentOptions: { provider: route.provider, model: route.model } },
          signal: exec.signal,
        })
        const taskId = String(start.childId)
        tasks[key] = { taskId, childId: String(start.childId), label, status: 'working',
          startedAt: Date.now(), perm, complexity: args.complexity ?? 'medium', hold: hold.credits, model: route.model, confirmRef }
        saveTasks(prune(tasks))
        m1('task_dispatched', taskId, `「${label}」${perm}级/${args.complexity ?? 'medium'}，预扣${hold.credits}c，模型${route.model}(${route.why})`)
        return { ok: true, route: 'R2-a', task_id: taskId, status: 'dispatched',
          summary: `已接单，「${label}」后台开始办了（用 ${route.model}，${route.why}），好了我连结果一起告诉你。`, error: '', model: route.model }
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

  const budgetStatus = defineTool({
    name: 'budget_status',
    description: '查询小寄的额度账本：今天用了多少 credit、水位状态、本月合计。主人问「今天额度用了多少/还剩多少」时用。水位高要自然提醒省着用。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        summary: { type: 'string' }, used: { type: 'number' }, limit: { type: 'number' }, state: { type: 'string' } } },
      render: (args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute() {
      const w = budget.waterLevel()
      const month = spentOn(budget.loadLedger(), monthKey)
      let tone = ''
      if (w.state === 'warn') tone = ' 今天有点费，我省着点用。'
      if (w.state === 'critical') tone = ' 得精打细算了——要紧的事先办，零碎的我攒着？'
      if (w.state === 'exhausted') tone = ' 超级大脑今天的额度见底了：要紧的事我用自己的脑子先将就，还是破例加额度？'
      return { summary: `今天用了 ${Math.round(w.used)} / ${w.limit} credit（本月 ${Math.round(month)} / ${MONTHLY}）。${tone.trim()}`,
        used: Math.round(w.used), limit: 500, state: w.state }
    },
  })

  // 完成态追踪：状态机推进 + 预算实结 + M1 落库
  ctx.effect(() => ctx.on('subagent/end', (info) => {
    const childId = String((info && info.id) ?? '')
    if (!childId) return
    for (const [key, t] of Object.entries(tasks)) {
      if (t.childId === childId && t.status === 'working') {
        const sr = String(info.stopReason ?? '')
        t.status = /complete|success|done/i.test(sr) ? 'completed' : (/cancel/i.test(sr) ? 'cancelled' : 'failed')
        t.stopReason = sr; t.endedAt = Date.now()
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
    const d3 = ctx.tools.register(budgetStatus)
    return () => { d1(); d2(); d3() }
  }, 'hermit:core-tools')
}

function fail(status, error) { return { ok: false, route: 'R2-a', task_id: '', status, summary: '', error, model: '' } }
function ago(ts) { return Math.max(1, Math.round((Date.now() - ts) / 1000)) + ' 秒' }
function describe(t) {
  if (t.status === 'working') return `「${t.label}」还在跑，已办 ${ago(t.startedAt)}。`
  const tail = t.stopReason ? `（${t.stopReason}）` : ''
  return `「${t.label}」已${t.status === 'completed' ? '完成' : (t.status === 'cancelled' ? '取消' : '失败')}${tail}。`
}
/** brief：硬要求子代理完成后用 report 工具带「结果摘要+产物+建议下一步」回报（03 §2.3 ReportEvent 落地）。 */
function buildBrief(args, route, confirmRef) {
  const perm = args.permission ?? 'R'
  const lines = [
    '你是小寄（Hermit）派出的执行子代理。请独立完成下面这个任务。',
    '',
    `【任务】${args.intent}`,
  ]
  if (args.complexity) lines.push(`【复杂度】${args.complexity}`)
  lines.push(`【权限级别】${perm}（R只读/W1可逆写/W2不可逆写/P对外发布/M金钱）——越权操作一律拒绝。`)
  lines.push(`【确认凭证】${confirmRef || '无'}（P/M 级任务经主人确认后才有；R/W1/W2 级为空）`)
  // 15 §二 纵深防御：子代理执行前自主校验任务类型/权限，级别对不上就刹车回报，不靠前台自觉
  lines.push(
    '',
    '【执行前自检（硬规则，必须做）】在动手前，先判断本任务**实际**需要的权限级别：',
    '  - 若操作会离开本机到公网/外部服务/发给他人（发布、上传、push、发送、发邮件/飞书/微信、公开仓库、评论留言、部署上线）→ 实为 **P 级**；涉及金钱支付 → **M 级**。',
    '  - 若你被判的级别【权限级别】低于操作实际所需级别，且【确认凭证】为空 → **立即中止，不要执行**，用 report 工具回报：「权限不足：此操作实为 X 级，需要主人先确认」，等前台重新用正确级别派发+确认后再继续。',
    '  - 宁严勿纵：拿不准就按更高级别处理并先用 report 问主人。',
  )
  if (args.privacy === 'brief_only') lines.push('【隐私】本任务涉隐私未授权：不要读取/外传原始隐私数据，只处理语义摘要。')
  lines.push(
    '',
    '【完成后的硬要求】任务做完（或彻底失败）后，**必须调用 report 工具**回报父会话，内容含三部分：',
    '  1. 结果摘要（做成了什么/为什么没做成，一两句说清）',
    '  2. 产物（生成的文件路径/链接，若有）',
    '  3. 建议下一步（给主人的一句可选动作）',
    '没回报前不许结束。小寄会把你的汇报连同结果摘要一起转告主人。',
  )
  return lines.join('\n')
}
