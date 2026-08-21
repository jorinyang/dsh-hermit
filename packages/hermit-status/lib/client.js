/**
 * hermit-status 客户端半边：侧边栏「🦀 Hermit 状态」多栏卡片指示器。
 *
 * 形态：hand-built client bundle —— 直接写成 window.__ModuleLoader__.load 协议
 * （对齐 dsh-ssh/lib/client.js 的产物格式），无需 tsdown 构建。
 *
 * 策略：
 *  - 纯 DOM 注入（不用 React、不用 slots）：dsh 侧边栏 shell 没有可供外部插件注册
 *    到「brand 行与 workspace 之间」的 slot，故沿用 dsh-ssh 的 DOM 注入 + MutationObserver
 *    自愈手法，把面板插到 SSH 入口（[data-dsh-ssh-entry]）之后、workspace 浏览器之前。
 *  - 布局：引擎与模型分组、各用 2 栏网格；每张卡片 = 指示灯（绿=在线/黄=有问题/红=不在线）
 *    + 名称 + 明细，模型卡另带「本地/云端」徽标。
 *  - 每 3s 轮询同源 /hermit/status（host 半边注册）。
 *  - 所有副作用（DOM、style、observer、timer）经 ctx.effect 注册 disposer（TSECS A2 可逆）。
 *
 * @module hermit-status/client
 */
window.__ModuleLoader__.load({
  id: 'hermit-status',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const inject = []
    const ROW_ATTR = 'data-hermit-status'
    const STYLE_ID = 'hermit-status-style'
    const COLOR = { ok: '#22c55e', warn: '#f59e0b', down: '#ef4444', unknown: '#6b7280' }

    const CSS = [
      '[' + ROW_ATTR + ']{padding:8px 10px;font-size:12px;user-select:none;border-top:1px solid rgba(128,128,128,.25);line-height:1.3}',
      '[' + ROW_ATTR + '] .h-head{display:flex;align-items:center;gap:6px;font-weight:600;margin-bottom:2px;color:var(--dsw-alias-label-primary,#e5e7eb)}',
      '[' + ROW_ATTR + '] .h-sec{font-size:10px;color:var(--dsw-alias-label-secondary,#9ca3af);margin:8px 0 4px;letter-spacing:.5px}',
      '[' + ROW_ATTR + '] .h-grid{display:grid;grid-template-columns:1fr 1fr;gap:5px}',
      '[' + ROW_ATTR + '] .h-card{border:1px solid rgba(128,128,128,.28);border-radius:6px;padding:5px 6px;background:rgba(128,128,128,.07);min-width:0}',
      '[' + ROW_ATTR + '] .h-card .c1{display:flex;align-items:center;gap:5px;min-width:0}',
      '[' + ROW_ATTR + '] .h-dot{width:7px;height:7px;border-radius:50%;flex:none;box-shadow:0 0 4px currentColor}',
      '[' + ROW_ATTR + '] .h-name{font-weight:500;color:var(--dsw-alias-label-primary,#e5e7eb);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}',
      '[' + ROW_ATTR + '] .h-sub{font-size:10px;color:var(--dsw-alias-label-secondary,#9ca3af);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}',
      '[' + ROW_ATTR + '] .h-badge{font-size:9px;padding:1px 4px;border-radius:3px;flex:none;line-height:1.4}',
      '[' + ROW_ATTR + '] .h-badge.local{background:#1e3a8a;color:#93c5fd}',
      '[' + ROW_ATTR + '] .h-badge.cloud{background:#7c2d12;color:#fdba74}',
    ].join('\n')

    function sidebarRoot() {
      if (typeof document === 'undefined') return undefined
      const column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]')
      if (column === null) return undefined
      const logoOwner = column.querySelector('[class*="logoRow"]')?.parentElement
      return logoOwner ?? (column.firstElementChild || undefined)
    }

    function anchorElement(root) {
      const ssh = root.querySelector('[data-dsh-ssh-entry]')
      if (ssh !== null) return ssh
      const newSession = root.querySelector('button[class*="newSession"]')
      if (newSession !== null) {
        const row = newSession.closest('[class*="logoRow"]')
        return (row !== null && row.parentElement === root) ? row : newSession
      }
      return null
    }

    function inPlace(root, box, anchor) {
      if (box.parentElement !== root) return false
      if (anchor === null) return box === root.firstElementChild
      return box.previousElementSibling === anchor
    }

    function place(root, box, anchor) {
      if (anchor === null) root.insertBefore(box, root.firstElementChild)
      else root.insertBefore(box, anchor.nextElementSibling)
    }

    function colorOf(status) { return COLOR[status] ?? COLOR.unknown }

    function dot(status) {
      const d = document.createElement('span')
      d.className = 'h-dot'
      const c = colorOf(status)
      d.style.background = c
      d.style.color = c
      return d
    }

    function card(status, name, sub, badge) {
      const el = document.createElement('div')
      el.className = 'h-card'
      const c1 = document.createElement('div')
      c1.className = 'c1'
      c1.append(dot(status))
      const nm = document.createElement('span')
      nm.className = 'h-name'
      nm.textContent = name
      c1.append(nm)
      if (badge) {
        const b = document.createElement('span')
        b.className = 'h-badge ' + badge
        b.textContent = badge === 'local' ? '本地' : '云端'
        c1.append(b)
      }
      el.append(c1)
      if (sub) {
        const s = document.createElement('div')
        s.className = 'h-sub'
        s.textContent = sub
        el.append(s)
      }
      return el
    }

    function section(label) {
      const s = document.createElement('div')
      s.className = 'h-sec'
      s.textContent = label
      return s
    }

    function grid(items) {
      const g = document.createElement('div')
      g.className = 'h-grid'
      for (const it of items) g.append(it)
      return g
    }

    function worst(list) {
      let w = 'ok'
      for (const it of list ?? []) {
        if (it.status === 'down') return 'down'
        if (it.status === 'warn') w = 'warn'
      }
      return w
    }

    function render(container, data) {
      container.textContent = ''
      const engines = data && data.engines ? data.engines : []
      const models = data && data.models ? data.models : []
      const engineHealth = data && data.engine ? data.engine.health : 'down'

      const overall = engineHealth === 'down'
        ? 'down'
        : worst(engines.concat(models))

      const head = document.createElement('div')
      head.className = 'h-head'
      head.append(dot(overall))
      const title = document.createElement('span')
      title.textContent = '🦀 Hermit 状态'
      head.append(title)
      container.append(head)

      // 引擎组
      container.append(section('引擎'))
      const engineCards = engines.map((e) => card(e.status, e.label, e.detail ?? null, null))
      container.append(grid(engineCards))

      // 模型组
      container.append(section('模型'))
      const modelCards = models.map((m) => card(m.status, m.label, m.name ?? null, m.loc === 'local' ? 'local' : 'cloud'))
      container.append(grid(modelCards))
    }

    function mountStatusIndicator() {
      if (typeof document === 'undefined') return () => {}
      if (document.querySelector('[' + ROW_ATTR + ']') !== null) return () => {}

      // 注入一次样式（幂等 + 随 disposer 回收）
      let styleEl = document.getElementById(STYLE_ID)
      const styleOwned = styleEl === null
      if (styleEl === null) {
        styleEl = document.createElement('style')
        styleEl.id = STYLE_ID
        styleEl.textContent = CSS
        document.head.append(styleEl)
      }

      const box = document.createElement('div')
      box.setAttribute(ROW_ATTR, '')
      box.title = 'Hermit 各模块状态（3s 轮询）'

      let root
      let placed = false
      let alive = true
      let lastOk = false

      const tryPlace = () => {
        if (root !== undefined && !root.isConnected) {
          rootObserver.disconnect()
          root = undefined
          placed = false
        }
        if (placed) {
          if (!document.body.contains(box)) {
            rootObserver.disconnect()
            root = undefined
            placed = false
          } else if (root !== undefined && !inPlace(root, box, anchorElement(root))) {
            place(root, box, anchorElement(root))
            return
          } else {
            return
          }
        }
        root = root ?? sidebarRoot()
        if (root === undefined) return
        place(root, box, anchorElement(root))
        placed = true
        rootObserver.observe(root, { childList: true, subtree: true })
      }

      const waitObserver = new MutationObserver(() => { tryPlace() })
      waitObserver.observe(document.body, { childList: true, subtree: true })

      const rootObserver = new MutationObserver(() => { tryPlace() })

      const poll = async () => {
        if (!alive) return
        try {
          const r = await fetch('/hermit/status', { cache: 'no-store' })
          if (!alive) return
          if (!r.ok) { if (!lastOk) render(box, {}); return }
          const ct = r.headers.get('content-type') || ''
          if (!ct.includes('application/json')) { if (!lastOk) render(box, {}); return }
          const data = await r.json()
          if (!alive) return
          lastOk = true
          render(box, data)
        } catch {
          if (!alive) return
          if (!lastOk) render(box, {})
        }
      }

      poll()
      const timer = setInterval(poll, 3000)
      tryPlace()

      return () => {
        alive = false
        clearInterval(timer)
        waitObserver.disconnect()
        rootObserver.disconnect()
        box.remove()
        if (styleOwned && styleEl) styleEl.remove()
      }
    }

    function apply(ctx) {
      ctx.effect(() => mountStatusIndicator(), 'hermit-status:indicator')
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
