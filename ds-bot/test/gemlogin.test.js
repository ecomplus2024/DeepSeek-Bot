import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { createGemApi, createGemSessions, findProfile } from '../src/host/gemlogin.js'
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

// Answers the GemLogin local API the way the app does: { success, message, data }.
function fakeGemLogin(calls) {
  return async (url) => {
    calls.push(url)
    const path = new URL(url).pathname
    if (path === '/api/groups') return { ok: true, json: async () => ({ success: true, message: 'OK', data: [{ id: 1, name: 'Work' }] }) }
    if (path === '/api/profiles') return { ok: true, json: async () => ({ success: true, message: 'OK', data: [{ id: 23, name: 'Demo23', raw_proxy: 'http://user:pass@1.2.3.4:8080', browser_version: 133, group_id: '1' }] }) }
    if (path === '/api/profile/23') return { ok: true, json: async () => ({ success: true, message: 'OK', data: { id: '23', name: 'Demo23' } }) }
    if (path === '/api/profiles/start/23') return { ok: true, json: async () => ({ success: true, message: 'OK', data: { profile_id: 23, remote_debugging_address: '127.0.0.1:56170' } }) }
    if (path === '/api/profiles/close/23') return { ok: true, json: async () => ({ message: 'Close profile success', success: true }) }
    return { ok: true, json: async () => ({ success: false, message: 'no such api' }) }
  }
}

function start({ config = {}, browser } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-gem-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext({})
  const calls = []
  const connect = async () => browser ?? fakeBrowser()
  const rt = createRuntime(ctx, { home, gemlogin: { url: 'http://gem.test', fetch: fakeGemLogin(calls), connect }, ...config })
  const stop = async () => {
    await ctx.dispose()
    try { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) } catch { /* a late home write keeps the dir */ }
  }
  const tool = (name, args, agent) => ctx.registeredTools.get(name).execute(args, { agent: { id: agent } })
  return { ctx, rt, calls, tool, stop }
}

test('the api client unwraps data and reports reachability', async () => {
  const calls = []
  const api = createGemApi({ base: 'http://gem.test/', fetch: fakeGemLogin(calls) })
  assert.equal(api.base, 'http://gem.test')
  assert.deepEqual(await api.groups(), [{ id: 1, name: 'Work' }])
  assert.equal(calls.at(-1), 'http://gem.test/api/groups')
  const started = await api.start(23, { args: '--mute-audio', winPos: '10,10' })
  assert.equal(started.remote_debugging_address, '127.0.0.1:56170')
  assert.match(calls.at(-1), /addination_args=--mute-audio&win_pos=10%2C10/)
  const down = createGemApi({ base: 'http://gem.test', fetch: async () => { throw new TypeError('fetch failed') } })
  await assert.rejects(down.groups(), /not reachable at http:\/\/gem\.test/)
  const refused = createGemApi({ base: 'http://gem.test', fetch: async () => ({ ok: true, json: async () => ({ success: false, message: 'profile is running' }) }) })
  await assert.rejects(refused.groups(), /profile is running/)
})

test('findProfile resolves ids and exact names', async () => {
  const api = createGemApi({ base: 'http://gem.test', fetch: fakeGemLogin([]) })
  assert.deepEqual(await findProfile(api, '23'), { id: '23', name: 'Demo23' })
  assert.deepEqual(await findProfile(api, 'Demo23'), { id: '23', name: 'Demo23' })
  await assert.rejects(findProfile(api, 'nobody'), /No GemLogin profile named "nobody"/)
  await assert.rejects(findProfile(api, '99'), /no profile #99/)
})

test('sessions attach once, pick by ref, and close', async () => {
  const calls = []
  const api = createGemApi({ base: 'http://gem.test', fetch: fakeGemLogin(calls) })
  const sessions = createGemSessions({ api, connect: async () => fakeBrowser() })
  const session = await sessions.open('b2', { id: '23', name: 'Demo23' })
  assert.equal(session.owner, 'b2')
  assert.equal(await sessions.open('b2', { id: '23', name: 'Demo23' }), session)
  assert.equal(calls.filter(url => url.includes('/start/')).length, 1)
  assert.equal(sessions.pick('Demo23'), session)
  assert.equal(sessions.pick(undefined), session)
  await assert.rejects(async () => sessions.close(23).then(() => sessions.pick(undefined)), /No GemLogin browser is open/)
  assert.equal(sessions.list().length, 0)
})

test('a Bot lists, opens, reads and clicks a GemLogin profile', async (t) => {
  const browser = fakeBrowser()
  const { ctx, calls, tool, stop } = start({ browser })
  t.after(stop)
  for (const name of ['gemlogin_profiles', 'gemlogin_open', 'gemlogin_close', 'gemlogin_browse']) assert.ok(ctx.registeredTools.has(name), name)

  const list = await tool('gemlogin_profiles', {}, 'b2')
  assert.match(list, /GemLogin at http:\/\/gem\.test: 1 profile\./)
  assert.match(list, /#23 Demo23, browser 133, Work, proxy http:\/\/\*{3}:\*{3}@1\.2\.3\.4:8080/)

  const opened = await tool('gemlogin_open', { profile: '23' }, 'b2')
  assert.match(opened, /Profile "Demo23" \(#23\) is open; its browser answers on 127\.0\.0\.1:56170/)
  assert.match(await tool('gemlogin_profiles', {}, 'b2'), /open \(Writer\)/)
  // Opening defaults to hidden: Chrome gets the off-screen position flag and the
  // window is minimized right after it starts (Windows snaps a fully off-screen
  // window back on, so hidden means minimized).
  assert.ok(calls.some(url => url.includes('/api/profiles/start/23?') && url.includes('win_pos=-32000%2C-32000') && url.includes('addination_args=--window-position')))
  assert.deepEqual(browser._pages[0].cdpCalls.findLast(call => call[0] === 'Browser.setWindowBounds')?.[1]?.bounds?.windowState, 'minimized')

  const missingRef = await tool('gemlogin_browse', { action: 'click', ref: 1 }, 'b2')
  assert.match(missingRef, /No read yet/)

  const text = await tool('gemlogin_browse', { action: 'read' }, 'b2')
  assert.match(text, /page body/)
  assert.match(text, /\[1\] link "More" → https:\/\/x\//)

  assert.match(await tool('gemlogin_browse', { action: 'click', ref: 1 }, 'b2'), /Clicked \[1\]/)
  const tabs = await tool('gemlogin_browse', { action: 'tabs' }, 'b2')
  assert.match(tabs, /\[1\] \(active\) Fake title — https:\/\/start\.example\//)
  assert.match(await tool('gemlogin_browse', { action: 'navigate', url: 'https://a.example/' }, 'b2'), /https:\/\/a\.example\/ — Fake title/)
  assert.match(await tool('gemlogin_browse', { action: 'evaluate', script: '1+1' }, 'b2'), /eval-result/)

  // show/hide move the OS window through the CDP Browser domain; hide remembers the
  // bounds it replaces so show puts the window back where it was.
  assert.match(await tool('gemlogin_browse', { action: 'hide' }, 'b2'), /Hid "Demo23" to the taskbar/)
  const page = browser._pages[0]
  assert.deepEqual(page._bounds.windowState, 'minimized')
  assert.match(await tool('gemlogin_browse', { action: 'show' }, 'b2'), /Brought "Demo23" on-screen/)
  assert.deepEqual(page.cdpCalls.at(-1)?.[1]?.bounds?.left, 50)

  // Another Bot cannot touch Writer's browser; the Main Bot can.
  assert.match(await tool('gemlogin_browse', { action: 'read' }, 'b3'), /driven by Writer, not you/)
  assert.match(await tool('gemlogin_browse', { action: 'read' }, 'm1'), /page body/)
  assert.match(await tool('gemlogin_close', { profile: '23' }, 'b3'), /cannot close it/)
  assert.match(await tool('gemlogin_close', { profile: '23' }, 'b2'), /Closed "Demo23" \(#23\)/)
  assert.ok(calls.some(url => url.includes('/api/profiles/close/23')))
  assert.match(await tool('gemlogin_close', {}, 'b2'), /no GemLogin browser open/)
})

test('the client view lists sessions, screenshots, and moves the window', async (t) => {
  const browser = fakeBrowser()
  const { rt, tool, stop } = start({ browser })
  t.after(stop)
  await tool('gemlogin_open', { profile: '23' }, 'b2')
  assert.deepEqual(await rt.gemLoginList('b2'), [{ profileId: '23', name: 'Demo23', hidden: true, title: 'Fake title', url: 'https://start.example/' }])
  assert.deepEqual(await rt.gemLoginList('b3'), [])
  const shot = await rt.gemLoginShot('b2', 23)
  assert.equal(shot.image, `data:image/jpeg;base64,${Buffer.from('jpeg-bytes').toString('base64')}`)
  assert.equal(shot.hidden, true)
  assert.deepEqual(await rt.gemLoginShot('b3', 23), { image: null })
  const page = browser._pages[0]
  assert.deepEqual(await rt.gemLoginShow('b2', 23, true), { ok: true, hidden: false })
  assert.equal(page.cdpCalls.at(-1)[0], 'Browser.setWindowBounds')
  assert.deepEqual(await rt.gemLoginShow('b3', 23, true), { ok: false })
  // A preview click goes to the pixel the same fraction of the viewport points at.
  assert.deepEqual(await rt.gemLoginClick('b2', 23, 0.5, 0.25), { ok: true })
  assert.deepEqual(page.mouseClicks.at(-1), [640, 200])
  assert.deepEqual(await rt.gemLoginClick('b3', 23, 0.5, 0.25), { ok: false })
})

test('hidden:false opens the window on-screen', async (t) => {
  const { calls, tool, stop } = start()
  t.after(stop)
  assert.match(await tool('gemlogin_open', { profile: '23', hidden: false }, 'b2'), /is open/)
  assert.ok(!calls.some(url => url.includes('win_pos=')))
})

test('browse steps run a whole sequence in one call and stop at a failure', async (t) => {
  const browser = fakeBrowser()
  const { tool, stop } = start({ browser })
  t.after(stop)
  await tool('gemlogin_open', { profile: '23' }, 'b2')
  const page = browser._pages[0]

  const ran = await tool('gemlogin_browse', { action: 'steps', steps: [
    { action: 'click', selector: '.conv' },
    { action: 'wait_for', selector: '.composer' },
    { action: 'type', selector: '.composer', text: 'Chào anh' },
    { action: 'press', key: 'Enter' },
  ] }, 'b2')
  assert.match(ran, /^Ran 4 steps; the page is now Fake title — https:\/\/start\.example\/\./)
  assert.match(ran, /1\. click "\.conv" — Clicked "\.conv"\./)
  assert.match(ran, /4\. press Enter — Pressed Enter\./)
  assert.deepEqual(page.clicks, ['.conv'])
  assert.deepEqual(page.typed, [['.composer', 'Chào anh']])

  const stopped = await tool('gemlogin_browse', { action: 'steps', steps: [
    { action: 'press', key: 'Enter' },
    { action: 'use_tab', tab: 99 },
    { action: 'press', key: 'Tab' },
  ] }, 'b2')
  assert.match(stopped, /^Stopped at step 2 of 3\./)
  assert.match(stopped, /2\. use_tab failed: No tab 99/)
  assert.ok(!stopped.includes('Pressed Tab'))

  assert.match(await tool('gemlogin_browse', { action: 'steps', steps: [{ action: 'steps', steps: [] }] }, 'b2'), /Stopped at step 1 of 1\.[\s\S]*steps cannot nest/)
  assert.match(await tool('gemlogin_browse', { action: 'steps', steps: [] }, 'b2'), /steps needs a list/)
  assert.match(await tool('gemlogin_browse', { action: 'steps' }, 'b2'), /steps needs a list/)
  const over = await tool('gemlogin_browse', { action: 'steps', steps: Array.from({ length: 21 }, () => ({ action: 'press', key: 'Tab' })) }, 'b2')
  assert.match(over, /At most 20 steps/)
})

test('read with a selector scopes the page to that part', async (t) => {
  const { tool, stop } = start()
  t.after(stop)
  await tool('gemlogin_open', { profile: '23' }, 'b2')
  assert.match(await tool('gemlogin_browse', { action: 'read', selector: '.chat' }, 'b2'), /page body in \.chat/)
  assert.match(await tool('gemlogin_browse', { action: 'read', selector: 'no-such' }, 'b2'), /Nothing matches "no-such"/)
})

test('gemlogin_open waits out the app\'s "being opened" state', async (t) => {
  const browser = fakeBrowser()
  let starts = 0
  const inner = fakeGemLogin([])
  const fetch = async (url) => {
    if (new URL(url).pathname === '/api/profiles/start/23') {
      starts += 1
      if (starts === 1) return { ok: true, json: async () => ({ success: false, message: 'Profile is currently being opened. Please wait.' }) }
    }
    return inner(url)
  }
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-gem-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext({})
  createRuntime(ctx, { home, gemlogin: { url: 'http://gem.test', fetch, connect: async () => browser } })
  t.after(async () => {
    await ctx.dispose()
    try { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) } catch { /* a late home write keeps the dir */ }
  })
  const tool = (name, args, agent) => ctx.registeredTools.get(name).execute(args, { agent: { id: agent } })
  assert.match(await tool('gemlogin_open', { profile: '23' }, 'b2'), /is open/)
  assert.equal(starts, 2)
})

test('config.gemlogin false keeps the tools off', (t) => {
  const { ctx, stop } = start({ config: { gemlogin: false } })
  t.after(stop)
  assert.ok(![...ctx.registeredTools.keys()].some(name => name.startsWith('gemlogin')))
})
