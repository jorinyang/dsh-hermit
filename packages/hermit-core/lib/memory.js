/** hermit-core 内部模块：M1 事件日志（11 §二）。同包 ./ 导入。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const M1_FILE = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'hermit-m1-events.jsonl')
const MAX_LINES = 2000

export function record(type, refId, brief, sentimentHint) {
  try {
    fs.mkdirSync(path.dirname(M1_FILE), { recursive: true })
    fs.appendFileSync(M1_FILE, JSON.stringify({ ts: Date.now(), type, ref_id: refId, brief: String(brief).slice(0, 200), sentiment_hint: sentimentHint }) + '\n', 'utf8')
    try {
      const lines = fs.readFileSync(M1_FILE, 'utf8').split('\n').filter(Boolean)
      if (lines.length > MAX_LINES) fs.writeFileSync(M1_FILE, lines.slice(-MAX_LINES).join('\n') + '\n', 'utf8')
    } catch {}
  } catch {}
}
export function recent(n = 20) {
  try {
    const lines = fs.readFileSync(M1_FILE, 'utf8').split('\n').filter(Boolean)
    return lines.slice(-n).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}
