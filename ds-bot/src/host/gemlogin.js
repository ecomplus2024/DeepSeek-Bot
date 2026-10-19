// GemLogin browsers, driven by the Bot. gemlogin_open starts a profile through the
// GemLogin app's local API and attaches puppeteer-core to the debug address it returns;
// gemlogin_browse then works the real, fingerprinted browser. Unlike the Bot browser
// panel (browser.js), which the user steers and a Bot only reads, this browser answers
// to the Bot — see docs/plans/2026-10-18-gemlogin.md. `config.gemlogin`: false turns
// the tools off; a string or { url } points at a GemLogin app elsewhere; the default is
// the app on this computer at http://localhost:1010. `fetch` and `connect` are test
// seams. The driving actions themselves live in browse.js, shared with chromium.js.
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from './tools.js'
import { HIDDEN_POS, createPageDriver, fail, pickPage, registerBrowseTool, setWindowShown } from './browse.js'

export { extractPage, setWindowShown } from './browse.js'

const DEFAULT_BASE = 'http://localhost:1010'
const API_TIMEOUT_MS = 15_000
// Starting a profile launches a whole browser; the app can answer slowly.
const START_TIMEOUT_MS = 90_000
const PER_PAGE = 100
const PAGES_MAX = 10

const maskProxy = raw => String(raw).replace(/([^@:/]+):([^@:/]+)@/, '***:***@')

export function createGemApi({ base = DEFAULT_BASE, fetch: request = fetch } = {}) {
  const root = String(base).replace(/\/+$/, '')
  const call = async (path, params, ms = API_TIMEOUT_MS) => {
    const query = params === undefined ? '' : `?${new URLSearchParams(params)}`
    let response
    try {
      response = await request(`${root}${path}${query}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(ms) })
    } catch (error) {
      throw new Error(error?.name === 'TimeoutError' ? `GemLogin at ${root} did not answer in time` : `GemLogin is not reachable at ${root}. Open the GemLogin app and try again.`)
    }
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(`GemLogin at ${root} answered ${response.status}`)
    if (body?.success === false) throw new Error(String(body.message ?? 'GemLogin refused the request'))
    return body?.data !== undefined && body.data !== null ? body.data : body
  }
  return {
    base: root,
    groups: () => call('/api/groups'),
    profiles: params => call('/api/profiles', params),
    profile: id => call(`/api/profile/${id}`),
    // addination_args is the app's own parameter name.
    start: (id, { args, winPos, winSize, winScale } = {}) => call(`/api/profiles/start/${id}`, {
      ...(args ? { addination_args: args } : {}),
      ...(winPos ? { win_pos: winPos } : {}),
      ...(winSize ? { win_size: winSize } : {}),
      ...(winScale ? { win_scale: winScale } : {}),
    }, START_TIMEOUT_MS),
    close: id => call(`/api/profiles/close/${id}`),
  }
}

// A profile is named by id or by its exact name; ids come back as numbers on older
// apps and 24-hex strings on newer ones, so they are kept as strings throughout.
export async function findProfile(api, ref) {
  const raw = String(ref ?? '').trim()
  if (raw === '') throw new Error('Say which profile: its id or its exact name from gemlogin_profiles')
  if (/^\d+$/.test(raw) || /^[\da-f]{24}$/i.test(raw)) {
    const profile = await api.profile(raw).catch((error) => {
      if (/not reachable|did not answer|answered \d+/.test(error.message)) throw error
      return undefined
    })
    if (profile?.id !== undefined) return { id: String(profile.id), name: String(profile.name ?? raw) }
    throw new Error(`GemLogin has no profile #${raw}`)
  }
  for (let page = 1; page <= PAGES_MAX; page++) {
    const rows = await api.profiles({ page, per_page: PER_PAGE })
    const found = Array.isArray(rows) ? rows.find(row => String(row.id) === raw || row.name === raw) : undefined
    if (found !== undefined) return { id: String(found.id), name: String(found.name) }
    if (!Array.isArray(rows) || rows.length < PER_PAGE) break
  }
  throw new Error(`No GemLogin profile named "${raw}"`)
}

export function createGemSessions({ api, connect = options => puppeteer.connect(options) } = {}) {
  /** @type {Map<number, {id:number, name:string, owner:string|undefined, browser:any, page:any, reads:number, addr:string, refTag?:string}>} */
  const sessions = new Map()

  const attach = async (profile, owner, options) => {
    // The app refuses a second start with "Profile is currently being opened" while
    // a launch is in flight — that state clears on its own, so wait and retry.
    let started
    for (let attempt = 0; ; attempt++) {
      try {
        started = await api.start(profile.id, options)
        break
      } catch (error) {
        if (!/being opened/i.test(String(error?.message)) || attempt >= 5) throw error
        await new Promise(resolve => setTimeout(resolve, 3000))
      }
    }
    const addr = started?.remote_debugging_address
    if (typeof addr !== 'string' || addr === '') throw new Error(`GemLogin started profile #${profile.id} but returned no debug address`)
    const browser = await connect({ browserURL: /^https?:/.test(addr) ? addr : `http://${addr}` })
    const session = { id: String(profile.id), name: profile.name, owner, browser, page: undefined, reads: 0, addr }
    await pickPage(session)
    return session
  }

  async function open(owner, profile, options = {}) {
    const id = String(profile.id)
    const existing = sessions.get(id)
    if (existing !== undefined) return existing
    const session = await attach(profile, owner, options)
    sessions.set(id, session)
    return session
  }

  function pick(ref) {
    const raw = String(ref ?? '').trim()
    if (raw !== '') {
      const hit = [...sessions.values()].find(session => String(session.id) === raw || session.name === raw)
      if (hit === undefined) throw new Error(`No open GemLogin browser for "${raw}". Open it with gemlogin_open first.`)
      return hit
    }
    if (sessions.size === 0) throw new Error('No GemLogin browser is open. List profiles with gemlogin_profiles, open one with gemlogin_open.')
    if (sessions.size > 1) throw new Error(`${sessions.size} GemLogin browsers are open (${[...sessions.values()].map(session => session.name).join(', ')}); say which profile.`)
    return [...sessions.values()][0]
  }

  // The driven tab, reattaching to the profile when its window was closed and reopened.
  async function pageOf(session) {
    if (session.browser?.connected === false || (typeof session.browser?.isConnected === 'function' && !session.browser.isConnected())) {
      try { await session.browser.disconnect() } catch { /* already gone */ }
      const fresh = await attach(session, session.owner)
      session.browser = fresh.browser
      session.page = fresh.page
      session.addr = fresh.addr
      if (session.hidden === true) await setWindowShown(session, session.page, false).catch(() => {})
    }
    return pickPage(session)
  }

  async function close(id) {
    const session = sessions.get(String(id))
    sessions.delete(String(id))
    if (session === undefined) return false
    try { await session.browser.disconnect() } catch { /* already gone */ }
    await api.close(id).catch(() => {})
    return true
  }

  function dispose() {
    const all = [...sessions.values()]
    sessions.clear()
    return Promise.allSettled(all.map(session => Promise.resolve().then(() => session.browser.disconnect())))
  }

  return { open, pick, get: id => sessions.get(String(id)), list: () => [...sessions.values()], pageOf, close, dispose }
}

export function install(rt) {
  const { ctx, config } = rt
  const raw = config.gemlogin
  if (raw === false) return
  const option = typeof raw === 'string' ? { url: raw } : raw !== null && typeof raw === 'object' ? raw : {}
  const api = createGemApi({ base: option.url, fetch: option.fetch })
  const sessions = createGemSessions({ api, connect: option.connect })
  ctx.effect(() => () => sessions.dispose(), 'ds-bot: gemlogin sessions')
  const driver = createPageDriver({ sessions, shotsDir: join(rt.home, 'gemlogin', 'shots') })

  const caller = (exec) => {
    const id = rt.selfOf(exec.agent?.id)
    return rt.botOf(id) !== undefined ? id : undefined
  }
  const owns = (session, botId) => session.owner === botId || rt.isMain(botId)
  const ownerName = session => rt.botOf(session.owner)?.name ?? 'another Bot'

  ctx.tools.register(defineTool({
    name: 'gemlogin_profiles',
    description: 'List the browser profiles in the GemLogin app on this computer: id, name, group and proxy of each, and which are open. Give a profile id or its exact name to gemlogin_open.',
    parameters: {
      group: { type: 'string', description: 'List only this group, by name or id' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      if (caller(exec) === undefined) return 'Only Bots on the team can use GemLogin.'
      try {
        const groups = new Map((await api.groups().catch(() => [])).map(group => [String(group.id), String(group.name)]))
        const profiles = []
        for (let page = 1; page <= PAGES_MAX; page++) {
          const rows = await api.profiles({ page, per_page: PER_PAGE, sort: 2 })
          if (!Array.isArray(rows)) break
          profiles.push(...rows)
          if (rows.length < PER_PAGE) break
        }
        const wanted = String(args.group ?? '').trim().toLowerCase()
        const shown = profiles.filter(profile => wanted === '' || String(profile.group_id ?? '') === wanted || groups.get(String(profile.group_id))?.toLowerCase() === wanted)
        const open = new Map(sessions.list().map(session => [session.id, session]))
        const line = profile => [
          `- #${profile.id} ${String(profile.name ?? '')}`,
          profile.browser_version ? `browser ${profile.browser_version}` : '',
          groups.get(String(profile.group_id)) ?? '',
          profile.raw_proxy ? `proxy ${maskProxy(profile.raw_proxy)}` : '',
          open.has(String(profile.id)) ? `open (${ownerName(open.get(String(profile.id)))})` : '',
        ].filter(Boolean).join(', ')
        return [`GemLogin at ${api.base}: ${shown.length} profile${shown.length === 1 ? '' : 's'}${wanted ? ` in "${args.group}"` : ''}.`, ...shown.map(line)].join('\n')
      } catch (error) { return fail(error) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'gemlogin_open',
    description: 'Open a GemLogin profile\'s browser and attach to it so gemlogin_browse can drive it. The profile keeps its own proxy, fingerprint and cookies; an already-open profile is reattached to instead of started again. By default the window is minimized at once — hidden on the taskbar, but a real headed browser that keeps the profile\'s fingerprint and keeps running; hidden:false opens it visibly, and gemlogin_browse action show brings it on-screen later.',
    parameters: {
      profile: { type: 'string', required: true, description: 'Profile id or exact name from gemlogin_profiles' },
      hidden: { type: 'boolean', description: 'Minimize the window right away so the user is not disturbed; default true' },
      args: { type: 'string', description: 'Extra browser start arguments, separated by spaces' },
      win_pos: { type: 'string', description: 'Window position as x,y; overrides hidden' },
      win_size: { type: 'string', description: 'Window size as width,height' },
      win_scale: { type: 'string', description: 'Window scale factor' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const botId = caller(exec)
      if (botId === undefined) return 'Only Bots on the team can use GemLogin.'
      try {
        const profile = await findProfile(api, args.profile)
        const existing = sessions.get(profile.id)
        if (existing !== undefined && !owns(existing, botId)) return `"${existing.name}" is already driven by ${ownerName(existing)}.`
        const winPos = args.win_pos ?? (args.hidden === false ? undefined : HIDDEN_POS)
        // win_pos is only a hint the app may drop (e.g. when the profile restores a
        // maximized window); handing Chrome the same position shrinks the time the
        // window is visible before we can minimize it.
        const extraArgs = winPos === HIDDEN_POS ? [args.args, `--window-position=${HIDDEN_POS}`].filter(Boolean).join(' ') : args.args
        const session = await sessions.open(botId, profile, { args: extraArgs, winPos, winSize: args.win_size, winScale: args.win_scale })
        const page = await sessions.pageOf(session)
        if (session.hidden === undefined) {
          session.hidden = winPos === HIDDEN_POS
          // win_pos only asks the app, which may ignore it or reopen an already-running
          // profile where it last sat; minimize it again through CDP so hidden really
          // means hidden (this also records the bounds the first show restores).
          if (session.hidden) await setWindowShown(session, page, false).catch(() => {})
        } else if (args.hidden === false && session.hidden) {
          await setWindowShown(session, page, true).catch(() => {})
        }
        return `Profile "${session.name}" (#${session.id}) is open; its browser answers on ${session.addr}. Current page: ${await page.title()} — ${page.url()}\nDrive it with gemlogin_browse; other Bots cannot touch it while it is yours.`
      } catch (error) { return fail(error) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'gemlogin_close',
    description: 'Close a GemLogin profile\'s browser window and detach from it. Without profile, closes every GemLogin browser you opened.',
    parameters: {
      profile: { type: 'string', description: 'Profile id or exact name; omit to close all of yours' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const botId = caller(exec)
      if (botId === undefined) return 'Only Bots on the team can use GemLogin.'
      try {
        if (String(args.profile ?? '').trim() !== '') {
          const session = sessions.pick(args.profile)
          if (!owns(session, botId)) return `"${session.name}" was opened by ${ownerName(session)}; you cannot close it.`
          await sessions.close(session.id)
          return `Closed "${session.name}" (#${session.id}).`
        }
        const mine = sessions.list().filter(session => owns(session, botId))
        if (mine.length === 0) return 'You have no GemLogin browser open.'
        for (const session of mine) await sessions.close(session.id)
        return `Closed ${mine.length}: ${mine.map(session => `"${session.name}"`).join(', ')}.`
      } catch (error) { return fail(error) }
    },
  }))

  registerBrowseTool(rt, {
    name: 'gemlogin_browse',
    thing: 'an open GemLogin profile browser',
    pickParam: 'profile',
    pickText: 'Profile id or name; needed only when more than one GemLogin browser is open',
    pick: args => sessions.pick(args.profile),
    owns,
    ownerName,
    driver,
    caller,
    denied: 'Only Bots on the team can use GemLogin.',
  })

  // The client's view of the sessions a Bot owns, with a live JPEG screenshot and a
  // window show/hide control — the details panel polls these while it is open.
  const gemLoginList = async (botId) => Promise.all(sessions.list().filter(session => session.owner === botId).map(async (session) => {
    let title = '', url = ''
    try {
      const page = await sessions.pageOf(session)
      url = page.url()
      title = await page.title()
      // The real window state, not our flag: the user may restore it from the taskbar.
      const cdp = await page.createCDPSession()
      const { bounds } = await cdp.send('Browser.getWindowForTarget')
      if (bounds !== undefined) session.hidden = bounds.windowState === 'minimized' || (bounds.left ?? 0) < -30000
    } catch { /* the window just went away */ }
    return { profileId: session.id, name: session.name, hidden: session.hidden === true, title, url }
  }))

  const gemLoginShot = async (botId, profileId) => {
    const session = sessions.get(profileId)
    if (session === undefined || session.owner !== botId) return { image: null }
    try {
      const page = await sessions.pageOf(session)
      const image = await page.screenshot({ type: 'jpeg', quality: 60 })
      const viewport = page.viewport() ?? {}
      return { image: `data:image/jpeg;base64,${image.toString('base64')}`, title: await page.title(), url: page.url(), hidden: session.hidden === true, width: viewport.width, height: viewport.height }
    } catch { return { image: null } }
  }

  // A click on the preview: the client sends the spot as fractions of the picture,
  // the page clicks at the matching pixel of its viewport.
  const gemLoginClick = async (botId, profileId, fx, fy) => {
    const session = sessions.get(profileId)
    if (session === undefined || session.owner !== botId || typeof fx !== 'number' || typeof fy !== 'number') return { ok: false }
    const page = await sessions.pageOf(session)
    const { width = 1280, height = 800 } = page.viewport() ?? {}
    await page.mouse.click(Math.round(fx * width), Math.round(fy * height))
    return { ok: true }
  }

  const gemLoginShow = async (botId, profileId, shown) => {
    const session = sessions.get(profileId)
    if (session === undefined || session.owner !== botId) return { ok: false }
    const page = await sessions.pageOf(session)
    await setWindowShown(session, page, shown === true)
    return { ok: true, hidden: session.hidden === true }
  }

  Object.assign(rt, { gemLoginList, gemLoginShot, gemLoginShow, gemLoginClick })
}
