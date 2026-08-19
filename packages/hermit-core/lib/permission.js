/** hermit-core 内部模块：P/M 三要素确认链（15 §二/三）+ 审计（15 §五）。同包 ./ 导入。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const AUDIT_FILE = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'hermit-audit.json')
function appendAudit(entry) {
  try {
    const a = (() => { try { return JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8')) } catch { return { entries: [] } } })()
    a.entries.push({ ts: Date.now(), ...entry })
    if (a.entries.length > 500) { const keep = a.entries.filter(e => e.permanent); const rest = a.entries.filter(e => !e.permanent).slice(-(500 - keep.length)); a.entries = [...keep, ...rest] }
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true })
    const t = AUDIT_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(a, null, 2), 'utf8'); fs.copyFileSync(t, AUDIT_FILE); fs.unlinkSync(t)
  } catch {}
}

export async function confirmHighRisk(ctx, args, exec) {
  const level = args.permission
  if (level !== 'P' && level !== 'M') return { ok: true }
  if (!ctx.userQuestions || typeof ctx.userQuestions.ask !== 'function') {
    appendAudit({ level, action: args.intent.slice(0, 80), decision: 'blocked', permanent: true, note: '确认服务不可用，fail-closed' })
    return { ok: false, reason: 'confirm-service-unavailable' }
  }
  const irreversible = level === 'M' ? '，做完收不回来' : ''
  const question = level === 'M'
    ? `主人，我要【${args.intent.slice(0, 60)}】——涉及金钱操作${irreversible}。确认支付吗？`
    : `主人，我要【${args.intent.slice(0, 60)}】——这会对外发布/发送${irreversible}。发吗？`
  try {
    const ans = await ctx.userQuestions.ask({ ...(exec && exec.agent ? { agent: exec.agent } : {}), ...(exec && exec.signal ? { signal: exec.signal } : {}), questions: [{
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
