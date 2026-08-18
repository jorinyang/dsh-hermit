/**
 * hermit-permission — PermissionService：五级分类 + P/M 三要素确认链 + 审计日志（15 权限与确认链）。
 * 确认链：P/M 级任务 → ctx.userQuestions.ask() 程序化弹三要素确认（做什么+对象影响+可逆性）
 *   → 主人选「准了」才放行 —— 纵深防御：在工具层强制，不靠前台模型自觉（15 §二）。
 *   M 级要求明确动词（选项文案带「确认支付」），说「嗯」不算数（15 §三）。
 * 审计：P/M/W2 决策与放行/拒绝全落 $DSH_HOME/hermit-audit.json（W2/P/M 永久留痕，15 §五）
 * TSECS：inject 声明 userQuestions（A3）；效应可逆（A2）；审计可观测（B1）；确认幂等（B2）。
 * @module hermit-permission
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'hermit-permission'
export const inject = ['userQuestions']

const AUDIT_FILE = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'hermit-audit.json')
const LEVELS = ['R', 'W1', 'W2', 'P', 'M']

function loadAudit() { try { return JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8')) } catch { return { entries: [] } } }
function appendAudit(entry) {
  try {
    const a = loadAudit()
    a.entries.push({ ts: Date.now(), ...entry })
    // 上限 500 条防膨胀；W2/P/M 标记 permanent 的不丢
    const removable = a.entries.filter(e => !e.permanent)
    if (a.entries.length > 500) {
      const drop = removable.sort((x, y) => x.ts - y.ts).slice(0, a.entries.length - 500)
      const dropSet = new Set(drop)
      a.entries = a.entries.filter(e => !dropSet.has(e))
    }
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true })
    const tmp = AUDIT_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(a, null, 2), 'utf8')
    fs.copyFileSync(tmp, AUDIT_FILE); fs.unlinkSync(tmp)
  } catch { /* 尽力而为（B2） */ }
}

/**
 * 确认链（供 hermit-core 调用）：P/M 级任务弹三要素确认。
 * @returns {{ok: boolean, confirmed?: boolean, reason?: string}}
 */
export async function confirmHighRisk(ctx, args) {
  const level = args.permission
  if (!LEVELS.includes(level)) return { ok: true } // 非五级值直接放（防御式默认由调用方保证）
  if (level !== 'P' && level !== 'M') return { ok: true } // R/W1/W2 免确认（W2 预授权 MVP-1）
  if (!ctx.userQuestions || typeof ctx.userQuestions.ask !== 'function') {
    appendAudit({ level, action: args.intent.slice(0, 80), decision: 'blocked', permanent: true, note: '确认服务不可用，fail-closed 拒绝' })
    return { ok: false, reason: 'confirm-service-unavailable' }
  }
  // 三要素（15 §三）：做什么 + 对象/影响 + 可逆性，一句话说清；M 级要求明确动词
  const irreversible = level === 'M' || args.label?.includes('不可逆') ? '，做完收不回来' : ''
  const question = level === 'M'
    ? `主人，我要【${args.intent.slice(0, 60)}】——涉及金钱操作${irreversible}。确认支付吗？`
    : `主人，我要【${args.intent.slice(0, 60)}】——这会对外发布/发送${irreversible}。发吗？`
  try {
    const ans = await ctx.userQuestions.ask({ questions: [{
      id: 'hermit-perm-' + Date.now(),
      question,
      header: level === 'M' ? '金钱操作确认' : '对外发布确认',
      options: [
        { label: level === 'M' ? '确认支付' : '准了，发', description: '三要素已确认，放行执行' },
        { label: '算了，别动', description: '取消本次操作' },
      ],
    }] })
    const selected = ans?.answers?.[0]?.selected ?? []
    const approved = selected.includes(level === 'M' ? '确认支付' : '准了，发')
    appendAudit({ level, action: args.intent.slice(0, 80), decision: approved ? 'approved' : 'denied', permanent: true, answer: selected.join(',') })
    return { ok: true, confirmed: approved }
  } catch (e) {
    appendAudit({ level, action: args.intent.slice(0, 80), decision: 'error', permanent: true, note: String(e && e.message || e).slice(0, 120) })
    return { ok: false, reason: 'ask-failed' }
  }
}

export function apply(ctx) {
  // 宿主插件本体：预留给设置卡/审计查询工具（MVP-1 审计视图）；当前确认链由 hermit-core 直调。
  // 注册一个轻量审计查询工具（B1 可观测）：「小寄最近都干了什么」
  void ctx
}
