// End-to-end check of the gemlogin tools against the real GemLogin app: registers the
// plugin runtime in a fake context (same as the unit tests) but with the real local
// API and real puppeteer. Opens a profile hidden, proves the OS window is minimized,
// shows it, hides it again, takes a shot, and closes it.
// Usage: node dev/gemlogin-live-tool.mjs <profileId>
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../index.js'
import { fakeContext } from '../test/fake-ctx.js'

const profileId = process.argv[2]
if (profileId === undefined) { console.error('usage: node dev/gemlogin-live-tool.mjs <profileId>'); process.exit(2) }

const TEAM = {
  version: 1, mainBotId: 'm1', revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: 'Writer', instructions: '', createdAt: 2 },
  },
  rooms: {}, exchanges: [], exchangeTurns: {}, questions: {},
}

const home = mkdtempSync(join(tmpdir(), 'ds-bot-live-'))
writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
const ctx = fakeContext({})
const rt = createRuntime(ctx, { home })
const tool = (name, args, agent) => ctx.registeredTools.get(name).execute(args, { agent: { id: agent } })
const sleep = ms => new Promise(r => setTimeout(r, ms))

try {
  console.log('== open hidden ==')
  console.log(await tool('gemlogin_open', { profile: profileId }, 'b2'))
  await sleep(2000)
  console.log('list:', JSON.stringify(await rt.gemLoginList('b2')))
  await sleep(3000)
  console.log('list +3s:', JSON.stringify(await rt.gemLoginList('b2')))

  console.log('== show ==')
  console.log(await tool('gemlogin_browse', { action: 'show' }, 'b2'))
  await sleep(1500)
  console.log('after show:', JSON.stringify(await rt.gemLoginList('b2')))

  console.log('== hide ==')
  console.log(await tool('gemlogin_browse', { action: 'hide' }, 'b2'))
  await sleep(1500)
  console.log('after hide:', JSON.stringify(await rt.gemLoginList('b2')))

  const shot = await rt.gemLoginShot('b2', profileId)
  console.log('shot:', shot.image === null ? 'null' : `${shot.image.length} chars`, 'hidden:', shot.hidden)

  console.log('== close ==')
  console.log(await tool('gemlogin_close', {}, 'b2'))
} finally {
  await ctx.dispose()
  try { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) } catch { /* late write */ }
}
