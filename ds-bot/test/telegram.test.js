import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeAttachments, fakeContext } from './fake-ctx.js'

const TOKEN = '123456789:AAHfakeTokenForTestsOnly_abcdefg'
const OTHER_TOKEN = '987654321:BBHanotherFakeToken_zzzzzzz'

// A fake Telegram Bot API: getMe, getUpdates and sendMessage answer in memory,
// and the updates a test queues are handed out one long-poll at a time. No
// network, no real bot.
function fakeTelegram() {
  const sent = []
  const queue = []
  const calls = []
  let waiting = []
  const bots = new Map()
  const reply = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) })
  const refuse = (code, description) => ({ ok: false, status: code, json: async () => ({ ok: false, error_code: code, description }) })
  const botOf = token => {
    if (!bots.has(token)) bots.set(token, { id: Number(token.split(':')[0]), username: token === TOKEN ? 'minh_it_bot' : 'other_bot' })
    return bots.get(token)
  }
  async function fetchImpl(url, options = {}) {
    const match = /\/bot([^/]+)\/(\w+)/.exec(String(url))
    if (match === null) return refuse(404, 'no such endpoint')
    const [, token, method] = match
    // sendPhoto arrives as multipart FormData; everything else as a JSON string.
    const body = typeof options.body === 'string' || options.body === undefined
      ? (options.body === undefined ? {} : JSON.parse(options.body))
      : { chat_id: options.body.get('chat_id'), caption: options.body.get('caption') ?? '', photo: options.body.get('photo') }
    calls.push({ method, body })
    if (method === 'getMe') {
      if (!token.startsWith('123') && !token.startsWith('987')) return refuse(401, 'Unauthorized')
      return reply(botOf(token))
    }
    if (method === 'getUpdates') {
      // Long polling: hold the call until a test queues an update, then answer.
      // One shared timer, not one listener per call, so a long test cannot pile
      // up abort listeners on the session's own signal.
      if (queue.length === 0) {
        await new Promise((resolve) => { waiting.push(resolve); setTimeout(resolve, 40) })
      }
      if (options.signal?.aborted === true) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      const offset = body.offset ?? 0
      const fresh = queue.filter(update => update.update_id >= offset)
      return reply(fresh)
    }
    if (method === 'sendMessage') {
      sent.push({ token, chatId: String(body.chat_id), text: String(body.text), photo: false })
      return reply({ message_id: sent.length })
    }
    if (method === 'sendPhoto') {
      if (body.photo === null || body.photo === undefined) return refuse(400, 'photo is missing')
      sent.push({ token, chatId: String(body.chat_id), text: String(body.caption ?? ''), photo: true })
      return reply({ message_id: sent.length })
    }
    if (method === 'getFile') return reply({ file_path: 'photos/file_1.jpg' })
    return refuse(400, `unexpected ${method}`)
  }
  const push = update => {
    queue.push(update)
    for (const done of waiting.splice(0)) done()
  }
  return { fetchImpl, sent, calls, push, queue }
}

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Minh', role: 'IT', instructions: '', createdAt: 1 } },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function start({ team = TEAM, secrets } = {}) {
  const telegram = fakeTelegram()
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-telegram-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  if (secrets !== undefined) writeFileSync(join(home, 'secrets.json'), JSON.stringify({ version: 1, secrets }))
  const ctx = fakeContext({ services: { attachments: fakeAttachments() } })
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
  const rt = createRuntime(ctx, { home, wake: false, telegram: { fetch: telegram.fetchImpl } })
  const call = async (endpoint, payload) =>
    (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const emit = async (sessionId, event) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) await listener({ id: sessionId }, event)
  }
  const stop = async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
  return { ctx, home, rt, call, emit, delivered, stop, telegram }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 25))
const waitFor = async (check) => {
  for (let at = 0; at < 120; at += 1) {
    const value = await check()
    if (value !== undefined) return value
    await settle()
  }
  return undefined
}

const message = (text, { updateId = 1, from = { id: 777, first_name: 'Anh', username: 'anh' }, chatId = 777 } = {}) => ({
  update_id: updateId,
  message: { message_id: updateId, chat: { id: chatId, type: 'private' }, from, text },
})

const status = async (call) => (await call('telegram-status', {})).value
// Paired means a chat is bound: the code is gone and the owner is set.
const paired = async (call) => {
  const entry = (await status(call)).bots.m1
  return entry?.owner !== undefined && entry?.owner !== null ? entry : undefined
}

test('connecting a token proves it, saves it as a secret, and shows a pairing code', async (t) => {
  const { call, home, telegram, stop } = start()
  t.after(stop)

  const bad = await call('telegram-connect', { botId: 'm1', token: 'nope' })
  assert.equal(bad.ok, false)
  assert.match(bad.error.message, /does not look like a Telegram bot token/)

  const connected = await call('telegram-connect', { botId: 'm1', token: TOKEN })
  assert.equal(connected.ok, true, JSON.stringify(connected))
  const entry = connected.value.bots.m1
  assert.equal(entry.username, 'minh_it_bot')
  assert.equal(entry.owner, null)
  assert.match(entry.code, /^[A-Z2-9]{6}$/)
  // The token never lands in state.json; it is a secret with no Bot's shell scope.
  const saved = readFileSync(join(home, 'state.json'), 'utf8')
  assert.equal(saved.includes(TOKEN), false)
  const secrets = JSON.parse(readFileSync(join(home, 'secrets.json'), 'utf8')).secrets
  const stored = secrets.find(secret => secret.name === 'TELEGRAM_TOKEN_M1')
  assert.equal(stored.value, TOKEN)
  assert.deepEqual(stored.scope, [])
  assert.ok(telegram.calls.some(call => call.method === 'getMe'))
})

test('a refused token is not saved', async (t) => {
  const { call, home, stop } = start()
  t.after(stop)
  const refused = await call('telegram-connect', { botId: 'm1', token: '111111:AAHfakeTokenForTestsOnly_abcdefg' })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /Telegram refused this token/)
  // Nothing was written: a refused token leaves no secret behind.
  let written
  try { written = readFileSync(join(home, 'secrets.json'), 'utf8') } catch { written = '' }
  assert.equal(written.includes('AAHfakeToken'), false)
})

test('only the pairing code binds a chat; a stranger is told the bot is taken', async (t) => {
  const { call, telegram, stop } = start()
  t.after(stop)
  await call('telegram-connect', { botId: 'm1', token: TOKEN })
  const code = (await status(call)).bots.m1.code

  // Before pairing, plain chatter is answered with the code hint and runs no turn.
  telegram.push(message('chào em'))
  await waitFor(() => telegram.sent.find(line => /Mã ghép nối còn thiếu/.test(line.text)))
  assert.equal((await status(call)).bots.m1.owner, null)

  telegram.push(message('/start WRONG1', { updateId: 2 }))
  await waitFor(() => telegram.sent.find(line => /không đúng hoặc đã hết hạn/.test(line.text)))

  telegram.push(message(`/start ${code}`, { updateId: 3 }))
  const bound = await waitFor(() => paired(call))
  assert.ok(bound !== undefined, 'pairing did not finish')
  assert.equal(bound.owner.id, '777')
  assert.equal(bound.owner.chatId, '777')
  assert.equal(bound.code, null)
  await waitFor(() => telegram.sent.find(line => /Đã ghép nối/.test(line.text)))

  // A different account writing the same bot is refused, not served.
  telegram.push(message('xuất kho giúp anh', { updateId: 4, from: { id: 999, first_name: 'Người lạ' }, chatId: 999 }))
  await waitFor(() => telegram.sent.find(line => line.chatId === '999' && /đã ghép với một tài khoản khác/.test(line.text)))
})

test('a paired message runs a turn and its reply goes back to Telegram', async (t) => {
  const { call, emit, delivered, telegram, stop } = start({
    secrets: [{ name: 'TELEGRAM_TOKEN_M1', value: TOKEN, purpose: 'Telegram bot for Minh', scope: [], createdAt: 1, updatedAt: 1 }],
  })
  t.after(stop)
  // The token is already saved, so the poller comes up by itself.
  const bound = await waitFor(async () => {
    const entry = (await status(call)).bots.m1
    return entry?.state === 'ready' ? entry : undefined
  })
  assert.ok(bound !== undefined, 'the poller never came up')

  telegram.push(message('/start AAAAAA', { updateId: 1 }))
  // The token is live but the chat is not paired yet, so this only gets the hint.
  await waitFor(() => telegram.sent.length > 0)

  const code = (await status(call)).bots.m1.code
  assert.match(code, /^[A-Z2-9]{6}$/)
  telegram.push(message(`/start ${code}`, { updateId: 2 }))
  assert.ok(await waitFor(() => paired(call)) !== undefined, 'pairing did not finish')

  telegram.push(message('đơn nào chưa xuất được em?', { updateId: 3 }))
  const turn = await waitFor(() => delivered.find(entry => entry.sessionId === 'm1'))
  assert.ok(turn !== undefined, 'no turn was delivered')
  const source = turn.message.source
  assert.equal(source.role, 'telegram')
  assert.equal(source.kind, 'bot')
  assert.match(turn.message.content[0].text, /^\[Telegram · /)
  assert.match(turn.message.content[0].text, /đơn nào chưa xuất được em\?/)

  // The turn ends with its text, which the waiter relays to the chat.
  await emit('m1', { type: 'turn/start', data: { turn: 1 } })
  await emit('m1', { type: 'user/message', data: { source, content: turn.message.content } })
  await emit('m1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Còn 3 đơn chưa xuất được.' }] } } })
  await emit('m1', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  const reply = await waitFor(() => telegram.sent.find(line => /Còn 3 đơn chưa xuất được/.test(line.text)))
  assert.ok(reply !== undefined, 'the reply never reached Telegram')
  assert.equal(reply.chatId, '777')
})

test('a long reply is split under the 4096-character limit', async (t) => {
  const { call, emit, delivered, telegram, stop } = start()
  t.after(stop)
  await call('telegram-connect', { botId: 'm1', token: TOKEN })
  const code = (await status(call)).bots.m1.code
  telegram.push(message(`/start ${code}`))
  assert.ok(await waitFor(() => paired(call)) !== undefined)

  telegram.push(message('liệt kê hết giúp em', { updateId: 2 }))
  const turn = await waitFor(() => delivered.find(entry => entry.sessionId === 'm1'))
  assert.ok(turn !== undefined)
  const source = turn.message.source
  const long = Array.from({ length: 300 }, (_, index) => `Dòng ${index + 1}: một dòng khá dài để vượt giới hạn.`).join('\n')
  assert.ok(long.length > 4096)
  await emit('m1', { type: 'turn/start', data: { turn: 1 } })
  await emit('m1', { type: 'user/message', data: { source, content: turn.message.content } })
  await emit('m1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: long }] } } })
  await emit('m1', { type: 'turn/end', data: { reason: { kind: 'completed' } } })

  const chunks = await waitFor(() => {
    const sent = telegram.sent.filter(line => /^Dòng \d+:/.test(line.text))
    return sent.length > 1 ? sent : undefined
  })
  assert.ok(chunks !== undefined, 'the long reply was not split')
  for (const chunk of chunks) assert.ok(chunk.text.length <= 4096, `chunk of ${chunk.text.length} characters`)
  assert.match(chunks.map(chunk => chunk.text).join(''), /Dòng 300/)
  assert.match(chunks[0].text, /^Dòng 1:/)
})

test('telegram_send lets a Bot message first, and says so when it is not paired', async (t) => {
  const { call, rt, telegram, stop } = start()
  t.after(stop)
  const tool = rt.teamTools.find(entry => entry.name === 'telegram_send')
  assert.ok(tool !== undefined, 'telegram_send was not registered')

  const unpaired = await tool.execute({ text: 'xong rồi anh' }, { agent: { id: 'm1' } })
  assert.match(unpaired, /not paired yet/)

  await call('telegram-connect', { botId: 'm1', token: TOKEN })
  const code = (await status(call)).bots.m1.code
  telegram.push(message(`/start ${code}`))
  assert.ok(await waitFor(() => paired(call)) !== undefined)

  const sent = await tool.execute({ text: 'Đồng bộ ads xong, 3 shop vẫn tắc.' }, { agent: { id: 'm1' } })
  assert.equal(sent, 'Sent on Telegram.')
  const line = await waitFor(() => telegram.sent.find(entry => /3 shop vẫn tắc/.test(entry.text)))
  assert.ok(line !== undefined)
  assert.equal(line.chatId, '777')
})

// A 1x1 PNG for the photo tests: only the magic bytes matter to the sender.
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

async function pairedBot() {
  const started = start()
  const { call, telegram } = started
  await call('telegram-connect', { botId: 'm1', token: TOKEN })
  const code = (await status(call)).bots.m1.code
  telegram.push(message(`/start ${code}`))
  assert.ok(await waitFor(() => paired(call)) !== undefined)
  return started
}

test('telegram_send with an image sends a photo with the text as caption', async (t) => {
  const { call, rt, home, telegram, stop } = await pairedBot()
  t.after(stop)
  void call
  void telegram
  const tool = rt.teamTools.find(entry => entry.name === 'telegram_send')
  const photo = join(home, 'avatar.png')
  writeFileSync(photo, TINY_PNG)
  const sent = await tool.execute({ text: 'Avatar máy xay thịt đây anh.', image: photo }, { agent: { id: 'm1' } })
  assert.equal(sent, 'Sent on Telegram.')
  const line = await waitFor(() => telegram.sent.find(entry => entry.photo === true))
  assert.ok(line !== undefined)
  assert.equal(line.chatId, '777')
  assert.equal(line.text, 'Avatar máy xay thịt đây anh.')
})

test('telegram_send refuses a missing or non-image file', async (t) => {
  const { rt, home, stop } = await pairedBot()
  t.after(stop)
  const tool = rt.teamTools.find(entry => entry.name === 'telegram_send')
  const missing = await tool.execute({ text: 'xem ảnh nhé', image: join(home, 'nope.png') }, { agent: { id: 'm1' } })
  assert.match(missing, /no file/)
  const notImage = join(home, 'note.txt')
  writeFileSync(notImage, 'hello')
  const bad = await tool.execute({ text: 'xem ảnh nhé', image: notImage }, { agent: { id: 'm1' } })
  assert.match(bad, /not a PNG, JPEG, GIF or WebP/)
})

test('a caption past 1024 characters continues as text messages', async (t) => {
  const { rt, home, telegram, stop } = await pairedBot()
  t.after(stop)
  const tool = rt.teamTools.find(entry => entry.name === 'telegram_send')
  const photo = join(home, 'avatar.png')
  writeFileSync(photo, TINY_PNG)
  const long = `Mở đầu. ${'xem ảnh nhé. '.repeat(120)}`
  assert.ok(long.length > 1024)
  const sent = await tool.execute({ text: long, image: photo }, { agent: { id: 'm1' } })
  assert.equal(sent, 'Sent on Telegram.')
  const photoLine = await waitFor(() => telegram.sent.find(entry => entry.photo === true))
  assert.ok(photoLine !== undefined)
  assert.ok(photoLine.text.length <= 1024, `caption of ${photoLine.text.length} characters`)
  const tail = await waitFor(() => telegram.sent.find(entry => entry.photo !== true && /xem ảnh nhé/.test(entry.text)))
  assert.ok(tail !== undefined, 'the over-long caption did not continue as text')
})

test('a second Bot gets its own token and its own chat', async (t) => {
  const team = {
    ...TEAM,
    mainBotIds: ['m1', 'b2'],
    bots: {
      m1: { id: 'm1', sessionId: 'm1', name: 'Minh', role: 'IT', instructions: '', createdAt: 1 },
      b2: { id: 'b2', sessionId: 'b2', name: 'Phúc', role: 'Warehouse', instructions: '', createdAt: 2 },
    },
  }
  const { call, telegram, stop } = start({ team })
  t.after(stop)
  await call('telegram-connect', { botId: 'm1', token: TOKEN })
  const second = await call('telegram-connect', { botId: 'b2', token: OTHER_TOKEN })
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.equal(second.value.bots.b2.username, 'other_bot')
  // Two separate pollers, one per token.
  const pollers = new Set(telegram.calls.filter(entry => entry.method === 'getUpdates'))
  assert.ok(pollers.size >= 1)
  const tokens = new Set(telegram.calls.filter(entry => entry.method === 'getMe').map(entry => entry.body))
  void tokens
})

test('disconnecting drops the secret, the pairing, and the poller', async (t) => {
  const { call, home, stop } = start()
  t.after(stop)
  await call('telegram-connect', { botId: 'm1', token: TOKEN })
  const gone = await call('telegram-disconnect', { botId: 'm1' })
  assert.equal(gone.ok, true)
  assert.equal(gone.value.bots.m1, undefined)
  const secrets = JSON.parse(readFileSync(join(home, 'secrets.json'), 'utf8')).secrets
  assert.equal(secrets.some(secret => secret.name === 'TELEGRAM_TOKEN_M1'), false)
})

test('config.telegram false leaves the tool and the pollers out', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-telegram-off-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, wake: false, telegram: false })
  try {
    assert.ok(!ctx.calls.includes('tool telegram_send'))
    assert.ok(!ctx.calls.includes('effect ds-bot: telegram'))
    assert.ok(!rt.teamTools.some(entry => entry.name === 'telegram_send'))
  } finally {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
})
