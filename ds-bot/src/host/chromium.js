// A plain Chromium the Bot drives, no companion app needed. chromium_open launches a
// browser through puppeteer-core: a system Chrome/Edge/Chromium when one is installed,
// else a Chrome for Testing build downloaded on the spot into <home>/chromium/browser
// (@puppeteer/browsers). Every session keeps a persistent profile directory under
// <home>/chromium/profiles/<bot>/<name>, so its logins and cookies survive restarts.
// Driving shares the *_browse actions with gemlogin.js through browse.js — see
// docs/plans/2026-10-19-chromium.md. `config.chromium`: false turns the tools off; a
// string or { executablePath } forces the binary; { args } adds launch flags.
// `launch`, `probe` and `download` are test seams.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'
import { Browser, detectBrowserPlatform, getInstalledBrowsers, install as installBrowser, resolveBuildId } from '@puppeteer/browsers'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from './tools.js'
import { HIDDEN_POS, createPageDriver, fail, pageSize, pickPage, registerBrowseTool, setWindowShown } from './browse.js'

const NAME_MAX = 40
const CHROME_TAG = 'stable'

/**
 * An installed browser to drive, or undefined. Windows and macOS get the usual
 * install spots; elsewhere the PATH is scanned for the usual binary names.
 * Chrome first, then Edge, then a bare Chromium, then Brave.
 */
export function systemChrome({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  const candidates = []
  if (platform === 'win32') {
    const dirs = [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.PROGRAMW6432].filter(Boolean)
    for (const dir of dirs) {
      candidates.push(
        join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(dir, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(dir, 'Chromium', 'Application', 'chrome.exe'),
        join(dir, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      )
    }
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    )
  } else {
    for (const dir of String(env.PATH ?? '').split(':').filter(Boolean)) {
      for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']) {
        candidates.push(join(dir, name))
      }
    }
  }
  return candidates.find(candidate => exists(candidate))
}

const realDownload = {
  platform: () => detectBrowserPlatform(),
  resolveBuildId: (platform, tag) => resolveBuildId(Browser.CHROME, platform, tag),
  installed: cacheDir => getInstalledBrowsers({ cacheDir }),
  install: options => installBrowser(options),
}

/**
 * The binary to launch: the configured path, else a system browser, else a Chrome
 * for Testing build in the cache dir — downloaded there when none exists yet.
 * @returns {Promise<{executablePath:string, source:'configured'|'system'|'cached'|'downloaded', buildId?:string}>}
 */
export async function ensureChromium({ home, configured, probe = systemChrome, download = realDownload }) {
  if (typeof configured === 'string' && configured.trim() !== '') {
    if (!existsSync(configured)) throw new Error(`config.chromium points at ${configured}, which does not exist`)
    return { executablePath: configured, source: 'configured' }
  }
  const found = probe()
  if (found !== undefined) return { executablePath: found, source: 'system' }
  const cacheDir = join(home, 'chromium', 'browser')
  const have = await download.installed(cacheDir).catch(() => [])
  if (have.length > 0) {
    const latest = have.reduce((a, b) => a.buildId.localeCompare(b.buildId, undefined, { numeric: true }) >= 0 ? a : b)
    return { executablePath: latest.executablePath, source: 'cached', buildId: latest.buildId }
  }
  const buildId = await download.resolveBuildId(download.platform(), CHROME_TAG)
    .catch((error) => { throw new Error(`No browser was found on this machine and the Chrome for Testing version list could not be read: ${fail(error)}`) })
  const installed = await download.install({ browser: Browser.CHROME, buildId, cacheDir })
    .catch((error) => { throw new Error(`No browser was found on this machine and downloading Chrome for Testing ${buildId} failed: ${fail(error)}`) })
  return { executablePath: installed.executablePath, source: 'downloaded', buildId }
}

const cleanName = (value) => {
  const name = String(value ?? 'default').replace(/\s+/g, '-').replace(/[^\w.-]+/g, '').slice(0, NAME_MAX)
  if (name === '') throw new Error('Name the session with letters, digits, ".", "_" or "-".')
  return name
}

/**
 * Named headless-or-headed browsers, one launch per `owner/name`. Unlike the
 * GemLogin sessions these own their processes: close kills the browser, and a lost
 * connection relaunches it (the profile dir keeps cookies and logins).
 */
export function createChromiumSessions({ launch = options => puppeteer.launch(options) } = {}) {
  /** @type {Map<string, any>} keyed by `owner/name` */
  const sessions = new Map()
  /** @type {Map<string, Promise<any>} opens in flight, so two calls launch once */
  const pending = new Map()

  const attach = async (session) => {
    // Off-screen before minimize: the window never flashes on-screen where the
    // window manager honors the position; where it does not, minimize lands first.
    const args = [...session.extraArgs]
    if (session.hidden === true && session.headless !== true) args.unshift(`--window-position=${HIDDEN_POS}`)
    session.browser = await launch({
      executablePath: session.executablePath,
      headless: session.headless === true,
      userDataDir: session.userDataDir,
      // Puppeteer's default viewport is an 800x600 emulation; a headed window
      // follows its real size instead, while headless keeps a steady one.
      defaultViewport: session.headless === true ? { width: 1280, height: 800 } : null,
      args,
    })
    session.page = undefined
    const page = await pickPage(session)
    if (session.hidden === true && session.headless !== true) await setWindowShown(session, page, false).catch(() => {})
  }

  function open(owner, name, options) {
    const key = `${owner}/${name}`
    const existing = sessions.get(key)
    if (existing !== undefined) return Promise.resolve(existing)
    const inflight = pending.get(key)
    if (inflight !== undefined) return inflight
    const session = {
      id: key, name, owner,
      browser: undefined, page: undefined, reads: 0,
      headless: options.headless === true,
      hidden: options.headless === true ? false : options.hidden !== false,
      executablePath: options.executablePath,
      extraArgs: options.args ?? [],
      userDataDir: options.userDataDir,
    }
    const job = attach(session)
      .then(() => { sessions.set(key, session); return session })
      .finally(() => pending.delete(key))
    pending.set(key, job)
    return job
  }

  /**
   * The session `ref` names for `botId`: a name of theirs, or `owner/name` of any
   * session for a Main Bot. Without ref: their only session, else guidance.
   */
  function pick(ref, botId, isMain) {
    const mine = [...sessions.values()].filter(session => session.owner === botId)
    const raw = String(ref ?? '').trim()
    if (raw !== '') {
      const pool = isMain ? [...sessions.values()] : mine
      const hit = pool.find(session => session.name === raw || session.id === raw)
      if (hit === undefined) throw new Error(`No Chromium session "${raw}"${isMain ? '' : ' of yours'}${mine.length > 0 ? ` — yours: ${mine.map(session => session.name).join(', ')}` : ''}.`)
      return hit
    }
    if (mine.length === 0) throw new Error('You have no Chromium browser open. Open one with chromium_open.')
    if (mine.length > 1) throw new Error(`${mine.length} Chromium sessions are open (${mine.map(session => session.name).join(', ')}); say which in session.`)
    return mine[0]
  }

  const relaunch = async (session) => {
    // close() over CDP can wait forever on a dead transport; drop it and make sure
    // the process is gone instead.
    try { session.browser?.disconnect?.() } catch { /* already gone */ }
    try { session.browser?.process?.()?.kill?.() } catch { /* already gone */ }
    await attach(session)
    return pickPage(session)
  }

  // The driven tab, relaunching the browser when its process went away. The
  // connected flag trails the real death (it flips on a disconnect event), so a
  // browser that still looks connected is probed with a live CDP call.
  async function pageOf(session) {
    const browser = session.browser
    const looksDead = browser === undefined || browser.connected === false
      || (typeof browser.isConnected === 'function' && !browser.isConnected())
      || browser.process?.()?.killed === true || browser.process?.()?.exitCode != null
    if (looksDead) return relaunch(session)
    try {
      await browser.version()
      const page = await pickPage(session)
      // A crashed tab can leave a page object that only looks open; this proves it.
      await page.evaluate(() => 1)
      return page
    } catch (error) {
      if (!/target closed|session closed|connection closed/i.test(String(error?.message))) throw error
      return relaunch(session)
    }
  }

  // browser.close() over a half-dead transport can wait forever; bound it, then
  // fall back to killing the process we own.
  const stopBrowser = browser => Promise.race([
    browser?.close(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('close timed out')), 5000)),
  ]).catch(() => { try { browser?.process?.()?.kill?.() } catch { /* already gone */ } })

  async function close(id) {
    const session = sessions.get(String(id))
    sessions.delete(String(id))
    if (session === undefined) return false
    await stopBrowser(session.browser)
    return true
  }

  async function dispose() {
    const inflight = [...pending.values()]
    const all = new Map(sessions)
    sessions.clear()
    // Opens that finish during the wait are closed too, not orphaned.
    await Promise.allSettled(inflight)
    for (const [key, session] of sessions) all.set(key, session)
    sessions.clear()
    return Promise.allSettled([...all.values()].map(session => Promise.resolve().then(() => stopBrowser(session.browser))))
  }

  return { open, pick, get: id => sessions.get(String(id)), list: () => [...sessions.values()], pageOf, close, dispose }
}

const splitArgs = raw => String(raw ?? '').trim().split(/\s+/).filter(Boolean)

export function install(rt) {
  const { ctx, config } = rt
  const raw = config.chromium
  if (raw === false) return
  const option = typeof raw === 'string' ? { executablePath: raw } : raw !== null && typeof raw === 'object' ? raw : {}
  const sessions = createChromiumSessions({ launch: option.launch })
  ctx.effect(() => () => sessions.dispose(), 'ds-bot: chromium sessions')
  const driver = createPageDriver({ sessions, shotsDir: join(rt.home, 'chromium', 'shots') })

  // Resolved once and kept: a download takes minutes, not something to redo per open.
  // A failed attempt is not kept — the next open tries again.
  let resolved
  const resolve = async () => resolved ??= await ensureChromium({
    home: rt.home,
    configured: option.executablePath,
    probe: option.probe,
    download: option.download,
  })

  const caller = (exec) => {
    const id = rt.selfOf(exec.agent?.id)
    return rt.botOf(id) !== undefined ? id : undefined
  }
  const owns = (session, botId) => session.owner === botId || rt.isMain(botId)
  const ownerName = session => rt.botOf(session.owner)?.name ?? 'another Bot'

  ctx.tools.register(defineTool({
    name: 'chromium_open',
    description: 'Open a Chromium browser you fully control, for chromium_browse to drive. A Chrome, Edge or Chromium already on this computer is used; when there is none, a Chrome for Testing build is downloaded first (once, kept for later opens). Each session name has its own lasting profile — same name keeps the same cookies and logins across restarts. By default the window is minimized at once — hidden on the taskbar but a real headed browser that keeps running; hidden:false shows it, headless:true runs it with no window at all, and chromium_browse action show brings a headed window on-screen later.',
    parameters: {
      name: { type: 'string', description: `A name for this session and its lasting profile — up to ${NAME_MAX} letters, digits, ".", "_" or "-"; default "default"` },
      hidden: { type: 'boolean', description: 'Minimize the window right away so the user is not disturbed; default true (ignored with headless)' },
      headless: { type: 'boolean', description: 'Run without a window entirely — nothing to show the user later; default false' },
      args: { type: 'string', description: 'Extra browser launch arguments, separated by spaces (e.g. a --proxy-server=… flag)' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const botId = caller(exec)
      if (botId === undefined) return 'Only Bots on the team can drive a Chromium browser.'
      try {
        const name = cleanName(args.name)
        const existing = sessions.get(`${botId}/${name}`)
        if (existing !== undefined) {
          const page = await sessions.pageOf(existing)
          if (args.hidden === false && existing.hidden && !existing.headless) await setWindowShown(existing, page, true).catch(() => {})
          return `Chromium session "${existing.name}" is already open${existing.headless ? ' (headless)' : ''}. Current page: ${await page.title()} — ${page.url()}`
        }
        const binary = await resolve()
        const session = await sessions.open(botId, name, {
          executablePath: binary.executablePath,
          headless: args.headless === true,
          hidden: args.hidden !== false,
          args: [...(Array.isArray(option.args) ? option.args : splitArgs(option.args)), ...splitArgs(args.args)],
          userDataDir: join(rt.home, 'chromium', 'profiles', botId, name),
        })
        const page = await sessions.pageOf(session)
        const where = { configured: 'the configured browser', system: 'the system browser', cached: 'the downloaded Chrome for Testing', downloaded: `a Chrome for Testing ${binary.buildId} downloaded just now` }[binary.source]
        return `Chromium session "${session.name}" is open on ${where}${session.headless ? ', headless' : session.hidden ? ', hidden on the taskbar' : ''}. Current page: ${await page.title()} — ${page.url()}\nDrive it with chromium_browse; other Bots cannot touch it while it is yours.`
      } catch (error) { return fail(error) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'chromium_close',
    description: 'Close a Chromium session\'s browser and end it. Without session, closes every Chromium browser you opened.',
    parameters: {
      session: { type: 'string', description: 'Session name as opened; omit to close all of yours' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const botId = caller(exec)
      if (botId === undefined) return 'Only Bots on the team can drive a Chromium browser.'
      try {
        if (String(args.session ?? '').trim() !== '') {
          const session = sessions.pick(args.session, botId, rt.isMain(botId))
          if (!owns(session, botId)) return `"${session.name}" was opened by ${ownerName(session)}; you cannot close it.`
          await sessions.close(session.id)
          return `Closed "${session.name}". Its profile stays, so its logins are there next time.`
        }
        const mine = sessions.list().filter(session => owns(session, botId))
        if (mine.length === 0) return 'You have no Chromium browser open.'
        for (const session of mine) await sessions.close(session.id)
        return `Closed ${mine.length}: ${mine.map(session => `"${session.name}"`).join(', ')}.`
      } catch (error) { return fail(error) }
    },
  }))

  registerBrowseTool(rt, {
    name: 'chromium_browse',
    thing: 'an open Chromium session',
    pickParam: 'session',
    pickText: 'Session name as opened; needed only when more than one is open — a Main Bot addresses another Bot\'s as owner/name',
    pick: (args, botId) => sessions.pick(args.session, botId, rt.isMain(botId)),
    owns,
    ownerName,
    driver,
    caller,
    denied: 'Only Bots on the team can drive a Chromium browser.',
  })

  // The client's view of the sessions a Bot owns — same shape as the GemLogin cards.
  const chromiumList = async (botId) => Promise.all(sessions.list().filter(session => session.owner === botId).map(async (session) => {
    let title = '', url = ''
    try {
      const page = await sessions.pageOf(session)
      url = page.url()
      title = await page.title()
      if (session.headless !== true) {
        const cdp = await page.createCDPSession()
        const { bounds } = await cdp.send('Browser.getWindowForTarget')
        if (bounds !== undefined) session.hidden = bounds.windowState === 'minimized' || (bounds.left ?? 0) < -30000
      }
    } catch { /* the window just went away */ }
    return { id: session.id, name: session.name, hidden: session.hidden === true, headless: session.headless === true, title, url }
  }))

  const chromiumShot = async (botId, id) => {
    const session = sessions.get(id)
    if (session === undefined || session.owner !== botId) return { image: null }
    try {
      const page = await sessions.pageOf(session)
      const image = await page.screenshot({ type: 'jpeg', quality: 60 })
      const { width, height } = await pageSize(page)
      return { image: `data:image/jpeg;base64,${image.toString('base64')}`, title: await page.title(), url: page.url(), hidden: session.hidden === true, width, height }
    } catch { return { image: null } }
  }

  const chromiumClick = async (botId, id, fx, fy) => {
    const session = sessions.get(id)
    if (session === undefined || session.owner !== botId || typeof fx !== 'number' || typeof fy !== 'number') return { ok: false }
    const page = await sessions.pageOf(session)
    const { width = 1280, height = 800 } = await pageSize(page)
    await page.mouse.click(Math.round(fx * width), Math.round(fy * height))
    return { ok: true }
  }

  const chromiumShow = async (botId, id, shown) => {
    const session = sessions.get(id)
    if (session === undefined || session.owner !== botId || session.headless === true) return { ok: false }
    const page = await sessions.pageOf(session)
    await setWindowShown(session, page, shown === true)
    return { ok: true, hidden: session.hidden === true }
  }

  Object.assign(rt, { chromiumList, chromiumShot, chromiumShow, chromiumClick })
}
