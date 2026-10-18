import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// A fake Zalo library stands in for zca-js: QR login finishes at once, the saved
// credentials log back in, and listener events are played by hand. No account,
// no network.
function fakeZalo() {
  const sent = []
  const logins = []
  const handlers = {}
  const api = {
    sent,
    logins,
    listener: {
      onMessage: fn => { handlers.message = fn },
      onConnected: fn => { handlers.connected = fn },
      onClosed: fn => { handlers.closed = fn },
      onError: fn => { handlers.error = fn },
      start: () => { api.listener.started = true; handlers.connected?.() },
      stop: () => { api.listener.started = false },
      started: false,
    },
    emit: message => handlers.message?.(message),
    async sendMessage(content, threadId, type) { sent.push({ content, threadId, type }) },
    async fetchAccountInfo() { return { data: { display_name: 'Shop Bot' } } },
    getOwnId: () => 'z-uid-1',
    async getAllFriends() { return [{ userId: 'u-minh', displayName: 'Minh' }] },
    async getAllGroups() { return { version: 'v1', gridVerMap: { g1: 'v1' } } },
    async getGroupInfo() { return { gridInfoMap: { g1: { name: 'Team Chat' } } } },
  }
  const lib = {
    ThreadType: { User: 0, Group: 1 },
    LoginQRCallbackEventType: { QRCodeGenerated: 0, QRCodeExpired: 1, QRCodeScanned: 2, QRCodeDeclined: 3, GotLoginInfo: 4 },
    Zalo: function () {
      return {
        async login(credentials) { logins.push(credentials); return api },
        async loginQR(_options, callback) {
          const EVT = lib.LoginQRCallbackEventType
          callback({ type: EVT.QRCodeGenerated, data: { image: 'QRPNG' } })
          callback({ type: EVT.QRCodeScanned, data: { display_name: 'Shop Bot' } })
          callback({ type: EVT.GotLoginInfo, data: { cookie: 'c', imei: 'i', userAgent: 'ua' } })
          return api
        },
      }
    },
  }
  return { lib, api }
}

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 } },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function start({ lib } = {}) {
  const zalo = fakeZalo()
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-zalo-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext()
  const delivered = []
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async () => { throw new Error('none') }, archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 'new' }),
      resolveAgent: async sessionId => ({
        agent: {
          id: sessionId,
          session: { id: sessionId },
          inbox: { nextTurn: [], nextStep: [] },
          followup: message => delivered.push({ sessionId, message }),
          steer: message => delivered.push({ sessionId, message }),
        },
      }),
      selectModel: async () => {},
      prompt: async () => ({ accepted: true }),
      page: async () => ({ events: [] }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home, zalo: { import: async () => lib ?? zalo.lib } })
  const call = async (endpoint, payload) =>
    (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const emit = async (sessionId, event) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) await listener({ id: sessionId }, event)
  }
  const stop = async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
  return { ctx, home, rt, call, emit, delivered, stop, api: zalo.api }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const waitFor = async (check) => {
  for (let at = 0; at < 100; at += 1) {
    const value = await check()
    if (value !== undefined) return value
    await settle()
  }
  return undefined
}

// A Zalo turn, played like a round's answer: trigger source, reply text, end.
const answer = async (emit, sessionId, source, text) => {
  await emit(sessionId, { type: 'turn/start', data: { turn: 1 } })
  await emit(sessionId, { type: 'user/message', data: { source, content: [{ type: 'text', text: '…' }] } })
  await emit(sessionId, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
  await emit(sessionId, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
}

const inbound = (threadId, text, extra = {}) => ({
  threadId, isSelf: false,
  data: { uidFrom: threadId, dName: 'Minh', content: text, msgId: String(Date.now()), ts: Date.now() },
  ...extra,
})

const status = async (call) => (await call('zalo-status', {})).value
// Account linked and the QR card closed: the login is really done.
const ready = async (call) => {
  const value = await status(call)
  const account = value.bots.m1?.account
  return account !== null && account !== undefined && value.login === null ? value : undefined
}
const linked = async (call, api) => {
  const started = await call('zalo-start', { botId: 'm1' })
  assert.equal(started.ok, true, JSON.stringify(started))
  const live = await waitFor(() => ready(call))
  assert.ok(live !== undefined, 'login did not finish')
  assert.equal(live.bots.m1.account.uid, 'z-uid-1')
  assert.equal(api.listener.started, true)
  return live
}

test('QR login links the account, stores the session as a secret, and starts listening', async (t) => {
  const { call, home, api, stop } = start()
  t.after(stop)

  const started = await call('zalo-start', { botId: 'm1' })
  assert.equal(started.ok, true, JSON.stringify(started))
  assert.equal(started.value.login.phase, 'qr')
  const shown = await waitFor(async () => (await status(call)).login?.qr)
  assert.equal(shown, 'data:image/png;base64,QRPNG')

  const live = await waitFor(() => ready(call))
  assert.ok(live !== undefined, 'login did not finish')
  assert.deepEqual(live.bots.m1.account, { uid: 'z-uid-1', name: 'Shop Bot' })
  assert.equal(live.bots.m1.state, 'ready')
  assert.equal(live.login, null)
  assert.equal(api.listener.started, true)
  // The saved secret either re-logs in once here, or the QR path's session is
  // already the live one — at most one credential login may race in.
  assert.ok(api.logins.length <= 1, String(api.logins.length))

  // The session went into secrets.json under the Bot's name, never into state.json.
  const secrets = JSON.parse(readFileSync(join(home, 'secrets.json'), 'utf8'))
  const names = (secrets.secrets ?? []).map(entry => entry.name)
  assert.ok(names.some(name => name.startsWith('ZALO_SESSION')), JSON.stringify(names))
  assert.ok(!readFileSync(join(home, 'state.json'), 'utf8').includes('userAgent'))
})

test('a talk thread gets the delivered message and the finished turn back on Zalo', async (t) => {
  const { call, emit, delivered, api, stop } = start()
  t.after(stop)
  await linked(call, api)
  const mode = await call('zalo-thread-mode', { botId: 'm1', threadId: 'u-minh', kind: 'user', name: 'Minh', mode: 'talk' })
  assert.equal(mode.ok, true, JSON.stringify(mode))

  api.emit(inbound('u-minh', 'hello bot'))
  const message = await waitFor(() => delivered.find(entry => entry.sessionId === 'm1'))
  assert.ok(message !== undefined, 'nothing delivered to the Bot')
  assert.equal(message.message.source.role, 'zalo')
  assert.match(message.message.content[0].text, /^\[Zalo · /)
  assert.match(message.message.content[0].text, /hello bot$/)

  await answer(emit, 'm1', message.message.source, 'hi Minh, the Bot here')
  const sent = await waitFor(() => api.sent.find(entry => entry.threadId === 'u-minh'))
  assert.ok(sent !== undefined, 'no reply reached Zalo')
  assert.equal(sent.type, 0)
  assert.match(sent.content.msg, /hi Minh, the Bot here/)
})

test('a watch thread buffers quietly, wakes on a mention, and never relays the reply', async (t) => {
  const { call, emit, delivered, api, stop } = start()
  t.after(stop)
  await linked(call, api)
  await call('zalo-thread-mode', { botId: 'm1', threadId: 'g1', kind: 'group', name: 'Team Chat', mode: 'watch', keywords: ['urgent'] })

  api.emit(inbound('g1', 'just chatter'))
  await settle(); await settle()
  assert.equal(delivered.length, 0)

  const buffered = await waitFor(async () => {
    const state = await status(call)
    return state.bots.m1.threads.g1?.buffered === 1 ? state : undefined
  })
  assert.ok(buffered !== undefined, 'nothing buffered')

  api.emit(inbound('g1', '@Shop Bot can you check?'))
  const wake = await waitFor(() => delivered.find(entry => entry.sessionId === 'm1'))
  assert.ok(wake !== undefined, 'mention did not wake the Bot')
  assert.match(wake.message.content[0].text, /zalo_send/)
  assert.match(wake.message.content[0].text, /just chatter/)

  // The wake has no waiter: the turn's text must not leak into the group.
  await answer(emit, 'm1', wake.message.source, 'looks fine')
  await settle(); await settle()
  assert.equal(api.sent.length, 0)
})

test('self messages and unconfigured threads are ignored', async (t) => {
  const { call, delivered, api, stop } = start()
  t.after(stop)
  await linked(call, api)
  await call('zalo-thread-mode', { botId: 'm1', threadId: 'u-minh', kind: 'user', name: 'Minh', mode: 'talk' })

  api.emit(inbound('u-minh', 'echo', { isSelf: true }))
  api.emit(inbound('u-minh', 'mine again', { data: { uidFrom: 'z-uid-1', dName: 'Shop Bot', content: 'mine again', msgId: 'x', ts: 1 } }))
  api.emit(inbound('stranger', 'who are you'))
  await settle(); await settle()
  assert.equal(delivered.length, 0)
  assert.equal(api.sent.length, 0)
})

test('zalo tools: threads list, read the buffer, send only to configured threads', async (t) => {
  const { call, ctx, api, stop } = start()
  t.after(stop)
  await linked(call, api)
  await call('zalo-thread-mode', { botId: 'm1', threadId: 'g1', kind: 'group', name: 'Team Chat', mode: 'watch', keywords: [] })
  api.emit(inbound('g1', 'first line'))
  await settle(); await settle()

  const exec = { agent: { id: 'm1' } }
  const threads = await ctx.registeredTools.get('zalo_threads').execute({}, exec)
  assert.match(threads, /Team Chat/)
  assert.match(threads, /watch/)

  const read = await ctx.registeredTools.get('zalo_read').execute({ thread: 'Team Chat' }, exec)
  assert.match(read, /first line/)

  const sent = await ctx.registeredTools.get('zalo_send').execute({ thread: 'Team Chat', text: 'hello group' }, exec)
  assert.match(sent, /Sent/)
  const out = await waitFor(() => api.sent.find(entry => entry.threadId === 'g1'))
  assert.equal(out.type, 1)
  assert.equal(out.content.msg, 'hello group')

  // An off thread refuses; a name nobody configured refuses too.
  await call('zalo-thread-mode', { botId: 'm1', threadId: 'u-off', kind: 'user', name: 'Stranger', mode: 'off' })
  assert.match(await ctx.registeredTools.get('zalo_send').execute({ thread: 'u-off', text: 'x' }, exec), /off/)
  assert.match(await ctx.registeredTools.get('zalo_send').execute({ thread: 'nobody', text: 'x' }, exec), /No such Zalo thread/)
})

test('zalo-threads lists friends and groups; logout clears the account and its secret', async (t) => {
  const { call, home, api, stop } = start()
  t.after(stop)
  await linked(call, api)
  await call('zalo-thread-mode', { botId: 'm1', threadId: 'u-minh', kind: 'user', name: 'Minh', mode: 'talk' })

  const list = await call('zalo-threads', { botId: 'm1' })
  assert.equal(list.ok, true, JSON.stringify(list))
  assert.deepEqual(list.value.users, [{ id: 'u-minh', kind: 'user', name: 'Minh', mode: 'talk', keywords: [] }])
  assert.equal(list.value.groups[0].name, 'Team Chat')
  assert.equal(list.value.groups[0].mode, 'off')

  const off = await call('zalo-logout', { botId: 'm1' })
  assert.equal(off.ok, true, JSON.stringify(off))
  assert.equal(off.value.bots.m1.account, null)
  assert.equal(off.value.bots.m1.state, 'off')
  const secrets = JSON.parse(readFileSync(join(home, 'secrets.json'), 'utf8'))
  assert.ok(!(secrets.secrets ?? []).some(entry => entry.name.startsWith('ZALO_SESSION')))
})

test('a canceled QR login leaves no account and no session', async (t) => {
  const zalo = fakeZalo()
  let never
  zalo.lib.Zalo = function () {
    return {
      login: async () => zalo.api,
      loginQR: async (_options, callback) => {
        callback({ type: zalo.lib.LoginQRCallbackEventType.QRCodeGenerated, data: { image: 'QRPNG' }, actions: { abort: () => { never?.resolve() } } })
        return new Promise((resolve, reject) => { never = { resolve: () => reject(new Error('canceled')), reject } })
      },
    }
  }
  const { call, api, stop } = start({ lib: zalo.lib })
  t.after(stop)

  const started = await call('zalo-start', { botId: 'm1' })
  assert.equal(started.value.login.phase, 'qr')
  const canceled = await call('zalo-cancel', {})
  assert.equal(canceled.ok, true, JSON.stringify(canceled))
  await settle(); await settle()
  const live = await status(call)
  assert.equal(live.bots.m1?.account ?? null, null)
  assert.equal(live.login, null)
  assert.equal(api.listener.started, false)
})
