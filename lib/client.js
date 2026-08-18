// dsh-bili-learn · client half
// ===========================================================================
// 官方 __ModuleLoader__.load 契约产物（手写维护，无需 esbuild 构建链）。
// factory 返回 { name, inject, apply }，client 内核挂载时调用 apply(ctx)。
// 'react' 经 loader 模块表（平台种子）解析，用 React.createElement 手写视图。
// 职责：注册 conversation.view 槽位条目 'bili-learn'（order 7 —— 落在
// 「GAL视窗」(5) 与「轨迹」(10) 之间），组件为 B站学习面板全屏 iframe。
// 面板 URL 经同源端点 /dsh-bili-learn/api/status 实时获取（Node half 提供）。
// ===========================================================================
window.__ModuleLoader__.load({
  id: 'dsh-bili-learn',

  factory: (require) => {
    var module = { exports: {} }
    var React = require('react')
    var useState = React.useState
    var useEffect = React.useEffect
    var useCallback = React.useCallback

    var TOOLBAR = {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '8px 14px',
      background: 'rgba(255,255,255,0.04)',
      borderBottom: '1px solid rgba(255,255,255,0.08)',
      flexShrink: 0,
      position: 'relative',
      zIndex: 5,
    }
    var dot = (color) => ({
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: color,
      boxShadow: '0 0 6px ' + color,
      flexShrink: 0,
    })
    var TITLE = { fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.92)', whiteSpace: 'nowrap' }
    var MODEL = { fontSize: 11, color: 'rgba(255,255,255,0.45)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '38%' }
    var SPACER = { flex: 1 }
    var BTN = {
      fontSize: 12,
      padding: '3px 10px',
      borderRadius: 6,
      border: '1px solid rgba(255,255,255,0.18)',
      background: 'rgba(255,255,255,0.06)',
      color: 'rgba(255,255,255,0.85)',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }
    var PENDING = {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      color: 'rgba(255,255,255,0.55)',
      fontSize: 13,
      textAlign: 'center',
      padding: 24,
    }

    function BiliLearnView() {
      var _s = useState({ url: null, error: null, model: null })
      var info = _s[0]
      var setInfo = _s[1]
      var _n = useState(0)
      var nonce = _n[0]
      var setNonce = _n[1]

      var refresh = useCallback(function () {
        var alive = true
        fetch('/dsh-bili-learn/api/status', { cache: 'no-store' })
          .then(function (r) { if (!r.ok) throw new Error('status ' + r.status); return r.json() })
          .then(function (d) {
            if (!alive) return
            setInfo({ url: d && d.panelUrl ? d.panelUrl : null, error: null, model: d && d.model ? d.model : null })
          })
          .catch(function (e) {
            if (!alive) return
            setInfo({ url: null, error: String((e && e.message) || e), model: null })
          })
        return function () { alive = false }
      }, [])

      useEffect(function () { return refresh() }, [refresh, nonce])

      var url = info.url
      // 同源反代入口：iframe 加载 {origin}/dsh-bili-learn/panel/（Node half 反代到面板 18083）。
      // 面板内一切导航与 Flask 302 重定向链都在 10275 origin 内进行，DSH Desktop 的
      // will-navigate/will-redirect 守卫不会拦截、更不会转系统浏览器。
      var iframeSrc = url ? location.origin + '/dsh-bili-learn/panel/' : null
      var reload = function () { setNonce(function (n) { return n + 1 }) }
      var statusColor = info.error ? '#f85149' : url ? '#3fb950' : '#d29922'
      var statusText = info.error ? '面板离线' : url ? '面板在线' : '面板启动中…'
      var modelLabel = info.model ? info.model.provider + ' · ' + info.model.model : ''

      var children = []
      children.push(React.createElement('span', { key: 'dot', style: dot(statusColor) }))
      children.push(React.createElement('span', { key: 'title', style: TITLE }, statusText))
      if (modelLabel) children.push(React.createElement('span', { key: 'model', style: MODEL }, '【' + modelLabel + '】'))
      if (!url && !info.error) {
        children.push(React.createElement('span', { key: 'hint', style: { fontSize: 11, color: 'rgba(255,255,255,0.35)' } }, 'Node half 正在拉起 web_panel.py…'))
      }
      children.push(React.createElement('span', { key: 'sp', style: SPACER }))
      children.push(React.createElement('button', { key: 'reload', onClick: reload, style: BTN }, '刷新'))

      var body = iframeSrc
        ? React.createElement('iframe', {
            key: nonce,
            src: iframeSrc,
            style: { flex: 1, width: '100%', border: '0 none', background: '#0d1016' },
            allow: 'clipboard-write; clipboard-read; fullscreen',
            // DSH Desktop(Electron) 把所有新窗请求(window.open/target=_blank)一律转系统浏览器打开。
            // sandbox 故意不给 allow-popups：iframe 内任何弹窗请求被 Chromium 直接拒绝，
            // 不会触达主进程 setWindowOpenHandler → 在 DSH 窗口内点面板链接不再跳外部浏览器。
            sandbox: 'allow-scripts allow-same-origin allow-forms allow-modals allow-downloads',
          })
        : React.createElement(
            'div',
            { style: PENDING },
            statusText,
            info.error ? React.createElement('div', { style: { color: '#f85149', fontSize: 12, marginTop: 4 } }, info.error) : null,
          )

      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: '#111318', color: 'rgba(255,255,255,0.9)' } },
        React.createElement('div', { style: TOOLBAR }, children),
        body,
      )
    }

    function apply(ctx) {
      // slots.inject 等待 ui-conversation 槽位声明后注册；随纤维自动卸载。
      ctx.slots.inject('conversation.view', function () {
        var dispose = ctx.slots.register({
          name: 'conversation.view',
          id: 'bili-learn',
          order: 7, // 「GAL视窗」(5) 与 「轨迹」(10) 之间
          label: function () { return 'B站学习' },
        }, BiliLearnView)
        return function () {
          try { dispose() } catch (e) { /* already disposed */ }
        }
      })
    }

    module.exports = { name: 'dsh-bili-learn', inject: ['slots'], apply }
    return module.exports
  },
})