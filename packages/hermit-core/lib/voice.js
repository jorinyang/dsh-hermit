/** hermit-core 内部模块：语音路径动作描写→拟声词替换（MVP-1 voice 通道预备）。
 * 设计意图：UI 显示保留动作描写（视觉读者需要看到"小寄正在小跑"），
 * TTS 语音通道在合成前过 toSpeechText()，把动作括号替换为拟声词（听觉读者听到脚步声/笑声即可）。
 * 双向：toSpeechText 把动作还原成拟声，toText 把拟声还原成动作（UI/调试用）。
 */

// 动作→拟声映射表（按主人 2026-08-19 反馈扩写）
const ACTION_TO_SOUND = {
  '\uFF08张开小嘴\uFF09': '\uFF08啊~\uFF09',
  '\uFF08张开嘴\uFF09': '\uFF08啊~\uFF09',
  '\uFF08小跑\uFF09': '\uFF08踏踏踏~~\uFF08脚步声\uFF09\uFF09',
  '\uFF08跑来\uFF09': '\uFF08踏踏踏~~\uFF08脚步声\uFF09\uFF09',
  '\uFF08跑过来\uFF09': '\uFF08踏踏踏~~\uFF08脚步声\uFF09\uFF09',
  '\uFF08期待的眨眨眼\uFF09': '\uFF08嗯？\uFF08疑问声\uFF09\uFF09',
  '\uFF08期待的眨眼\uFF09': '\uFF08嗯？\uFF08疑问声\uFF09\uFF09',
  '\uFF08眨眨眼\uFF09': '\uFF08嗯？\uFF08疑问声\uFF09\uFF09',
  '\uFF08认真点头\uFF09': '\uFF08嗯嗯\uFF09',
  '\uFF08点头\uFF09': '\uFF08嗯嗯\uFF09',
  '\uFF08抬头\uFF09': '\uFF08嗯~\uFF09',
  '\uFF08小声\uFF09': '\uFF08嘘~\uFF09',
  '\uFF08笑\uFF09': '\uFF08嘻嘻\uFF09',
  '\uFF08笑出声\uFF09': '\uFF08嘻嘻~\uFF09',
  '\uFF08拍拍手\uFF09': '\uFF08啪啪啪\uFF09',
  '\uFF08摇头\uFF09': '\uFF08不不\uFF09',
  '\uFF08挥手\uFF09': '\uFF08拜拜~\uFF09',
}

/** 把动作括号替换为拟声词，供语音 TTS 路径使用（保留 UI 文本不动）。
 * 只匹配"（...）"形式的动作描写，且必须落在查表里，避免误伤正文里的方括号/数学公式等。
 */
export function toSpeechText(text) {
  if (!text) return text
  let out = text
  for (const [action, sound] of Object.entries(ACTION_TO_SOUND)) {
    if (out.includes(action)) out = out.split(action).join(sound)
  }
  return out
}

/** 反向（调试用）：把拟声词还原为动作描写。
 */
