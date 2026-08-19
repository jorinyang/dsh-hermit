/** hermit-core 内部模块：预算账本（13 §一~§四）。同包 ./ 导入，零跨包解析风险。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const LEDGER_FILE = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'hermit-ledger.json')
export const DAILY = 500, MONTHLY = 8000, WARN = 0.80, CRITICAL = 0.95
export const HOLD_BY_COMPLEXITY = { low: 5, medium: 15, high: 40 }

function load() { try { return JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')) } catch { return { holds: {}, entries: [] } } }
function save(l) {
  try { fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
    const t = LEDGER_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(l, null, 2), 'utf8'); fs.copyFileSync(t, LEDGER_FILE); fs.unlinkSync(t) } catch {}
}
export const dayKey = (ts = Date.now()) => { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') }
export const monthKey = (ts = Date.now()) => { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') }
export const spentOn = (l, keyFn, ts = Date.now()) => l.entries.filter(e => e.kind === 'settle').reduce((s, e) => s + (keyFn(e.ts) === keyFn(ts) ? e.credits : 0), 0)
const openHolds = (l) => Object.values(l.holds).reduce((s, v) => s + v, 0)

export function budgetApi() {
  const l = load()
  return {
    loadLedger: load,
    hold(taskKey, complexity) {
      const credits = HOLD_BY_COMPLEXITY[complexity] ?? HOLD_BY_COMPLEXITY.medium
      const day = spentOn(l, dayKey) + openHolds(l) + credits
      if (day > DAILY) return { ok: false, reason: 'daily', credits, used: day, limit: DAILY }
      const mon = spentOn(l, monthKey) + openHolds(l) + credits
      if (mon > MONTHLY) return { ok: false, reason: 'monthly', credits, used: mon, limit: MONTHLY }
      if (!l.holds[taskKey]) { l.holds[taskKey] = credits; l.entries.push({ ts: Date.now(), taskKey, kind: 'hold', credits, note: '预扣' }); save(l) }
      return { ok: true, credits }
    },
    settle(taskKey, actualCredits) {
      const held = l.holds[taskKey]
      if (held === undefined) return { ok: false, reason: 'no-hold' }
      const actual = Math.max(0, Math.round(actualCredits ?? held))
      delete l.holds[taskKey]
      l.entries.push({ ts: Date.now(), taskKey, kind: 'settle', credits: actual, note: '实结(预扣' + held + ')' })
      save(l); return { ok: true, held, actual, diff: actual - held }
    },
    release(taskKey) { if (l.holds[taskKey] !== undefined) { delete l.holds[taskKey]; save(l); return { ok: true } } return { ok: false } },
    waterLevel() {
      const used = spentOn(l, dayKey) + openHolds(l)
      const ratio = used / DAILY
      return { used, limit: DAILY, ratio, state: ratio >= 1 ? 'exhausted' : ratio >= CRITICAL ? 'critical' : ratio >= WARN ? 'warn' : 'normal' }
    },
  }
}
