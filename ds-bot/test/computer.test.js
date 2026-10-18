import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { MACOS_JXA, WINDOWS_PS1, clickOps, dragOps, keyPlan, parseChord, scrollOps, toScreen } from '../src/host/computer-driver.js'
import { fakeAttachments, fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: 'Writer', instructions: '', createdAt: 2 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const BOUNDS = { left: 0, top: 0, width: 1920, height: 1080 }
// 1920x1080 downscaled to the 1568 cap, the way the drivers report it.
const IMAGE = { width: 1568, height: 882 }

// A 24-bit BMP filled with one byte — what the fake driver writes for grab ops.
function bmpFile(w, h, fill) {
  const stride = Math.ceil((w * 3) / 4) * 4
  const buf = Buffer.alloc(54 + stride * h)
  buf.write('BM')
  buf.writeUInt32LE(buf.length, 2)
  buf.writeUInt32LE(54, 10)
  buf.writeUInt32LE(40, 14)
  buf.writeInt32LE(w, 18)
  buf.writeInt32LE(h, 22)
  buf.writeUInt16LE(1, 26)
  buf.writeUInt16LE(24, 28)
  buf.fill(fill, 54)
  return buf
}

function fakeDriver(recorded, state = {}) {
  return {
    platform: 'win32',
    state,
    async run(ops) {
      recorded.push(...ops)
      return Promise.all(ops.map(async (op) => {
        if (op.op === 'shot') {
          await writeFile(op.path, Buffer.from('fake-jpeg'))
          return { ok: true, ...BOUNDS, image: IMAGE }
        }
        if (op.op === 'screen') return { ok: true, ...BOUNDS }
        if (op.op === 'grab') {
          await writeFile(op.path, op.format === 'jpg' ? Buffer.from('fake-jpeg') : bmpFile(op.w, op.h, state.fill ?? 0))
          return { ok: true, left: op.x, top: op.y, width: op.w, height: op.h }
        }
        return { ok: true }
      }))
    },
  }
}

function fakeTypeSafe(calls, answers) {
  return async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ model: 'jev-1.14.0', answers, usage: { input_tokens: 10, output_tokens: 5 } }) }
  }
}

const FOUND = {
  visible: { type: 'noul', noul: 0.95 },
  where: { type: 'box', box: { top: 0.4, bottom: 0.6, left: 0.4, right: 0.6 }, confidence: 0.9 },
}

function start({ config = {}, ops, calls, answers = FOUND } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-computer-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext({ services: { attachments: fakeAttachments() } })
  const state = { fill: 0 }
  const rt = createRuntime(ctx, { home, computer: { driver: fakeDriver(ops ?? [], state), fetch: fakeTypeSafe(calls ?? [], answers), key: 'ts-test-key', ...config } })
  const stop = async () => {
    await ctx.dispose()
    try { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) } catch { /* a late write keeps the dir */ }
  }
  const tool = (args, agent = 'm1') => ctx.registeredTools.get('use_computer').execute(args, { agent: { id: agent } })
  return { rt, ctx, tool, stop, state }
}

test('a chord parses into canonical names and per-platform codes', () => {
  assert.deepEqual(parseChord(' ctrl+Shift +C '), ['ctrl', 'shift', 'c'])
  assert.deepEqual(parseChord('cmd+v'), ['meta', 'v'])
  assert.throws(() => parseChord('ctrl+'), /not a key chord/)
  assert.throws(() => parseChord('ctrl+bogus'), /No key named "bogus"/)
  assert.deepEqual(keyPlan(['ctrl', 'c'], 'win32'), { codes: [0x11, 0x43], flags: 0 })
  assert.deepEqual(keyPlan(['ctrl', 'shift', 'esc'], 'darwin'), { codes: [0x3B, 0x38, 0x35], flags: 0x40000 | 0x20000 })
  assert.deepEqual(keyPlan(['alt', 'f4'], 'linux'), { chord: 'alt+F4' })
})

test('ops compose clicks, drags and scrolls in screen coordinates', () => {
  const vs = { left: 0, top: 0, width: 1920, height: 1080 }
  const ops = clickOps({ x: 960, y: 540 }, vs, { button: 'right', count: 2 })
  assert.equal(ops.length, 5)
  assert.deepEqual([ops[1].op, ops[1].button, ops[2].op], ['down', 'right', 'up'])
  const drag = dragOps({ x: 0, y: 0 }, { x: 100, y: 50 }, vs)
  assert.equal(drag[0].op, 'move')
  assert.equal(drag.at(-1).op, 'up')
  assert.equal(drag.at(-1).x, 100)
  const scroll = scrollOps({ x: 10, y: 10 }, vs, 'down', 5)
  assert.deepEqual(scroll[1], { op: 'wheel', dx: 0, dy: -5 })
  assert.throws(() => scrollOps({ x: 0, y: 0 }, vs, 'sideways', 1), /direction/)
  assert.throws(() => clickOps({ x: 0, y: 0 }, vs, { button: 'back' }), /No mouse button/)
  assert.deepEqual(toScreen({ left: 0, top: 0, width: 1920, height: 1080, image: IMAGE }, { x: 784, y: 441 }), { x: 960, y: 540 })
})

test('the Windows and macOS drivers carry SendInput and CGEvent scripts', () => {
  assert.match(WINDOWS_PS1, /SendInput/)
  assert.match(WINDOWS_PS1, /CopyFromScreen/)
  assert.match(WINDOWS_PS1, /MOUSEEVENTF|VirtualScreen/)
  assert.match(MACOS_JXA, /CGEventPost/)
  assert.match(MACOS_JXA, /keystroke/)
})

test('screenshot returns the screen image with its size and mapping', async (t) => {
  const ops = []
  const { tool, ctx, stop } = start({ ops })
  t.after(stop)
  const value = await tool({ action: 'screenshot' })
  assert.match(value.text, /1568×882 image of the 1920×1080 screen/)
  assert.equal(value.image.attachmentId, 'sha256:1')
  assert.deepEqual(ops, [{ op: 'shot', path: ops[0].path, max: 1568 }])
  const blocks = ctx.registeredTools.get('use_computer').output.render({}, value)
  assert.equal(blocks[0].type, 'image')
  assert.equal(blocks[1].type, 'text')
})

test('click with target asks TypeSafe for the box and clicks its center', async (t) => {
  const ops = []
  const calls = []
  const { tool, stop } = start({ ops, calls })
  t.after(stop)
  const value = await tool({ action: 'click', target: 'the Save button' })
  assert.match(value.text, /Clicked "the Save button" at screen \(960, 540\)/)
  // shot, the refine grab and the anchor grab, then move + down + up at the box center
  assert.equal(ops[0].op, 'shot')
  assert.deepEqual(ops.filter(op => op.op !== 'shot' && op.op !== 'grab'), [
    { op: 'move', x: 960, y: 540, vs: { left: 0, top: 0, width: 1920, height: 1080 } },
    { op: 'down', x: 960, y: 540, button: 'left' },
    { op: 'up', x: 960, y: 540, button: 'left' },
  ])
  assert.equal(ops.filter(op => op.op === 'grab').length, 2)
  assert.equal(calls.length, 2)
  const { url, init } = calls[0]
  assert.equal(url, 'https://api.typesafe.ai/v1/systemone')
  assert.equal(init.headers['TypeSafe-Danger-Zone-Images'], 'true')
  assert.equal(init.headers.authorization, 'Bearer ts-test-key')
  const body = JSON.parse(init.body)
  assert.equal(body.model, 'jev-preview')
  assert.equal(body.questions.where.type, 'box')
  assert.equal(body.questions.visible.type, 'noul')
})

test('click refuses a target TypeSafe says is not visible', async (t) => {
  const ops = []
  const { tool, stop } = start({ ops, answers: { visible: { type: 'noul', noul: 0.1 }, where: FOUND.where } })
  t.after(stop)
  const value = await tool({ action: 'click', target: 'the Save button' })
  assert.match(value.text, /not visible on the screen \(visibility 0\.10\)/)
  assert.equal(ops.filter(op => op.op !== 'shot').length, 0)
})

test('click refuses a low-confidence box instead of landing blind', async (t) => {
  const ops = []
  const { tool, stop } = start({ ops, answers: { visible: FOUND.visible, where: { type: 'box', box: FOUND.where.box, confidence: 0.2 } } })
  t.after(stop)
  const value = await tool({ action: 'click', target: 'the Save button' })
  assert.match(value.text, /not sure enough to act on it \(confidence 0\.20/)
  assert.equal(ops.every(op => op.op === 'shot' || op.op === 'grab'), true)
})

test('click with x and y uses the screenshot mapping', async (t) => {
  const ops = []
  const { tool, stop } = start({ ops })
  t.after(stop)
  const value = await tool({ action: 'click', x: 784, y: 441 })
  assert.match(value.text, /No screenshot yet/)
  await tool({ action: 'screenshot' })
  ops.length = 0
  const clicked = await tool({ action: 'click', x: 784, y: 441 })
  assert.match(clicked.text, /Clicked \(784, 441\) at screen \(960, 540\)/)
  assert.equal(ops[0].op, 'move')
})

test('find reports the element position without touching the pointer', async (t) => {
  const ops = []
  const { tool, stop } = start({ ops })
  t.after(stop)
  const value = await tool({ action: 'find', target: 'the search box' })
  assert.match(value.text, /Found "the search box": image \(784, 441\), screen \(960, 540\), confidence 0\.90/)
  assert.equal(ops.every(op => op.op === 'shot' || op.op === 'grab'), true)
})

test('type clicks the target first and sends one text op', async (t) => {
  const ops = []
  const { tool, stop } = start({ ops })
  t.after(stop)
  const value = await tool({ action: 'type', target: 'the name field', text: 'Ada' })
  assert.match(value.text, /Clicked "the name field", then typed 3 characters/)
  assert.deepEqual(ops.at(-1), { op: 'text', text: 'Ada' })
})

test('key sends one press op with the platform codes', async (t) => {
  const ops = []
  const { tool, stop } = start({ ops })
  t.after(stop)
  const value = await tool({ action: 'key', keys: 'ctrl+shift+esc' })
  assert.match(value.text, /Pressed ctrl\+shift\+esc/)
  assert.deepEqual(ops.at(-1), { op: 'press', codes: [0x11, 0x10, 0x1B], flags: 0 })
})

test('steps run in order and stop at the first failure', async (t) => {
  const ops = []
  const { tool, stop } = start({ ops })
  t.after(stop)
  await tool({ action: 'screenshot' })
  ops.length = 0
  const value = await tool({
    action: 'steps',
    steps: [
      { action: 'click', x: 10, y: 20 },
      { action: 'type', text: 'hi' },
      { action: 'bogus' },
      { action: 'key', keys: 'enter' },
    ],
  })
  assert.match(value.text, /Stopped at step 3 of 4/)
  assert.match(value.text, /3\. bogus failed: Unknown action/)
  assert.equal(ops.some(op => op.op === 'press'), false)
})

test('a second Bot waits while one drives, and release frees it', async (t) => {
  const { tool, stop } = start({})
  t.after(stop)
  await tool({ action: 'screenshot' }, 'm1')
  const busy = await tool({ action: 'screenshot' }, 'b2')
  assert.match(busy.text, /being driven by Chief/)
  const wrong = await tool({ action: 'release' }, 'b2')
  assert.match(wrong.text, /you are not driving it/)
  const freed = await tool({ action: 'release' }, 'm1')
  assert.match(freed.text, /computer is free now \(You were driving\)/)
  const value = await tool({ action: 'screenshot' }, 'b2')
  assert.match(value.text, /1920×1080 screen/)
})

test('a Main Bot takes the computer over', async (t) => {
  const { tool, stop } = start({})
  t.after(stop)
  await tool({ action: 'screenshot' }, 'b2')
  const value = await tool({ action: 'screenshot' }, 'm1')
  assert.match(value.text, /1920×1080 screen/)
})

test('finding without the key names the secret to request', async (t) => {
  const ops = []
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-computer-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext({ services: { attachments: fakeAttachments() } })
  createRuntime(ctx, { home, computer: { driver: fakeDriver(ops), fetch: fakeTypeSafe([], {}) } })
  t.after(async () => {
    await ctx.dispose()
    try { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) } catch { /* a late write keeps the dir */ }
  })
  const value = await ctx.registeredTools.get('use_computer').execute({ action: 'click', target: 'x' }, { agent: { id: 'm1' } })
  assert.match(value.text, /needs TYPESAFE_API_KEY saved for you.*request_secret/s)
  assert.equal(ops.length, 0)
})

test('the tool is absent outside the Desktop profile', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-computer-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext({})
  createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    try { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) } catch { /* a late write keeps the dir */ }
  })
  assert.equal(ctx.registeredTools.has('use_computer'), false)
})

test('a repeated target clicks the remembered spot with no TypeSafe call', async (t) => {
  const ops = []
  const calls = []
  const { tool, stop } = start({ ops, calls })
  t.after(stop)
  await tool({ action: 'click', target: 'the Save button' })
  assert.equal(calls.length, 2)
  ops.length = 0
  const value = await tool({ action: 'click', target: 'the Save button' })
  assert.match(value.text, /Clicked "the Save button" at screen \(960, 540\)/)
  assert.equal(calls.length, 2)
  assert.deepEqual(ops.map(op => op.op), ['grab', 'move', 'down', 'up'])
  assert.equal(ops[0].format, 'bmp')
})

test('a changed spot makes the target locate from scratch', async (t) => {
  const ops = []
  const calls = []
  const { tool, stop, state } = start({ ops, calls })
  t.after(stop)
  await tool({ action: 'click', target: 'the Save button' })
  state.fill = 40
  const value = await tool({ action: 'click', target: 'the Save button' })
  assert.match(value.text, /Clicked "the Save button" at screen \(960, 540\)/)
  assert.equal(calls.length, 4)
  assert.equal(ops.filter(op => op.op === 'shot').length, 2)
})

test('relook ignores the remembered spot', async (t) => {
  const ops = []
  const calls = []
  const { tool, stop } = start({ ops, calls })
  t.after(stop)
  await tool({ action: 'click', target: 'the Save button' })
  const value = await tool({ action: 'click', target: 'the Save button', relook: true })
  assert.match(value.text, /Clicked "the Save button" at screen \(960, 540\)/)
  assert.equal(calls.length, 4)
  assert.equal(ops.filter(op => op.op === 'shot').length, 2)
})

test('a TypeSafe failure answers in words', async (t) => {
  const ops = []
  const failing = async () => ({ ok: false, status: 503, json: async () => ({ error: 'overloaded' }) })
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-computer-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext({ services: { attachments: fakeAttachments() } })
  createRuntime(ctx, { home, computer: { driver: fakeDriver(ops), fetch: failing, key: 'k' } })
  t.after(async () => {
    await ctx.dispose()
    try { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) } catch { /* a late write keeps the dir */ }
  })
  const value = await ctx.registeredTools.get('use_computer').execute({ action: 'find', target: 'the Save button' }, { agent: { id: 'm1' } })
  assert.match(value.text, /TypeSafe answered 503: overloaded/)
})
