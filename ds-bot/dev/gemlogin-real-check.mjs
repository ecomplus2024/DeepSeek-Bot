// Real check against a running GemLogin app: open one profile, read the actual OS
// window bounds through CDP, hide it, then watch whether GemLogin moves it back.
// Usage: node dev/gemlogin-real-check.mjs <profileId> [--stay]
import { createGemApi, createGemSessions, setWindowShown } from '../src/host/gemlogin.js'

const profileId = process.argv[2]
if (profileId === undefined) { console.error('usage: node dev/gemlogin-real-check.mjs <profileId>'); process.exit(2) }

const api = createGemApi({ base: 'http://localhost:1010' })
const sessions = createGemSessions({ api })

const readBounds = async (page) => {
  const cdp = await page.createCDPSession()
  const { windowId, bounds } = await cdp.send('Browser.getWindowForTarget')
  return { cdp, windowId, bounds }
}

try {
  // 1) start exactly the way the tool does: win_pos off-screen
  const session = await sessions.open('check', { id: String(profileId), name: 'check' }, { winPos: '-32000,-32000' })
  const page = await sessions.pageOf(session)
  const win1 = await readBounds(page)
  console.log('after start with win_pos=-32000:', JSON.stringify(win1.bounds))

  // 2) hide through CDP like the tool does
  await win1.cdp.send('Browser.setWindowBounds', { windowId: win1.windowId, bounds: { windowState: 'normal', left: -32000, top: -32000, width: 1280, height: 800 } })
  for (const wait of [500, 1500, 3000, 5000]) {
    await new Promise(r => setTimeout(r, wait))
    const { bounds } = await readBounds(page)
    console.log(`bounds +${wait}ms after CDP hide:`, JSON.stringify(bounds))
  }

  // 3) the module's own hide: a sane restore position, then minimized. Watch, take a
  // screenshot while hidden, then show again and prove where the window lands.
  await setWindowShown(session, page, false)
  for (const wait of [1000, 3000]) {
    await new Promise(r => setTimeout(r, wait))
    const { bounds } = await readBounds(page)
    console.log(`bounds +${wait}ms after hide:`, JSON.stringify(bounds))
  }
  const shot = await page.screenshot({ type: 'jpeg', quality: 60 })
  console.log('screenshot while hidden:', shot.length, 'bytes')
  await setWindowShown(session, page, true)
  await new Promise(r => setTimeout(r, 1000))
  const { bounds: restored } = await readBounds(page)
  console.log('shown bounds:', JSON.stringify(restored))

  if (process.argv.includes('--stay')) {
    console.log('staying open — close it by hand or Ctrl+C')
    await new Promise(() => {})
  }
  await sessions.close(session.id)
  console.log('closed')
} catch (error) {
  console.error('FAILED:', error?.message ?? error)
  process.exitCode = 1
  await sessions.dispose()
}
