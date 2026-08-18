/**
 * hermit-budget — BudgetService：credit 账本 + 日闸/月闸 + 预扣实结 + 水位预警（13 预算系统）。
 * 账本：$DSH_HOME/hermit-ledger.json（原子写，dsh-pet 同款模式）
 * credit：1 credit ≈ L0 档 1K tokens 综合均价（归一化锚，13 §一）
 * 预扣：派发时按 complexity 档位预扣（low=5/medium=15/high=40），完成实结多退少补
 *   注：实结的真实 token 用量来自 DSH 原生 usage（子代理 report 或 tokenMeter 投影），
 *   MVP-0 先按预扣值实结（订阅制无边际现金成本），R2-c 直连时再接真实 usage。
 * 双闸：日 500 / 月 8000（13 §二）；水位 80% 预警一次 / 95% 再预警+省流建议 / 耗尽分级
 * TSECS：工具/账本效应可逆（A2）；幂等（task_id 为键，重复 settle 不重复记账 B2）；可观测（budget_status B1）
 * @module hermit-budget
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'hermit-budget'
export const inject = ['tools']

const LEDGER_FILE = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'hermit-ledger.json')
const DAILY = 500, MONTHLY = 8000, WARN = 0.80, CRITICAL = 0.95
const HOLD_BY_COMPLEXITY = { low: 5, medium: 15, high: 40 }

// 账本结构：{ holds: {taskKey: credits}, entries: [{ts, taskKey, kind: hold|settle, credits, note}], dayKey -> 已结算合计（派生缓存） }
function load() { try { return JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')) } catch { return { holds: {}, entries: [] } } }
function save(l) {
  try {
    fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true })
    const tmp = LEDGER_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(l, null, 2), 'utf8')
    fs.copyFileSync(tmp, LEDGER_FILE); fs.unlinkSync(tmp)
  } catch { /* 尽力而为（B2） */ }
}
function dayKey(ts = Date.now()) { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') }
function monthKey(ts = Date.now()) { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') }
function spentOn(l, keyFn) {
  return l.entries.filter(e => e.kind === 'settle').reduce((s, e) => s + (keyFn(e.ts) === keyFn() ? e.credits : 0), 0)
}
function openHolds(l) { return Object.values(l.holds).reduce((s, v) => s + v, 0) }

// —— 内部 API（hermit-core 经 ctx 注入调用；不用 service 以保持 preset 作用域简单）——
export function budgetApi() {
  const l = load()
  return {
    /** 预扣：返回 {ok, reason}；日/月闸校验（13 §三：防并发任务把额度冲穿） */
    hold(taskKey, complexity) {
      const credits = HOLD_BY_COMPLEXITY[complexity] ?? HOLD_BY_COMPLEXITY.medium
      const day = spentOn(l, dayKey) + openHolds(l) + credits
      if (day > DAILY) return { ok: false, reason: 'daily', credits, used: day, limit: DAILY }
      const mon = spentOn(l, monthKey) + openHolds(l) + credits
      if (mon > MONTHLY) return { ok: false, reason: 'monthly', credits, used: mon, limit: MONTHLY }
      if (!l.holds[taskKey]) { l.holds[taskKey] = credits; l.entries.push({ ts: Date.now(), taskKey, kind: 'hold', credits, note: '预扣' }) ; save(l) }
      return { ok: true, credits }
    },
    /** 实结：多退少补；幂等（同 taskKey 只结一次，B2） */
    settle(taskKey, actualCredits) {
      const held = l.holds[taskKey]
      if (held === undefined) return { ok: false, reason: 'no-hold' }
      const actual = Math.max(0, Math.round(actualCredits ?? held))
      delete l.holds[taskKey]
      l.entries.push({ ts: Date.now(), taskKey, kind: 'settle', credits: actual, note: '实结(预扣' + held + ')' })
      save(l)
      return { ok: true, held, actual, diff: actual - held }
    },
    /** 水位（13 §四状态机）：normal | warn(80%) | critical(95%) | exhausted */
    waterLevel() {
      const used = spentOn(l, dayKey) + openHolds(l)
      const ratio = used / DAILY
      return { used, limit: DAILY, ratio,
        state: ratio >= 1 ? 'exhausted' : ratio >= CRITICAL ? 'critical' : ratio >= WARN ? 'warn' : 'normal' }
    },
    /** 撤销预扣（任务没起来时退回） */
    release(taskKey) {
      if (l.holds[taskKey] !== undefined) { delete l.holds[taskKey]; save(l); return { ok: true } }
      return { ok: false }
    },
  }
}

export function apply(ctx) {
  const status = defineTool({
    name: 'budget_status',
    description:
      '查询小寄的额度账本：今天用了多少 credit、水位状态、本月合计。主人问「今天额度用了多少/还剩多少」时用；' +
      '水位 warn(80%) 时要自然提一句省着用（当日只提一次）；critical(95%) 时主动给省流方案。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        summary: { type: 'string' }, used: { type: 'number' }, limit: { type: 'number' }, state: { type: 'string' } } },
      render: (args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute() {
      const l = load()
      const w = budgetApi().waterLevel()
      const month = spentOn(l, monthKey)
      let tone = ''
      if (w.state === 'warn') tone = ' 今天有点费，我省着点用。'
      if (w.state === 'critical') tone = ' 得精打细算了——要紧的事先办，零碎的我攒着？'
      if (w.state === 'exhausted') tone = ' 超级大脑今天的额度见底了：要紧的事我用自己的脑子先将就，还是破例加额度？'
      return { summary: `今天用了 ${Math.round(w.used)} / ${w.limit} credit（本月 ${Math.round(month)} / ${MONTHLY}）。${tone.trim()}`,
        used: Math.round(w.used), limit: DAILY, state: w.state }
    },
  })
  ctx.effect(() => { const d = ctx.tools.register(status); return d }, 'hermit:budget-status')
}
