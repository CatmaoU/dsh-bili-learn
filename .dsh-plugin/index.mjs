// dsh-bili-learn · Node half
// ===========================================================================
// 职责：
//   1) 启动/守护 bilibili_learning_bot 的 web_panel.py（Flask 管理面板）子进程；
//   2) 在 DSH webserver 上注册 OpenAI 兼容 LLM 代理（/dsh-bili-learn/v1/*），
//      把 bilibili 的 AI 调用转发给 ctx.llm.stream —— 即「自动调用 DSH 当前模型」；
//   3) 自动同步 bilibili config.json 的 API 指向为 DSH 代理 + 当前模型
//      （每次 DSH 默认模型变化自动更新，面板手工修改后 15s 内自动纠正）。
// ===========================================================================
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export const name = 'dsh-bili-learn'

/** 需要注入的 DSH 服务（官方 bundle，web profile 必装配；timer 提供 ctx.setInterval）。 */
export const inject = ['llm', 'settings', 'webServer', 'timer']

// ---- bilibili_learning_bot 固定事实 ----
const BILI_DIR = process.env.BILI_DIR || path.join(os.homedir(), 'Documents', 'deepseek', 'bilibili_learning_bot-main')
const BILI_WEB_PORT = 18083 // utils/web_launcher.py DEFAULT_WEB_PORT
const BILI_SERVICE_ID = 'bilibili-learning-bot-web' // /api/health 的 service 标识
const HEALTH_TIMEOUT = 2500
const TICK_MS = 15_000
const PREFIX = '/dsh-bili-learn'
const V1 = '/dsh-bili-learn/v1'
// 同源面板反代前缀：iframe 一律加载 {DSH_ORIGIN}/dsh-bili-learn/panel/，
// 由本插件把请求转发到 18083。iframe 内的一切导航（含 Flask 的 302
// 重定向链 /login?next=/）都停留在 10275 白名单 origin 内，DSH Desktop 的
// will-navigate/will-redirect 守卫不会再把它当外链转系统浏览器 —— 这是对
// 「一点 B站学习 就跳外部浏览器」的治本修复。
const PANEL = '/dsh-bili-learn/panel'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const STATE_FILE = path.join(os.homedir(), '.dsh', 'dsh-bili-learn-state.json')
/** 持久化代理 token：重载/重启/重注入不再更换，避免运行中的 bilibili 掉线。 */
function loadOrCreateToken() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (typeof raw.token === 'string' && raw.token.length >= 16) return raw.token
  } catch { /* 首次运行 */ }
  const t = crypto.randomBytes(24).toString('hex')
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify({ token: t }, null, 2), 'utf8')
  } catch (e) { console.log('[dsh-bili-learn] 写 state 文件失败:', String(e && e.message || e)) }
  return t
}

export function apply(ctx) {
  const state = {
    child: null,
    panelPort: null,
    token: loadOrCreateToken(),
    route: null,
    stdoutTail: '',
    logs: [],
    startedAt: Date.now(),
    stopped: false,
  }

  /** 惰性服务获取：属性级注入面差异时退回 ctx.get()，两者都失败返回 undefined。 */
  const svc = (name) => {
    try {
      if (typeof ctx.get === 'function') {
        const v = ctx.get(name)
        if (v !== undefined) return v
      }
      return ctx[name]
    } catch { return undefined }
  }
  const getSettings = () => svc('settings')
  const getWs = () => svc('webServer')
  const getLlm = () => svc('llm')

  const log = (...a) => {
    const line = `[dsh-bili-learn] ${a.join(' ')}`
    console.log(line)
    state.logs.push(line)
    if (state.logs.length > 400) state.logs.shift()
  }
  const warn = (...a) => log('[warn]', ...a)

  // ---------- 通用 http 工具 ----------
  const httpGetJson = (url) =>
    new Promise((resolve) => {
      const req = http.get(url, { timeout: HEALTH_TIMEOUT }, (res) => {
        let buf = ''
        res.on('data', (d) => (buf += d))
        res.on('end', () => {
          try { resolve(JSON.parse(buf)) } catch { resolve(null) }
        })
      })
      req.on('timeout', () => { req.destroy(); resolve(null) })
      req.on('error', () => resolve(null))
    })

  /** 写 JSON 响应。全程 try/catch：客户端提前断开时 writeHead/end 会抛错，
   *  handleChat 等 async handler 若不包住，unhandledRejection 在 Node 默认
   *  会直接崩掉整个 DSH 进程（用户重启后才会恢复），这里静默吞掉。 */
  const json = (res, status, payload) => {
    try {
      if (res.destroyed || res.writableEnded) return
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(payload))
    } catch { /* 客户端已断开，忽略写失败 */ }
  }

  const readBody = (req, limit = 32 * 1024 * 1024) =>
    new Promise((resolve, reject) => {
      const chunks = []
      req.on('data', (c) => {
        chunks.push(c)
        const total = chunks.reduce((n, x) => n + x.length, 0)
        if (total > limit) { req.destroy(new Error('body too large')); }
      })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })

  const probePanel = async (port) => {
    const j = await httpGetJson(`http://127.0.0.1:${port}/api/health`)
    if (j === null) return false
    if (!(j.ok === true)) return false
    const svc = typeof j.service === 'string' ? j.service : ''
    return svc.includes(BILI_SERVICE_ID) || svc.includes('bilibili')
  }

  const panelUrl = () => (state.panelPort ? `http://127.0.0.1:${state.panelPort}` : null)

  // ---------- DSH 当前模型 route ----------
  const currentRoute = () => {
    try {
      const s = getSettings()
      const v = s && typeof s.get === 'function' ? s.get('agent-default-model') : undefined
      if (v && typeof v.provider === 'string' && typeof v.model === 'string' && v.provider && v.model) {
        return { provider: v.provider, model: v.model }
      }
    } catch (e) { warn('读取 agent-default-model 失败:', String(e && e.message || e)) }
    return null
  }

  const dshBaseUrl = () => {
    try {
      const ws = getWs()
      const port = ws && ws.port ? ws.port : undefined
      if (port) return `http://127.0.0.1:${port}`
    } catch { /* ignore */ }
    return process.env.DSH_WEB_URL || 'http://127.0.0.1:10275'
  }

  // ---------- bilibili config.json 自动同步 ----------
  const configFile = () => {
    const root = process.env.BILI_USER_DATA_DIR || process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(root, process.env.BILI_USER_DATA_DIR ? '' : 'BiliLearn', 'Data', 'config.json')
  }

  const syncBiliConfig = () => {
    const route = currentRoute()
    if (!route) return false
    const file = configFile()
    let cfg = null
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return false } // 面板尚未初始化 → env 兜底
    if (!cfg || typeof cfg !== 'object') return false
    if (!cfg.api || typeof cfg.api !== 'object') cfg.api = {}
    const baseUrl = `${dshBaseUrl()}${V1}`
    let changed = false
    // 连接核心字段：强制接管（「自动调用 DSH 当前模型」）
    for (const [k, v] of Object.entries({
      unified_base_url: baseUrl,
      unified_api_key: state.token,
      model_brain: route.model,
    })) {
      if (cfg.api[k] !== v) { cfg.api[k] = v; changed = true }
    }
    // vision / html：仅当为空或已指向我方代理时接管（尊重用户自定义视觉提供商）
    const takeOverIfEmptyOrMine = (k, v) => {
      const cur = cfg.api[k]
      if (typeof cur === 'string' && cur && !String(cur).includes(PREFIX)) return
      if (cur !== v) { cfg.api[k] = v; changed = true }
    }
    takeOverIfEmptyOrMine('vision_base_url', baseUrl)
    takeOverIfEmptyOrMine('vision_api_key', state.token)
    takeOverIfEmptyOrMine('model_vision', route.model)
    takeOverIfEmptyOrMine('model_html', route.model)
    if (!changed) return false
    try {
      if (fs.existsSync(file)) fs.copyFileSync(file, file + '.dsh-bak')
      const tmp = file + '.dsh-tmp'
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
      fs.renameSync(tmp, file)
      log('已同步 bilibili AI 配置 →', route.provider, '/', route.model)
      return true
    } catch (e) {
      warn('写 config.json 失败:', String(e && e.message || e))
      return false
    }
  }

  // ---------- 面板子进程 ----------
  // 跨进程文件锁：多个 fiber/模块副本并发启动面板时只允许一个 spawn 者。
  // O_EXCL 原子创建；持有者进程死了（残留锁）则回收。
  const acquireSpawnLock = () => {
    const dir = path.join(os.homedir(), '.dsh')
    try { fs.mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
    const file = path.join(dir, 'dsh-bili-learn-spawn.lock')
    const write = () => {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' })
      return () => { try { fs.unlinkSync(file) } catch { /* ignore */ } }
    }
    try { return write() } catch { /* 已被占用 */ }
    let holder = NaN
    try { holder = Number(String(fs.readFileSync(file, 'utf8')).trim()) } catch { /* 读不到 */ }
    if (!Number.isInteger(holder) || holder <= 0 || !isPidAlive(holder)) {
      // 持有者已退出：回收残留锁后重试一次
      try { fs.unlinkSync(file) } catch { /* ignore */ }
      try { return write() } catch { return null }
    }
    return null
  }
  const isPidAlive = (pid) => {
    try { process.kill(pid, 0); return true } catch (e) {
      return typeof e === 'object' && e !== null && e.code === 'EPERM'
    }
  }
  // 互斥锁：startPanel 的探测循环（最长 ~16s）是无锁窗口，apply 直调与
  // tick 保活并发时会各自 spawn 一份 web_panel.py（同秒双实例、争用 18083）。
  let panelBusy = false
  const startPanel = async () => {
    if (panelBusy) { log('面板启动流程进行中，跳过并发启动'); return }
    panelBusy = true
    try {
      // 1) 复用已在运行的 bilibili 面板
      for (let p = BILI_WEB_PORT; p < BILI_WEB_PORT + 8; p += 1) {
        if (await probePanel(p)) {
          state.panelPort = p
          log('复用已在运行的面板 →', panelUrl())
          syncBiliConfig()
          return
        }
      }
    if (state.child) return

    // 跨实例互斥：DSH 重启/热装可能并存多个 fiber（各自闭包锁互不可见），
    // 若都探测失败会各自 spawn 一份 web_panel.py（同秒双实例、争用 18083、
    // 登录 cookie 轮流失效）。文件原子锁（O_EXCL）保证全进程只有一个 spawn 者。
    const releaseLock = acquireSpawnLock()
    if (releaseLock === null) {
      log('检测到其它实例正在启动面板（锁占用），等 8s 后尝试复用')
      await sleep(8000)
      if (await probePanel(BILI_WEB_PORT)) {
        state.panelPort = BILI_WEB_PORT
        log('复用其它实例启动的面板 →', panelUrl())
        syncBiliConfig()
      } else {
        warn('锁等待 8s 后面板仍未就绪，本次放弃（后续 tick 会重试）')
      }
      return
    }
    try {
      log('18083+8 端口未发现可复用面板，准备拉起 web_panel.py')
      // 2) 启动 web_panel.py
      const env = {
        ...process.env,
        BILI_WEB_AUTO_OPEN: '0',     // 不要自动开浏览器
        BILI_TRAY_DISABLED: '1',     // 不要托盘
        BILI_DISCLAIMER_SKIP: '1',   // 跳过免责输入（含 Web 免责确认，内嵌 iframe 必需）
        WEB_PORT: String(BILI_WEB_PORT),
        PYTHONIOENCODING: 'utf-8',
        // env 兜底（config.json 非空时 config 优先，二者不冲突）
        BILI_AI_BASE_URL: `${dshBaseUrl()}${V1}`,
        BILI_AI_API_KEY: state.token,
      }
      log('启动 web_panel.py …')
      const child = spawn('python', ['-u', 'web_panel.py'], { cwd: BILI_DIR, env, windowsHide: true })
      state.child = child
      child.stdout.on('data', (d) => { state.stdoutTail = (state.stdoutTail + String(d)).slice(-4000) })
      child.stderr.on('data', (d) => { state.stdoutTail = (state.stdoutTail + String(d)).slice(-4000) })
      child.on('exit', (code, signal) => {
        if (state.stopped) return
        warn('面板子进程退出 code=' + String(code) + ' signal=' + String(signal))
        if (state.child === child) state.child = null
        if (state.panelPort !== null) state.panelPort = null
      })
      child.on('error', (e) => {
        // spawn 失败（如 python 不在 PATH）：必须清引用，否则 tick 的
        // `!state.child` 判断永远为假，面板自愈/重启逻辑被活尸阻塞。
        warn('spawn web_panel.py 失败:', String(e))
        if (state.child === child) state.child = null
      })
      // 3) 等待健康就绪（18083 被外部占用时从 stdout 找 fallback 端口）
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline && state.child && state.panelPort === null) {
        if (await probePanel(BILI_WEB_PORT)) { state.panelPort = BILI_WEB_PORT; break }
        const m = state.stdoutTail.match(/127\.0\.0\.1:(\d+)/)
        if (m) {
          const p = Number(m[1])
          if (p !== BILI_WEB_PORT && Number.isInteger(p) && p > 0 && (await probePanel(p))) { state.panelPort = p; break }
        }
        await sleep(800)
      }
      if (state.panelPort !== null) {
        log('面板就绪 →', panelUrl())
        syncBiliConfig()
      } else {
        warn('面板 60s 内未就绪；stdout 尾部:', state.stdoutTail.slice(-400))
      }
    } finally {
      releaseLock()
    }
    } finally {
      panelBusy = false
    }
  }

  const stopPanel = () => {
    if (state.child) {
      try { state.child.kill() } catch { /* ignore */ }
    }
    state.child = null
    state.panelPort = null
  }

  // ---------- 同源面板反代 ----------
  /** 把 {DSH_ORIGIN}/dsh-bili-learn/panel<rest> 映射为 http://127.0.0.1:<panelPort><rest>。
   *  req.url 是 webserver 传入的原始 URL（含 query），剥掉 PANEL 前缀得面板侧路径。 */
  const panelRestOf = (reqUrl) => {
    const q = reqUrl.indexOf('?')
    const path = q >= 0 ? reqUrl.slice(0, q) : reqUrl
    const query = q >= 0 ? reqUrl.slice(q) : ''
    if (path === PANEL || path === `${PANEL}/`) return '/' + query
    if (path.startsWith(`${PANEL}/`)) return path.slice(PANEL.length) + query
    return null
  }
  const dshOrigin = () => dshBaseUrl() // http://127.0.0.1:10275
  const panelAbsBase = () => `${dshOrigin()}${PANEL}` // http://127.0.0.1:10275/dsh-bili-learn/panel

  /** Location 头重写：面板 302 目标（/login?next=/ 等根路径或 18083 绝对 URL）
   *  → 同源反代前缀路径。这样 iframe 子帧的重定向永远落在 10275 白名单内。
   *  注意：query 里的 next/location 等跳转参数同样是「面板根」语义，必须一起前缀化——
   *  否则登录页 JS 拿到裸 '/' 会 location.href='/' 跳回 DSH 根（套娃）。 */
  const PANEL_QUERY_KEYS = ['next', 'location', 'to', 'redirect']
  const rewritePanelQueries = (loc) => {
    if (!/next=|location=|to=|redirect=/.test(loc)) return loc
    const qi = loc.indexOf('?')
    if (qi < 0) return loc
    const head = loc.slice(0, qi)
    const hi = loc.indexOf('#', qi)
    const qbody = hi >= 0 ? loc.slice(qi + 1, hi) : loc.slice(qi + 1)
    const hash = hi >= 0 ? loc.slice(hi) : ''
    let sp
    try { sp = new URLSearchParams(qbody) } catch { return loc }
    let changed = false
    for (const k of PANEL_QUERY_KEYS) {
      const v = sp.get(k)
      if (!v || !v.startsWith('/')) continue
      if (v.startsWith(PANEL) || v.startsWith('http:') || v.startsWith('https:') || v.startsWith('#')) continue
      const nv = PANEL + (v === '/' ? '/' : v)
      if (nv !== v) { sp.set(k, nv); changed = true }
    }
    return changed ? head + '?' + sp.toString() + hash : loc
  }
  const rewriteLocation = (loc) => {
    if (typeof loc !== 'string') return loc
    let out = loc
    if (loc.startsWith('http://127.0.0.1:') || loc.startsWith('http://localhost:')) {
      try {
        const u = new URL(loc)
        if (String(u.port) !== String(BILI_WEB_PORT)) return loc
        const p = u.pathname === '/' ? '/' : u.pathname
        out = `${panelAbsBase()}${p}${u.search}${u.hash}`
      } catch { return loc }
    } else if (loc.startsWith('/')) {
      out = `${PANEL}${loc === '/' ? '/' : loc}`
    } else {
      return loc
    }
    return rewritePanelQueries(out)
  }

  /** text/html 响应重写：
   *  ① 根路径字面量（'/api/、"/assets/ 等 + href/location 导航）加 PANEL 前缀
   *     —— web_panel 的 943KB 单页模板与内联页全部用根路径引用资源/API/导航；
   *  ② 绝对 18083 URL 防呆替成同源前缀；
   *  ③ 注入 <base> 兜底相对路径。逐字面量替换（不整类正则），避免误伤
   *     split('/')、'/'+xx 拼接等非路径语义。 */
  const rewriteHtml = (s) => {
    let out = s
    // 0) 绝对 URL 防呆（Flask url_for(_external) 可能生成）
    out = out.split(`http://127.0.0.1:${BILI_WEB_PORT}`).join(panelAbsBase())
    out = out.split(`http://localhost:${BILI_WEB_PORT}`).join(panelAbsBase())
    // 1) API / 静态资源根路径字面量（双引号与单引号两态）
    out = out.split('"/api/').join(`"${PANEL}/api/`)
    out = out.split("'/api/").join(`'${PANEL}/api/`)
    out = out.split('"/assets/').join(`"${PANEL}/assets/`)
    out = out.split("'/assets/").join(`'${PANEL}/assets/`)
    out = out.split('"/static/').join(`"${PANEL}/static/`)
    out = out.split("'/static/").join(`'${PANEL}/static/`)
    // 2) 页面导航：<a href="/..."> 与 JS location.href="/..."/location.href='...'
    //    通用单/双引号形态（'/' 精确态由通用规则自然覆盖），再加 assign/replace/window 变体
    out = out.split('href="/').join(`href="${PANEL}/`)
    out = out.split("location.href='").join(`location.href='${PANEL}/`)
    out = out.split('location.href="').join(`location.href="${PANEL}/`)
    out = out.split("location.assign('").join(`location.assign('${PANEL}/`)
    out = out.split('location.replace("').join(`location.replace("${PANEL}/`)
    out = out.split("window.location='").join(`window.location='${PANEL}/`)
    out = out.split('window.location="').join(`window.location="${PANEL}/`)
    // 无 location 前缀的独立字面量形态：next 默认值（||'/'）、三元分支 '/account-security'
    out = out.split("||'/'").join(`||'${PANEL}/'`)
    out = out.split('||"/"').join(`||"${PANEL}/"`)
    out = out.split("'/account-security'").join(`'${PANEL}/account-security'`)
    out = out.split('"/account-security"').join(`"${PANEL}/account-security"`)
    // 3) <base> 兜底相对路径（head 在单页模板/内联页均存在）
    out = out.replace(/<head[^>]*>/i, (m) => `${m}<base href="${PANEL}/">`)
    return out
  }

  /** 反代：面板侧任意路径 → 流式透传；text/html 走 rewriteHtml，Location 走 rewriteLocation。
   *  所有写出路径 try 包裹：客户端提前断开时写失败静默吞掉，绝不让 unhandled 崩 DSH。 */
  const proxyPanel = (req, res, rest) => {
    const base = panelUrl()
    if (!base) return json(res, 503, { error: '面板未运行', type: 'panel_offline' })
    let u
    try { u = new URL(base + rest) } catch { return json(res, 502, { error: 'bad panel rest: ' + String(rest), type: 'bad_rest' }) }
    const headers = { ...req.headers }
    // [DSH 托管] 面板 before_request 以该头识别「经 DSH 同源反代进入」→ 免登录授信
    headers['X-DSH-Panel'] = '1'
    try { headers.host = u.host } catch { /* 保留原始 Host */ }
    const upstream = http.request(u, { method: req.method, headers }, (up) => {
      const h = {}
      for (const [k, v] of Object.entries(up.headers || {})) {
        const lk = k.toLowerCase()
        if (['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'].includes(lk)) continue
        if (lk === 'location') { h[k] = rewriteLocation(v); continue }
        h[k] = v
      }
      const ct = String(h['content-type'] || '')
      if (/text\/html/.test(ct)) {
        const chunks = []
        up.on('data', (c) => chunks.push(c))
        up.on('error', () => { /* 上游中断 */ })
        up.on('end', () => {
          try {
            let s = Buffer.concat(chunks).toString('utf8')
            s = rewriteHtml(s)
            h['content-length'] = String(Buffer.byteLength(s))
            h['cache-control'] = 'no-store'
            if (!res.headersSent) res.writeHead(up.statusCode || 502, h)
            res.end(s)
          } catch { /* 客户端断开，忽略 */ }
        })
        return
      }
      try {
        if (!res.headersSent) res.writeHead(up.statusCode || 502, h)
        if (req.method === 'HEAD') { res.end(); up.resume() } else up.pipe(res)
      } catch { try { up.resume() } catch { /* */ } }
    })
    upstream.on('error', (e) => {
      if (res.headersSent) { try { res.destroy() } catch { /* */ } return }
      json(res, 502, { error: '面板反代失败: ' + String(e && e.message || e), type: 'panel_proxy_error' })
    })
    if (req.method === 'GET' || req.method === 'HEAD' || !req) upstream.end()
    else {
      req.on('error', () => { try { upstream.destroy() } catch { /* */ } })
      req.pipe(upstream)
    }
  }

  // ---------- 直连上游（图片/降级路径） ----------
  const resolveUpstream = () => {
    try {
      const pi = getSettings() ? getSettings().get('llm-pi-ai') : undefined
      const providers = (pi && pi.providers) || {}
      const route = currentRoute()
      if (route) {
        const p = providers[route.provider] || providers[String(route.provider).replace(/-vision$/, '')]
        if (p && p.baseURL) {
          return { baseURL: String(p.baseURL).replace(/\/+$/, ''), apiKey: p.apiKeyEnv ? (process.env[p.apiKeyEnv] || '') : '' }
        }
      }
      const vision = getSettings() ? getSettings().get('dsh-vision') : undefined
      if (vision && vision.baseURL) return { baseURL: String(vision.baseURL).replace(/\/+$/, ''), apiKey: vision.apiKey || '' }
    } catch { /* ignore */ }
    return null
  }

  const hasImagePayload = (messages) =>
    Array.isArray(messages) && messages.some((m) => {
      const c = m && m.content
      if (typeof c === 'string') return c.includes('data:image/')
      if (Array.isArray(c)) return c.some((p) => p && typeof p === 'object' && (p.type === 'image_url' || p.type === 'image' || typeof p.image_url === 'string'))
      return false
    })

  /**
   * OpenAI 兼容 messages → DSH 内部消息格式。
   * DSH llm 管线要求 content 为块数组（[{type:'text',text}]，与多模态结构一致），
   * 字符串会被 pi-ai 拒绝（content.some is not a function）。
   * 图片块已被 hasImagePayload 拦截（走直连），这里只保留 text 块。
   */
  const toDshMessages = (messages) =>
    Array.isArray(messages) ? messages.map((m) => {
      const role = (m && typeof m.role === 'string' && m.role) || 'user'
      let content
      if (typeof m.content === 'string') content = [{ type: 'text', text: m.content }]
      else if (Array.isArray(m.content)) content = m.content
        .filter((p) => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
        .map((p) => ({ type: 'text', text: p.text }))
      else content = []
      return content.length ? { role, content } : null
    }).filter(Boolean) : []

  /** 转发到真实上游（OpenAI 兼容），同构透传状态/头/流。 */
  /** 把上游响应管道到客户端 res。回调上下文中的同步异常会变成
   *  uncaughtException（Node 默认崩进程），必须全包 try。 */
  const pipeTo = (res, upstream, wantStream = false) => {
    try {
      if (res.destroyed || res.writableEnded) {
        // 客户端已断开：把上游流排干，避免 socket 悬挂
        try { upstream.resume() } catch { /* ignore */ }
        return
      }
      const h = { ...upstream.headers }
      if (wantStream) h['Content-Type'] = 'text/event-stream; charset=utf-8'
      res.writeHead(upstream.statusCode || 502, h)
      upstream.pipe(res)
    } catch (e) { warn('pipe 到客户端失败:', String(e && e.message || e)) }
  }

  const pipedUpstream = (url, bodyJson, onResponse, onError) => {
    const up = resolveUpstream()
    if (!up) { onError(new Error('no upstream route')); return }
    const u = new URL(up.baseURL + url)
    const payload = Buffer.from(JSON.stringify(bodyJson))
    const headers = { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) }
    if (up.apiKey) headers.Authorization = `Bearer ${up.apiKey}`
    const req = http.request(u, { method: 'POST', headers }, (res) => onResponse(res))
    req.on('error', onError)
    req.end(payload)
  }

  // ---------- LLM 代理：/v1/chat/completions ----------
  const handleChat = async (req, res) => {
    const auth = req.headers.authorization || ''
    if (auth !== `Bearer ${state.token}`) return json(res, 401, { error: { message: 'invalid api key', type: 'invalid_api_key' } })
    let body
    try { body = JSON.parse((await readBody(req)).toString('utf8')) }
    catch { return json(res, 400, { error: { message: 'bad json body', type: 'invalid_request_error' } }) }
    const route = currentRoute()
    if (!route) return json(res, 503, { error: { message: 'DSH 未配置默认模型（agent-default-model）', type: 'dsh_no_model' } })
    const model = typeof body.model === 'string' && body.model ? body.model : route.model
    const wantStream = body.stream === true
    const rawMessages = Array.isArray(body.messages) && body.messages.length ? body.messages : [{ role: 'user', content: 'ping' }]

    // 含图片负载：DSH 动态 base64 图走 attachment 管线不可靠 → 直连上游
    if (hasImagePayload(rawMessages)) {
      pipedUpstream('/chat/completions', { ...body, model }, (upstream) => pipeTo(res, upstream), (e) => warn('直连上游失败:', String(e && e.message || e)))
      return
    }
    const messages = toDshMessages(rawMessages)

    const ac = new AbortController()
    req.on('close', () => ac.abort())

    // 流式：边收边发（打字机效果）；非流式：收集后输出。失败且未输出任何内容 → 无缝降级直连
    const created = Math.floor(Date.now() / 1000)
    const id = `chatcmpl-${crypto.randomBytes(6).toString('hex')}`
    const toFinishReason = (f) => !f || f.kind === 'stop' ? 'stop' : f.kind === 'max-tokens' ? 'length' : f.kind === 'tool-calls' ? 'tool_calls' : null
    const attemptDshStream = async () => {
      const llm = getLlm()
      if (!llm) return { error: new Error('DSH llm 服务不可用') }
      const opts = { provider: route.provider, model: route.model, messages, sessionId: 'bili-learn', purpose: 'bili-learn-llm-proxy', signal: ac.signal }
      if (typeof body.max_tokens === 'number' || typeof body.maxTokens === 'number') opts.maxTokens = body.max_tokens ?? body.maxTokens
      if (typeof body.temperature === 'number') opts.temperature = body.temperature

      if (!wantStream) {
        const deltas = [] // [{t:'text'|'reasoning', s:string}]
        let content = ''
        let usage = null
        let finish = null
        let failed = null
        try {
          for await (const chunk of llm.stream(opts)) {
            switch (chunk && chunk.type) {
              case 'text-delta': content += chunk.text; deltas.push({ t: 'text', s: chunk.text }); break
              case 'reasoning-delta': deltas.push({ t: 'reasoning', s: chunk.text }); break
              case 'usage': usage = chunk.usage; break
              case 'finish': finish = chunk.reason; break
            }
          }
        } catch (e) { failed = e }
        const fr = failed ? failed : finish && finish.kind === 'error' ? (finish.failure && (finish.failure.message || finish.failure.code)) || new Error(String(finish.kind)) : null
        if (fr) return { error: fr }
        json(res, 200, {
          id, object: 'chat.completion', created, model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: toFinishReason(finish) }],
          usage: usage || undefined,
        })
        return { wrote: true }
      }

      // 流式：边收边发
      const SSE_HEADERS = { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }
      let headSent = false
      let wrote = false
      let usage = null
      let finish = null
      let failed = null
      const send = (obj) => {
        if (!obj) return
        if (!headSent) { headSent = true; res.writeHead(200, SSE_HEADERS) }
        res.write(`data: ${JSON.stringify(obj)}\n\n`)
      }
      const chunkEvent = (delta) => ({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: null }] })
      try {
        for await (const chunk of llm.stream(opts)) {
          if (!chunk) continue
          if (chunk.type === 'text-delta') { wrote = true; send(chunkEvent({ content: chunk.text })) }
          else if (chunk.type === 'reasoning-delta') { wrote = true; send(chunkEvent({ reasoning_content: chunk.text })) }
          else if (chunk.type === 'usage') usage = chunk.usage
          else if (chunk.type === 'finish') { finish = chunk.reason; break }
        }
      } catch (e) { failed = e }
      const fr = failed ? failed : finish && finish.kind === 'error' ? (finish.failure && (finish.failure.message || finish.failure.code)) || new Error(String(finish.kind)) : null
      if (fr) {
        if (wrote) {
          // 已发出数据：无法降级，用受控终止收尾
          try {
            send(chunkEvent({}))
            send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], })
            if (usage) send({ id, object: 'chat.completion.chunk', created, model, choices: [], usage })
            res.write('data: [DONE]\n\n'); res.end()
          } catch { /* ignore */ }
          return { wrote: true }
        }
        return { error: fr }
      }
      try {
        send(chunkEvent({}))
        if (usage) send({ id, object: 'chat.completion.chunk', created, model, choices: [], usage })
        res.write('data: [DONE]\n\n'); res.end()
      } catch { /* ignore */ }
      return { wrote: true }
    }

    let result
    try { result = await attemptDshStream() } catch (e) { result = { error: e } } // 最终保险：绝不外抛 rejection
    if (result && result.error) {
      // DSH 流失败且未输出 → 自动降级直连真实上游（OpenAI 兼容，同形透传）
      const failedReason = result.error
      warn('ctx.llm 流失败，降级直连上游:', String(failedReason && failedReason.message || failedReason))
      if (req.destroyed || res.writableEnded) return
      pipedUpstream('/chat/completions', { ...body, model }, (upstream) => pipeTo(res, upstream, wantStream), (e) => json(res, 502, { error: { message: 'DSH 模型调用失败且上游不可用: ' + String(e && e.message || e), type: 'dsh_upstream_error' } }))
    }
  }

  // ---------- /v1/models ----------
  const handleModels = (_req, res) => {
    const route = currentRoute()
    const data = route ? [{ id: route.model }] : []
    json(res, 200, { object: 'list', data })
  }

  // ---------- /v1/images/generations（直连上游） ----------
  const handleImages = (req, res) => {
    readBody(req).then((raw) => {
      let body
      try { body = JSON.parse(raw.toString('utf8')) } catch { return json(res, 400, { error: { message: 'bad json body', type: 'invalid_request_error' } }) }
      pipedUpstream('/images/generations', body, (upstream) => pipeTo(res, upstream), (e) => json(res, 502, { error: { message: '上游不可用: ' + String(e && e.message || e), type: 'dsh_upstream_error' } }))
    }).catch(() => json(res, 400, { error: { message: 'bad body', type: 'invalid_request_error' } }))
  }

  // ---------- 状态端点（client half 与调试用） ----------
  const statusPayload = () => ({
    ok: state.panelPort !== null,
    panelUrl: panelUrl(),
    dshBaseUrl: dshBaseUrl(),
    model: currentRoute(),
    tokenConfigured: true,
    configFile: configFile(),
    childAlive: state.child !== null,
    uptimeMs: Date.now() - state.startedAt,
    logs: state.logs.slice(-20),
    debug: {
      settingsSvc: !!getSettings(),
      llmSvc: !!getLlm(),
      wsSvc: !!getWs(),
      panelPort: state.panelPort,
      // 反代路由存续标记（重启后核验：exact=/dsh-bili-learn/panel 与 prefix 同 path 都须 true）
      panelRoutes: (() => {
        try {
          const ws = getWs()
          if (!ws || typeof ws.match !== 'function') return null
          const e = ws.exact && ws.exact.has(PANEL)
          const p = ws.prefixes && ws.prefixes.has(PANEL)
          return { exact: !!e, prefix: !!p }
        } catch { return null }
      })(),
    },
  })

  // ---------- 装配 ----------
  const disposers = []
  let routesRegistered = false
  const registerRoutes = () => {
    const ws = getWs()
    if (!ws) {
      warn('webServer 服务不可用，路由未注册（15s 后由 tick 重试）')
      return
    }
    // register 前先清理同 path 残留（热重装后旧 fiber 的路由可能仍在内表，会抛 duplicate）
    const tryRegister = (route) => {
      try {
        const d = ws.register(route)
        disposers.push(d)
        return true
      } catch (e) {
        const table = route.kind === 'exact' ? ws.exact : ws.prefixes
        if (table && typeof table.delete === 'function') {
          try { table.delete(route.path) } catch { /* ignore */ }
          try {
            const d = ws.register(route)
            disposers.push(d)
            warn('已清理残留路由并重注册', route.path)
            return true
          } catch (e2) {
            warn('重注册仍失败', route.path, String(e2 && e2.message || e2))
          }
        } else {
          warn('注册失败且无法清理:', route.path, String(e && e.message || e))
        }
        return false
      }
    }
    let all = true
    all = tryRegister({ kind: 'exact', path: `${PREFIX}/api/status`, handler: (req, res) => json(res, 200, statusPayload()) }) && all
    all = tryRegister({ kind: 'exact', path: `${PREFIX}/healthz`, handler: (_req, res) => json(res, 200, { ok: true }) }) && all
    all = tryRegister({ kind: 'exact', path: `${V1}/chat/completions`, handler: handleChat }) && all
    all = tryRegister({ kind: 'exact', path: `${V1}/models`, handler: handleModels }) && all
    all = tryRegister({ kind: 'exact', path: `${V1}/images/generations`, handler: handleImages }) && all
    // 同源面板反代：iframe 从 {DSH_ORIGIN}/dsh-bili-learn/panel/ 加载面板
    all = tryRegister({ kind: 'exact', path: PANEL, handler: (req, res) => proxyPanel(req, res, '/') }) && all
    // prefix 必须不带尾斜杠：dsh-host-webserver match() 判据是
    // `pathname.startsWith(prefix + '/')` —— 带尾斜杠会变双斜杠，除 /panel/ 外全部 miss 落 SPA。
    all = tryRegister({ kind: 'prefix', path: PANEL, handler: (req, res) => {
      const rest = panelRestOf(req.url || '/')
      if (rest === null) return json(res, 404, { error: 'unknown panel path: ' + String(req.url), type: 'bad_panel_path' })
      proxyPanel(req, res, rest)
    } }) && all
    routesRegistered = all
  }

  const tick = async () => {
    if (state.stopped) return
    const route = currentRoute()
    if (route && (!state.route || state.route.provider !== route.provider || state.route.model !== route.model)) {
      state.route = route
      log('DSH 当前模型 →', route.provider, '·', route.model)
    }
    try { syncBiliConfig() } catch (e) { warn('config 同步异常:', String(e && e.message || e)) }
    if (!routesRegistered) registerRoutes() // 启动时序导致的路由缺失自愈
    // 面板保活
    if (state.panelPort !== null) {
      if (!(await probePanel(state.panelPort)) && !state.child) { state.panelPort = null; await startPanel() }
    } else if (!state.child) {
      await startPanel()
    }
  }

  // 注意：热装配时 'ready' 事件可能已错过，因此启动逻辑在 apply 内直接执行。
  state.route = currentRoute()
  startPanel().catch((e) => warn('面板启动异常:', String(e && e.message || e)))
  registerRoutes()
  try {
    ctx.setInterval(tick, TICK_MS)
  } catch (e) {
    warn('timer 服务不可用，轮询未启动:', String(e && e.message || e))
  }

  ctx.on('dispose', () => {
    state.stopped = true
    try {
      if (process.env.BILI_KEEP_ALIVE === '1') {
        log('DSH 退出（子进程保活模式 BILI_KEEP_ALIVE=1，不杀面板）')
        return
      }
      log('DSH 退出，停止面板子进程')
      stopPanel()
    } catch { /* ignore */ }
    for (const d of disposers) { try { d() } catch { /* ignore */ } }
  })

  log('[diag]', 'settings=', !!getSettings(), 'llm=', !!getLlm(), 'webServer=', !!getWs(), 'route=', JSON.stringify(currentRoute()), '；代理端点 =', `${V1}/chat/completions`)
}