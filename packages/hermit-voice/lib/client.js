/**
 * hermit-voice 客户端半边：侧边栏状态指示器。
 * 轮询 /hermit-voice/status（host 路由），展示 hermit 各模块的生效/监听状态。
 * 注意：client 面用 React.createElement（无 JSX 转换），React 由 DSH client 模块表提供。
 * @module hermit-voice/client
 */
export const inject = ['slots']

const STATE_LABEL = { idle: '待机', listening: '聆听中', processing: '思考中', speaking: '说话中' }

function dot(ok, color) {
  return React.createElement('span', { style: { color: ok ? color : '#6b7280', marginRight: 6 } }, ok ? '●' : '○')
}

function Row(ok, color, name, value) {
  return React.createElement('div', { style: { display: 'flex', alignItems: 'center' } },
    dot(ok, color),
    React.createElement('span', { style: { marginRight: 6 } }, name),
    React.createElement('span', { style: { color: 'var(--fg-dim, #9ca3af)' } }, value),
  )
}

function StatusIndicator() {
  const [status, setStatus] = React.useState(null)
  React.useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const r = await fetch('/hermit-voice/status', { cache: 'no-store' })
        const data = await r.json()
        if (alive) setStatus(data.voice ?? null)
      } catch { /* 路由/引擎不可达，保留旧状态 */ }
    }
    poll()
    const t = setInterval(poll, 3000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  const health = status?.engine?.health ?? 'unknown'
  const m = status?.modules ?? null
  const ok = health === 'ok'
  const color = ok ? '#22c55e' : (health === 'down' || health === 'missing' ? '#ef4444' : '#f59e0b')

  return React.createElement('div', {
    title: 'Hermit 语音引擎状态（3s 轮询）',
    style: { padding: '8px 10px', fontSize: 12, lineHeight: '20px', userSelect: 'none' },
  },
    React.createElement('div', { style: { fontWeight: 600, marginBottom: 4 } }, '🦀 Hermit 状态'),
    Row(ok, color, '引擎', ok ? '在线' : (health === 'down' ? '离线' : health)),
    Row(m?.mic === 'ok', '#22c55e', '麦克风', m?.mic === 'ok' ? '监听中' : (m?.mic ?? '未知')),
    Row(m?.kws === 'on', '#22c55e', '唤醒', m?.kws === 'on' ? '已开' : '关'),
    Row(m?.tts === 'on', '#22c55e', '发声', m?.tts === 'on' ? '已开' : '关'),
    Row(m?.barge_vad === 'on', '#22c55e', '打断', m?.barge_vad === 'on' ? '已开' : '关'),
    status?.state ? Row(true, '#22c55e', '状态', STATE_LABEL[status.state] ?? status.state) : null,
  )
}

export function apply(ctx) {
  ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    id: 'hermit-status',
    order: 10,
    label: 'Hermit 状态',
  }, StatusIndicator)), 'hermit:status-slot')
}
