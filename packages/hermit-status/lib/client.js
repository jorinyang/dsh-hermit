/**
 * hermit-status 客户端半边：左栏「小寄状态面板」（4080 专用工作台的左侧）。
 *
 * 注册到官方 `sidebar.workspaces` 单槽，替换掉 WorkspaceBrowser（会话列表），
 * 渲染完整状态面板：活动状态（思考/说话）+ 麦克风波形 + 引擎/模型卡片。
 * 单一延续会话场景下不需要会话列表，小寄自己决定上下文隔离。
 *
 * 形态：hand-built client bundle（window.__ModuleLoader__.load 协议，无需 tsdown）。
 * 用 require('react') 取 React（模块表 externalize），React.createElement 构建（无 JSX）。
 *
 * @module hermit-status/client
 */
window.__ModuleLoader__.load({
  id: 'hermit-status',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const inject = ['slots', 'betterSidebar']
    const COLOR = { ok: '#22c55e', warn: '#f59e0b', down: '#ef4444', unknown: '#6b7280', off: '#9ca3af' }
    const STATE_LABEL = { idle: '待机', listening: '聆听中', processing: '思考中', speaking: '说话中' }

    const CSS = [
      '.hermit-panel{padding:10px 12px;font-size:12px;line-height:1.35;user-select:none;overflow-y:auto;height:100%;box-sizing:border-box}',
      '.hermit-panel .hp-head{display:flex;align-items:center;gap:6px;font-weight:600;margin-bottom:8px;color:var(--dsw-alias-label-primary,#e5e7eb)}',
      '.hermit-panel .hp-activity{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px}',
      '.hermit-panel .hp-act{border:1px solid rgba(128,128,128,.28);border-radius:8px;padding:8px 10px;background:rgba(128,128,128,.07);display:flex;align-items:center;gap:8px}',
      '.hermit-panel .hp-act .ico{font-size:16px;line-height:1}',
      '.hermit-panel .hp-act .lbl{font-size:11px;color:var(--dsw-alias-label-secondary,#9ca3af)}',
      '.hermit-panel .hp-act .val{font-weight:600;color:var(--dsw-alias-label-primary,#e5e7eb)}',
      '.hermit-panel .hp-wave-wrap{margin-bottom:8px}',
      '.hermit-panel .hp-wave{display:block;width:100%;height:46px;border-radius:6px;background:rgba(128,128,128,.07);border:1px solid rgba(128,128,128,.28)}',
      '.hermit-panel .hp-wave-label{font-size:10px;color:var(--dsw-alias-label-secondary,#9ca3af);display:flex;justify-content:space-between;margin-top:2px}',
      '.hermit-panel .hp-sec{font-size:10px;color:var(--dsw-alias-label-secondary,#9ca3af);margin:10px 0 4px;letter-spacing:.5px}',
      '.hermit-panel .hp-grid{display:grid;grid-template-columns:1fr 1fr;gap:5px}',
      '.hermit-panel .hp-card{border:1px solid rgba(128,128,128,.28);border-radius:6px;padding:5px 6px;background:rgba(128,128,128,.07);min-width:0}',
      '.hermit-panel .hp-card.clickable{cursor:pointer}',
      '.hermit-panel .hp-card.off{opacity:.5;border-style:dashed}',
      '.hermit-panel .hp-card .c1{display:flex;align-items:center;gap:5px;min-width:0}',
      '.hermit-panel .hp-dot{width:7px;height:7px;border-radius:50%;flex:none;box-shadow:0 0 4px currentColor}',
      '.hermit-panel .hp-name{font-weight:500;color:var(--dsw-alias-label-primary,#e5e7eb);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}',
      '.hermit-panel .hp-sub{font-size:10px;color:var(--dsw-alias-label-secondary,#9ca3af);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}',
      '.hermit-panel .hp-badge{font-size:9px;padding:1px 4px;border-radius:3px;flex:none;line-height:1.4}',
      '.hermit-panel .hp-badge.local{background:#1e3a8a;color:#93c5fd}',
      '.hermit-panel .hp-badge.cloud{background:#7c2d12;color:#fdba74}',
      '.hermit-res{font-size:12px;line-height:1.4;padding:2px 2px 12px;height:100%;overflow-y:auto;box-sizing:border-box}',
      '.hermit-res .hr-sec{font-size:11px;font-weight:600;color:var(--dsw-alias-label-primary,#e5e7eb);margin:12px 0 6px;display:flex;align-items:center;gap:6px}',
      '.hermit-res .hr-cnt{font-size:10px;color:var(--dsw-alias-label-secondary,#9ca3af);font-weight:400}',
      '.hermit-res .hr-item{border:1px solid rgba(128,128,128,.25);border-radius:6px;padding:6px 8px;margin-bottom:5px;background:rgba(128,128,128,.06)}',
      '.hermit-res .hr-row{display:flex;align-items:center;gap:6px;min-width:0}',
      '.hermit-res .hr-name{font-weight:500;color:var(--dsw-alias-label-primary,#e5e7eb);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}',
      '.hermit-res .hr-tag{font-size:9px;padding:1px 4px;border-radius:3px;flex:none}',
      '.hermit-res .hr-tag.on{background:#14532d;color:#4ade80}',
      '.hermit-res .hr-tag.off{background:#7f1d1d;color:#fca5a5}',
      '.hermit-res .hr-desc{font-size:11px;color:var(--dsw-alias-label-secondary,#9ca3af);margin-top:3px;word-break:break-all}',
      '.hermit-res .hr-toggle{margin-left:auto;flex:none}',
      '.hermit-panel .hp-switch{width:30px;height:16px;border-radius:8px;background:rgba(128,128,128,.35);position:relative;cursor:pointer;flex:none;transition:background .15s}',
      '.hermit-panel .hp-switch.on{background:#22c55e}',
      '.hermit-panel .hp-switch .knob{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;transition:left .15s}',
      '.hermit-panel .hp-switch.on .knob{left:16px}',
      // 补丁：better-sidebar 底部面板推挤选择器 [data-dsh-frame]>[data-pane="conversation"] 在 DSH 0.1.0-rc.8 不存在。
      // 中央列是 CSS module 哈希类名（各构建不同），但 conversation 槽宿主有稳定的 data-slot="conversation"，
      // 用 :has() 反向选中它的父级（即中央列），margin-bottom 顶起聊天/输入框。
      '#root :has(> [data-slot="conversation"]){margin-bottom:var(--dsh-sidebar-height,0px);transition:margin-bottom .2s ease}',
    ].join('\n')

    function colorOf(status) { return COLOR[status] ?? COLOR.unknown }

    function worst(list) {
      let w = 'ok'
      for (const it of list ?? []) {
        if (it.status === 'down') return 'down'
        if (it.status === 'warn') w = 'warn'
      }
      return w
    }

    function drawWave(canvas, levels, speaking) {
      if (!canvas) return
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
      const cssW = canvas.clientWidth || 200
      const cssH = canvas.clientHeight || 46
      const pw = Math.max(1, Math.round(cssW * dpr))
      const ph = Math.max(1, Math.round(cssH * dpr))
      if (canvas.width !== pw) canvas.width = pw
      if (canvas.height !== ph) canvas.height = ph
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, cssW, cssH)
      const N = 30
      const barW = cssW / N
      const gap = Math.max(1, barW * 0.28)
      const bw = Math.max(1.5, barW - gap)
      const maxLevel = 0.15
      const src = levels && levels.length ? levels.slice(-N) : []
      for (let i = 0; i < N; i++) {
        const val = src[i] ?? 0
        const h = Math.max(1.5, Math.min(1, val / maxLevel) * (cssH - 6))
        const x = i * barW + gap / 2
        const y = cssH - 3 - h
        ctx.fillStyle = val >= 0.005 ? '#22c55e' : 'rgba(128,128,128,.45)'
        ctx.fillRect(x, y, bw, h)
      }
    }

    function Dot(props) {
      const c = colorOf(props.status)
      return React.createElement('span', { className: 'hp-dot', style: { background: c, color: c } })
    }

    function Card(props) {
      const toggleable = !!props.toggleable
      const off = toggleable && !props.on
      const cls = 'hp-card' + (toggleable ? ' clickable' : '') + (off ? ' off' : '')
      const onClick = toggleable ? () => { if (props.onToggle) props.onToggle(!props.on) } : undefined
      return React.createElement('div', { className: cls, onClick },
        React.createElement('div', { className: 'c1' },
          React.createElement(Dot, { status: props.status }),
          React.createElement('span', { className: 'hp-name' }, props.label),
          props.badge
            ? React.createElement('span', { className: 'hp-badge ' + props.badge }, props.badge === 'local' ? '本地' : '云端')
            : null,
        ),
        props.sub ? React.createElement('div', { className: 'hp-sub' }, props.sub) : null,
      )
    }

    function Activity(props) {
      // 思考 / 说话 状态灯
      const thinkOn = !!(props.agent && props.agent.thinking)
      const speakOn = !!(props.agent && props.agent.speaking)
      return React.createElement('div', { className: 'hp-activity' },
        React.createElement('div', { className: 'hp-act', style: thinkOn ? { borderColor: '#22c55e', background: 'rgba(34,197,94,.08)' } : {} },
          React.createElement('span', { className: 'ico' }, '💭'),
          React.createElement('div', null,
            React.createElement('div', { className: 'lbl' }, '思考'),
            React.createElement('div', { className: 'val', style: thinkOn ? { color: '#22c55e' } : {} }, thinkOn ? '思考中' : '待机'),
          ),
        ),
        React.createElement('div', { className: 'hp-act', style: speakOn ? { borderColor: '#22c55e', background: 'rgba(34,197,94,.08)' } : {} },
          React.createElement('span', { className: 'ico' }, '🔊'),
          React.createElement('div', null,
            React.createElement('div', { className: 'lbl' }, '输出'),
            React.createElement('div', { className: 'val', style: speakOn ? { color: '#22c55e' } : {} }, speakOn ? '说话中' : '静默'),
          ),
        ),
      )
    }

    function StatusPanel() {
      const [status, setStatus] = React.useState(null)
      const [level, setLevel] = React.useState({ levels: [], speaking: false })
      const waveRef = React.useRef(null)

      const refreshStatus = React.useCallback(async () => {
        try {
          const r = await fetch('/hermit/status', { cache: 'no-store' })
          if (!r.ok) return
          const ct = r.headers.get('content-type') || ''
          if (!ct.includes('application/json')) return
          const data = await r.json()
          setStatus(data)
        } catch { /* 路由不可达保留旧状态 */ }
      }, [])

      const refreshLevel = React.useCallback(async () => {
        try {
          const r = await fetch('/hermit/level', { cache: 'no-store' })
          if (!r.ok) return
          const ct = r.headers.get('content-type') || ''
          if (!ct.includes('application/json')) return
          const data = await r.json()
          setLevel({ levels: (data && data.levels) || [], speaking: !!(data && data.speaking) })
        } catch { /* 保留旧波形 */ }
      }, [])

      React.useEffect(() => {
        refreshStatus()
        refreshLevel()
        const t1 = setInterval(refreshStatus, 3000)
        const t2 = setInterval(refreshLevel, 160)
        return () => { clearInterval(t1); clearInterval(t2) }
      }, [refreshStatus, refreshLevel])

      // 波形绘制
      React.useEffect(() => { drawWave(waveRef.current, level.levels, level.speaking) }, [level])

      const toggleEngine = async (module, on) => {
        try {
          await fetch('/hermit/engine', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ module, on }),
          })
        } catch { /* 引擎不可达 */ }
        refreshStatus()
      }

      const setWakeMode = async (mode) => {
        try {
          await fetch('/hermit/engine', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ module: 'wake', mode }),
          })
        } catch { /* 引擎不可达 */ }
        refreshStatus()
      }

      const engines = (status && status.engines) || []
      const models = (status && status.models) || []
      const engineHealth = (status && status.engine && status.engine.health) || 'down'
      const overall = engineHealth === 'down' ? 'down' : worst(engines.concat(models))
      const live = level.levels && level.levels.length ? level.levels[level.levels.length - 1] : 0
      const micOn = level.speaking || live >= 0.005
      const state = status && status.state ? (STATE_LABEL[status.state] || status.state) : null

      return React.createElement('div', { className: 'hermit-panel' },
        React.createElement('div', { className: 'hp-head' },
          React.createElement(Dot, { status: overall }),
          React.createElement('span', null, '🦀 小寄状态'),
        ),

        React.createElement(Activity, { agent: status && status.agent }),

        React.createElement('div', { className: 'hp-wave-wrap' },
          React.createElement('div', { className: 'hp-wave-label' },
            React.createElement('span', null, '麦克风'),
            React.createElement('span', { style: micOn ? { color: '#22c55e' } : {} }, micOn ? '● 收到声音' : '○ 未收到'),
          ),
          React.createElement('canvas', { className: 'hp-wave', ref: waveRef }),
        ),

        state
          ? React.createElement('div', { className: 'hp-sub', style: { marginBottom: 2 } }, '语音状态：' + state)
          : null,

        React.createElement('div', { className: 'hp-sec' }, '引擎'),
        React.createElement('div', { className: 'hp-grid' },
          engines.map((e) => {
            let on = e.on
            let onToggle = null
            if (e.toggleable) {
              if (e.id === 'kws') {
                // 唤醒三态：语音(绿)→按键(橙)→关闭(红) 循环；状态灯颜色区分，不用灰色 off 视觉
                on = true
                const order = ['voice', 'hotkey', 'off']
                const cur = order.indexOf(e.mode) >= 0 ? e.mode : 'voice'
                onToggle = () => setWakeMode(order[(order.indexOf(cur) + 1) % order.length])
              } else {
                onToggle = (v) => toggleEngine(e.id, v)
              }
            }
            return React.createElement(Card, { key: e.id, status: e.status, label: e.label, sub: e.detail || null, toggleable: !!e.toggleable, on, onToggle })
          }),
        ),

        React.createElement('div', { className: 'hp-sec' }, '模型'),
        React.createElement('div', { className: 'hp-grid' },
          models.map((m) => React.createElement(Card, { key: m.id, status: m.status, label: m.label, sub: m.name || null, badge: m.loc === 'local' ? 'local' : 'cloud' })),
        ),
      )
    }

    /** 拉取 /hermit/catalog（插件/技能/MCP/CLI 四类资源）的共享轮询。 */
    function useCatalog() {
      const [catalog, setCatalog] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        const poll = async () => {
          try {
            const r = await fetch('/hermit/catalog', { cache: 'no-store' })
            if (!alive || !r.ok) return
            const ct = r.headers.get('content-type') || ''
            if (!ct.includes('application/json')) return
            const data = await r.json()
            if (alive) setCatalog(data)
          } catch { /* 保留旧目录 */ }
        }
        poll()
        const t = setInterval(poll, 8000)
        return () => { alive = false; clearInterval(t) }
      }, [])
      return catalog
    }

    /** 可展开列表：items = [{key,name,tag,tagLabel,desc}] */
    function ExpandList(props) {
      const [open, setOpen] = React.useState({})
      const toggle = (k) => setOpen((s) => ({ ...s, [k]: !s[k] }))
      return React.createElement('div', { className: 'hermit-res' },
        (props.items || []).map((it) => {
          const expanded = !!open[it.key]
          return React.createElement('div', { key: it.key, className: 'hr-item', onClick: () => toggle(it.key), style: { cursor: 'pointer' } },
            React.createElement('div', { className: 'hr-row' },
              it.tag ? React.createElement('span', { className: 'hr-tag ' + it.tag }, it.tagLabel ?? '') : null,
              React.createElement('span', { className: 'hr-name', title: it.name }, it.name),
              React.createElement('span', { className: 'hr-toggle' }, expanded ? '▾' : '▸'),
            ),
            expanded
              ? React.createElement('div', null,
                  it.desc ? React.createElement('div', { className: 'hr-desc' }, it.desc) : null,
                )
              : null,
          )
        }),
      )
    }

    function PluginsTab() {
      const catalog = useCatalog()
      const plugins = (catalog && catalog.plugins) || []
      const items = plugins.map((p) => ({ key: 'p:' + p.id, name: p.name, tag: p.enabled ? 'on' : 'off', tagLabel: p.enabled ? '启用' : '禁用' }))
      return React.createElement(ExpandList, { items })
    }

    function SkillsTab() {
      const catalog = useCatalog()
      const skills = (catalog && catalog.skills) || []
      const items = skills.map((s) => ({ key: 's:' + s.name, name: s.name, tag: 'on', tagLabel: '启用', desc: s.description || null }))
      return React.createElement(ExpandList, { items })
    }

    function McpTab() {
      const catalog = useCatalog()
      const mcps = (catalog && catalog.mcps) || []
      const items = mcps.map((m) => ({ key: 'm:' + m.name, name: m.name, tag: 'on', tagLabel: '已接', desc: m.tools && m.tools.length ? m.tools.length + ' 个工具：' + m.tools.join(', ') : null }))
      return React.createElement(ExpandList, { items })
    }

    function CliTab() {
      const catalog = useCatalog()
      const clis = (catalog && catalog.clis) || []
      const items = clis.map((c) => ({ key: 'c:' + c.name, name: c.name, tag: 'on', tagLabel: '已装', desc: c.path || null }))
      return React.createElement(ExpandList, { items })
    }

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.id = 'hermit-status-style'
        style.textContent = CSS
        document.head.append(style)
        return () => style.remove()
      }, 'hermit-status:style')

      // JS 补丁：底部面板推挤——找到中央列（[data-slot="conversation"] 的父级），
      // 让它的 margin-bottom 引用 better-sidebar 写在 <html> 上的 --dsh-sidebar-height，
      // 底部面板打开时变量生效 → 聊天/输入框被顶上去（不覆盖）。轮询兜底 remount。
      ctx.effect(() => {
        const patch = () => {
          const slot = document.querySelector('[data-slot="conversation"]')
          const col = slot ? slot.parentElement : null
          if (col && col.style.marginBottom !== 'var(--dsh-sidebar-height, 0px)') {
            col.style.marginBottom = 'var(--dsh-sidebar-height, 0px)'
            col.style.transition = 'margin-bottom .2s ease'
          }
        }
        patch()
        const t = setInterval(patch, 1500)
        return () => clearInterval(t)
      }, 'hermit-status:bottom-push')

      // 右 Shift 唤醒快捷键：按下触发一次唤醒（PTT 式，打开聆听窗，随后说话即被识别）
      ctx.effect(() => {
        const onKey = (e) => {
          if (e.code === 'ShiftRight' && !e.repeat) {
            fetch('/hermit/wake', { method: 'POST' }).catch(() => {})
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, 'hermit-status:shift-wake')

      // 单会话模型：启动/刷新后自动接回上次主会话（fetch /hermit/last-session → sessions.open）
      ctx.effect(() => {
        let cancelled = false
        let attempts = 0
        const resume = async () => {
          if (cancelled) return
          attempts += 1
          let opened = false
          try {
            const r = await fetch('/hermit/last-session', { cache: 'no-store' })
            if (!cancelled && r.ok) {
              const ct = r.headers.get('content-type') || ''
              if (ct.includes('application/json')) {
                const data = await r.json()
                const id = data && data.sessionId
                if (id) {
                  const sessions = ctx.get('sessions')
                  if (sessions && typeof sessions.open === 'function') { sessions.open(id); opened = true }
                }
              }
            }
          } catch { /* 路由不可达则保持默认 */ }
          // 会话持久化重建可能要等 client 的 session.list RPC 落地，重试几次直到打开成功
          if (!opened && attempts < 6 && !cancelled) setTimeout(resume, 2000)
        }
        setTimeout(resume, 1500)
        return () => { cancelled = true }
      }, 'hermit-status:resume-session')

      ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register(
        { name: 'sidebar.workspaces', priority: -1 },
        StatusPanel,
      ))

      // 右侧底部面板的 4 个资源 tab：插件 / 技能 / MCP / CLI（注册进 better-sidebar，
      // 拖到底部面板即可；布局按会话持久化，拖一次生效）
      ctx.effect(() => ctx.betterSidebar.registerTab({
        id: 'hermit:plugins', title: '插件', icon: '🧩', order: 61, single: true,
        component: () => React.createElement(PluginsTab),
      }), 'hermit-status:plugins-tab')
      ctx.effect(() => ctx.betterSidebar.registerTab({
        id: 'hermit:skills', title: '技能', icon: '🧰', order: 62, single: true,
        component: () => React.createElement(SkillsTab),
      }), 'hermit-status:skills-tab')
      ctx.effect(() => ctx.betterSidebar.registerTab({
        id: 'hermit:mcp', title: 'MCP', icon: '🔌', order: 63, single: true,
        component: () => React.createElement(McpTab),
      }), 'hermit-status:mcp-tab')
      ctx.effect(() => ctx.betterSidebar.registerTab({
        id: 'hermit:cli', title: 'CLI', icon: '💻', order: 64, single: true,
        component: () => React.createElement(CliTab),
      }), 'hermit-status:cli-tab')
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
