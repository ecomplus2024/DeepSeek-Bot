import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// Chief in its own chat 'a'; Writer is the admin of group 'r1' and speaks from 'gb'.
const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'b', named: true, sessions: { b: 'gb' }, log: [], seq: 0, seen: {} } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

// One DS Bot host on `home`; rt.pushNote is replaced with a recorder.
const started = new Map()

async function start(home) {
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const inbox = { nextStep: [], nextTurn: [], remove: () => false }
      const keep = (message) => { calls.push(message) }
      agents.set(sessionId, { session: { id: sessionId }, calls, inbox, followup: keep, steer: keep, cancel() {} })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  const pushes = []
  rt.pushNote = (kind, note) => { pushes.push({ kind, ...note }) }
  await rt.load()
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const host = { ctx, rt, agentOf, emit, pushes, stop: () => ctx.dispose() }
  started.set(home, [...(started.get(home) ?? []), host])
  return host
}

const freshHome = (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-push-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  t.after(async () => {
    await Promise.all((started.get(home) ?? []).map(host => host.stop()))
    started.delete(home)
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  return home
}

// A message as DSH would replay it: the turn starts and takes it up.
const run = (host, sessionId, turn, source, text = 'hi') => {
  host.emit(sessionId, 'turn/start', { turn })
  host.emit(sessionId, 'user/message', { content: [{ type: 'text', text }], source })
}
const assistantText = (host, sessionId, text) => {
  host.emit(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text }] } })
}
const endTurn = (host, sessionId, turn, reason = { kind: 'completed' }) => {
  host.emit(sessionId, 'turn/end', { turn, reason })
}

test('a Bot reply in its own chat pushes a message notification', async (t) => {
  const home = freshHome(t)
  const host = await start(home)

  run(host, 'a', 1, { kind: 'user' })
  assistantText(host, 'a', 'Here is the answer.')
  endTurn(host, 'a', 1)

  assert.deepEqual(host.pushes, [{ kind: 'message', id: 'chat:a', title: 'Chief sent a message' }])
})

test('a turn that answers another Bot routes its reply and does not push', async (t) => {
  const home = freshHome(t)
  const host = await start(home)

  run(host, 'a', 1, { kind: 'bot', role: 'request', exchangeId: 'e1', senderSessionId: 'b', senderName: 'Writer' }, 'Can you check this?')
  assistantText(host, 'a', 'Checked, all fine.')
  endTurn(host, 'a', 1)

  assert.deepEqual(host.pushes, [])
})

test('a member post into a group pushes the room as one slot', async (t) => {
  const home = freshHome(t)
  const host = await start(home)

  await host.rt.postToRoom(host.rt.roomOf('r1'), host.rt.botOf('b'), 'deploy is green')
  await host.rt.postToRoom(host.rt.roomOf('r1'), host.rt.botOf('b'), 'and the report is up')

  assert.deepEqual(host.pushes, [
    { kind: 'message', id: 'room:r1', title: 'Writer in Ops' },
    { kind: 'message', id: 'room:r1', title: 'Writer in Ops' },
  ])
})

test('a wait item still pushes once per pending item', async (t) => {
  const home = freshHome(t)
  const host = await start(home)

  host.rt.pushWait('question', { id: 'q1', botId: 'a' })
  host.rt.pushWait('question', { id: 'q1', botId: 'a' })

  assert.deepEqual(host.pushes, [{ kind: 'question', id: 'q1', title: 'Chief asks a question' }])
})
