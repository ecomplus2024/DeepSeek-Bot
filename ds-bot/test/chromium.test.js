import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { createChromiumSessions, ensureChromium, systemChrome } from '../src/host/chromium.js'
import { fakeContext } from './fake-ctx.js'
import { fakeBrowser } from './fake-browser.js'

const TEAM = {
  version: 1,
  mainBotId: 'm1',
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: 'Writer', instructions: '', createdAt: 2 },
    b3: { id: 'b3', sessionId: 'b3', name: 'Coder', role: 'Coder', instructions: '', createdAt: 3 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

// The download seam: counts installs, never touches the network, reports a fixed
// cached build when asked to.
function fakeDownload({ cached = [] } = {}) {
  const calls = { resolveBuildId: 0, install: 0, installed: 0 }
  return {
    calls,
    platform: () => 'win64',
    resolveBuildId: async () => { calls.resolveBuildId++; return '141.0.0' },
    installed: async () => { calls.installed++; return cached },
    install: async (options) => { calls.install++; return { executablePath: 'C:/cache/chrome/chrome.exe', buildId: options.buildId } },
  }
}

function start({ config = {}, browser, probe = () => undefined, download = fakeDownload(), launches = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-chromium-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext({})
  const launch = async (options) => { launches.push(options); return browser ?? fakeBrowser() }
  const rt = createRuntime(ctx, { home, chromium: { launch, probe, download }, ...config })
  const stop = async () => {
    await ctx.dispose()
    try { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) } catch { /* a late home write keeps the dir */ }
  }
  const tool = (name, args, agent) => ctx.registeredTools.get(name).execute(args, { agent: { id: agent } })
  return { ctx, rt, tool, stop, launches }
}

test('systemChrome finds the usual install spots per platform', () => {
  const win = systemChrome({ platform: 'win32', env: { PROGRAMFILES: 'C:/Program Files' }, exists: p => p.endsWith('msedge.exe') })
  assert.match(win, /Microsoft[/\\]Edge[/\\]Application[/\\]msedge\.exe$/)
  const mac = systemChrome({ platform: 'darwin', env: {}, exists: p => p === '/Applications/Chromium.app/Contents/MacOS/Chromium' })
  assert.equal(mac, '/Applications/Chromium.app/Contents/MacOS/Chromium')
  const linux = systemChrome({ platform: 'linux', env: { PATH: '/usr/bin:/usr/local/bin' }, exists: p => p.replaceAll('\\', '/') === '/usr/bin/chromium' })
  assert.match(linux.replaceAll('\\', '/'), /^\/usr\/bin\/chromium$/)
  assert.equal(systemChrome({ platform: 'win32', env: {}, exists: () => false }), undefined)
})

test('ensureChromium prefers configured, then system, then cache, then download', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-ensure-'))
  try {
    await assert.rejects(ensureChromium({ home, configured: join(home, 'nope.exe'), probe: () => undefined }), /does not exist/)
    const real = join(home, 'real-chrome.exe')
    writeFileSync(real, 'x')
    assert.deepEqual(await ensureChromium({ home, configured: real, probe: () => 'C:/sys/chrome.exe' }), { executablePath: real, source: 'configured' })
    assert.deepEqual(await ensureChromium({ home, probe: () => 'C:/sys/chrome.exe' }), { executablePath: 'C:/sys/chrome.exe', source: 'system' })
    const cached = fakeDownload({ cached: [{ executablePath: 'C:/cache/old/chrome.exe', buildId: '139.0.0' }, { executablePath: 'C:/cache/new/chrome.exe', buildId: '141.0.0' }] })
    assert.deepEqual(await ensureChromium({ home, probe: () => undefined, download: cached }), { executablePath: 'C:/cache/new/chrome.exe', source: 'cached', buildId: '141.0.0' })
    assert.equal(cached.calls.install, 0)
    const download = fakeDownload()
    assert.deepEqual(await ensureChromium({ home, probe: () => undefined, download }), { executablePath: 'C:/cache/chrome/chrome.exe', source: 'downloaded', buildId: '141.0.0' })
    assert.equal(download.calls.install, 1)
    const broken = { platform: () => 'win64', resolveBuildId: async () => { throw new Error('offline') }, installed: async () => [], install: async () => ({}) }
    await assert.rejects(ensureChromium({ home, probe: () => undefined, download: broken }), /version list could not be read: offline/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a Bot opens a downloaded Chromium and drives it', async (t) => {
  const browser = fakeBrowser()
  const download = fakeDownload()
  const launches = []
  const { ctx, tool, stop } = start({ browser, download, launches })
  t.after(stop)
  for (const name of ['chromium_open', 'chromium_close', 'chromium_browse']) assert.ok(ctx.registeredTools.has(name), name)

  const opened = await tool('chromium_open', {}, 'b2')
  assert.match(opened, /Chromium session "default" is open on a Chrome for Testing 141\.0\.0 downloaded just now, hidden on the taskbar/)
  assert.equal(download.calls.install, 1)
  assert.equal(launches.length, 1)
  assert.equal(launches[0].executablePath, 'C:/cache/chrome/chrome.exe')
  assert.equal(launches[0].headless, false)
  assert.match(launches[0].userDataDir.replaceAll('\\', '/'), /chromium\/profiles\/b2\/default$/)
  // hidden: the launch arg parks the window off-screen and the CDP call minimizes it.
  assert.ok(launches[0].args.includes('--window-position=-32000,-32000'))
  assert.deepEqual(browser._pages[0].cdpCalls.findLast(call => call[0] === 'Browser.setWindowBounds')?.[1]?.bounds?.windowState, 'minimized')

  // A second open reattaches — no new download, no new launch.
  assert.match(await tool('chromium_open', {}, 'b2'), /already open/)
  assert.equal(launches.length, 1)
  assert.equal(download.calls.install, 1)

  assert.match(await tool('chromium_browse', { action: 'read' }, 'b2'), /page body/)
  assert.match(await tool('chromium_browse', { action: 'click', ref: 1 }, 'b2'), /Clicked \[1\]/)
  assert.match(await tool('chromium_browse', { action: 'navigate', url: 'https://a.example/' }, 'b2'), /https:\/\/a\.example\/ — Fake title/)
  const steps = await tool('chromium_browse', { action: 'steps', steps: [
    { action: 'click', selector: '.conv' },
    { action: 'type', selector: '.composer', text: 'Chào anh' },
    { action: 'press', key: 'Enter' },
  ] }, 'b2')
  assert.match(steps, /^Ran 3 steps/)
  assert.deepEqual(browser._pages[0].typed, [['.composer', 'Chào anh']])

  // Other Bots cannot even name it; the Main Bot reaches it as owner/name.
  assert.match(await tool('chromium_browse', { action: 'read', session: 'default' }, 'b3'), /No Chromium session "default" of yours/)
  assert.match(await tool('chromium_browse', { action: 'read', session: 'b2/default' }, 'm1'), /page body/)

  // show/hide move the OS window through CDP.
  assert.match(await tool('chromium_browse', { action: 'show' }, 'b2'), /Brought "default" on-screen/)
  assert.equal(browser._pages[0]._bounds.windowState, 'normal')

  assert.match(await tool('chromium_close', { session: 'default' }, 'b2'), /Closed "default"/)
  assert.equal(browser.connected, false)
  assert.match(await tool('chromium_close', {}, 'b2'), /no Chromium browser open/)
})

test('a system browser is used when one is installed', async (t) => {
  const download = fakeDownload()
  const launches = []
  const { tool, stop } = start({ probe: () => 'C:/sys/chrome.exe', download, launches })
  t.after(stop)
  assert.match(await tool('chromium_open', { name: 'work' }, 'b2'), /is open on the system browser/)
  assert.equal(download.calls.install, 0)
  assert.equal(launches[0].executablePath, 'C:/sys/chrome.exe')
})

test('a headless session has no window to show', async (t) => {
  const launches = []
  const { tool, stop } = start({ launches })
  t.after(stop)
  assert.match(await tool('chromium_open', { name: 'quiet', headless: true }, 'b2'), /is open on a Chrome for Testing 141\.0\.0 downloaded just now, headless/)
  assert.equal(launches[0].headless, true)
  assert.ok(!launches[0].args.includes('--window-position=-32000,-32000'))
  assert.match(await tool('chromium_browse', { action: 'show', session: 'quiet' }, 'b2'), /runs headless/)
  assert.match(await tool('chromium_browse', { action: 'read' }, 'b2'), /page body/)
})

test('a dead browser relaunches on the same profile', async (t) => {
  const first = fakeBrowser()
  const second = fakeBrowser()
  const launches = []
  const browsers = [first, second]
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-chromium-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext({})
  const launch = async (options) => { launches.push(options); return browsers.shift() }
  createRuntime(ctx, { home, chromium: { launch, probe: () => undefined, download: fakeDownload() } })
  t.after(async () => {
    await ctx.dispose()
    try { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) } catch { /* a late home write keeps the dir */ }
  })
  const tool = (name, args, agent) => ctx.registeredTools.get(name).execute(args, { agent: { id: agent } })
  await tool('chromium_open', { name: 'web' }, 'b2')
  first.connected = false
  assert.match(await tool('chromium_browse', { action: 'read' }, 'b2'), /page body/)
  assert.equal(launches.length, 2)
  assert.equal(launches[1].userDataDir, launches[0].userDataDir)
})

test('the client view lists sessions, screenshots, and moves the window', async (t) => {
  const browser = fakeBrowser()
  const { rt, tool, stop } = start({ browser })
  t.after(stop)
  await tool('chromium_open', { name: 'web' }, 'b2')
  assert.deepEqual(await rt.chromiumList('b2'), [{ id: 'b2/web', name: 'web', hidden: true, headless: false, title: 'Fake title', url: 'https://start.example/' }])
  assert.deepEqual(await rt.chromiumList('b3'), [])
  const shot = await rt.chromiumShot('b2', 'b2/web')
  assert.equal(shot.image, `data:image/jpeg;base64,${Buffer.from('jpeg-bytes').toString('base64')}`)
  assert.equal(shot.hidden, true)
  assert.deepEqual(await rt.chromiumShot('b3', 'b2/web'), { image: null })
  const page = browser._pages[0]
  assert.deepEqual(await rt.chromiumShow('b2', 'b2/web', true), { ok: true, hidden: false })
  assert.equal(page.cdpCalls.at(-1)[0], 'Browser.setWindowBounds')
  assert.deepEqual(await rt.chromiumShow('b3', 'b2/web', true), { ok: false })
  assert.deepEqual(await rt.chromiumClick('b2', 'b2/web', 0.5, 0.25), { ok: true })
  assert.deepEqual(page.mouseClicks.at(-1), [640, 200])
  assert.deepEqual(await rt.chromiumClick('b3', 'b2/web', 0.5, 0.25), { ok: false })
})

test('sessions pick by name and refuse strangers', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-chromium-'))
  try {
    const sessions = createChromiumSessions({ launch: async () => fakeBrowser() })
    const one = await sessions.open('b2', 'one', { executablePath: 'x', userDataDir: join(home, 'p1'), args: [] })
    const two = await sessions.open('b2', 'two', { executablePath: 'x', userDataDir: join(home, 'p2'), args: [] })
    assert.equal(sessions.pick('one', 'b2', false), one)
    assert.throws(() => sessions.pick(undefined, 'b2', false), /2 Chromium sessions are open \(one, two\)/)
    assert.throws(() => sessions.pick('one', 'b3', false), /No Chromium session "one" of yours/)
    assert.equal(sessions.pick('one', 'b3', true), one) // a Main Bot picks any session by name
    assert.equal(sessions.pick('b2/two', 'b3', true), two)
    assert.equal(await sessions.close(one.id), true)
    assert.throws(() => sessions.pick('one', 'b2', false), /No Chromium session "one"/)
    await sessions.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('config.chromium: false registers no tools', async (t) => {
  const { ctx, stop } = start({ config: { chromium: false } })
  t.after(stop)
  for (const name of ['chromium_open', 'chromium_close', 'chromium_browse']) assert.ok(!ctx.registeredTools.has(name), name)
})
