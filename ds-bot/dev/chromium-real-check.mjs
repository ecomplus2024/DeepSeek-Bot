// Real check of the Bot-driven Chromium on this machine: resolves the binary (system
// browser, or a downloaded Chrome for Testing with --download), opens a hidden headed
// session (headless with --headless), drives a local page through the shared browse
// driver — navigate, read with [n] marks, click, type, screenshot — proves a killed
// browser relaunches on the same profile, then closes.
// Usage: node dev/chromium-real-check.mjs [--download] [--headless] [--stay]
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChromiumSessions, ensureChromium } from '../src/host/chromium.js'
import { createPageDriver, setWindowShown } from '../src/host/browse.js'

const wantDownload = process.argv.includes('--download')
const wantHeadless = process.argv.includes('--headless')
const home = mkdtempSync(join(tmpdir(), 'ds-bot-chromium-check-'))

// A local page, so the check needs no external site.
const PAGE = `<!doctype html><title>Chromium check</title><body>
<h1>check page</h1>
<a href="#next" id="jump">Jump link</a>
<input id="field" placeholder="type here">
<button id="btn" onclick="document.body.dataset.clicked='yes'">Press me</button>
<p id="tail">end of page</p>
</body>`
const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html')
  response.end(PAGE)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`

const readBounds = async (page) => {
  const cdp = await page.createCDPSession()
  const { bounds } = await cdp.send('Browser.getWindowForTarget')
  return bounds
}

const sessions = createChromiumSessions()
const driver = createPageDriver({ sessions, shotsDir: join(home, 'shots') })
try {
  const binary = await ensureChromium({ home, probe: wantDownload ? () => undefined : undefined })
  console.log('binary:', binary.source, binary.executablePath, binary.buildId ?? '')

  const session = await sessions.open('check', 'real', {
    executablePath: binary.executablePath,
    headless: wantHeadless,
    hidden: !wantHeadless,
    args: [],
    userDataDir: join(home, 'profiles', 'check', 'real'),
  })
  const page = await sessions.pageOf(session)
  if (!wantHeadless) console.log('bounds after hidden open:', JSON.stringify(await readBounds(page)))

  console.log('navigate →', await driver.runStep(session, { action: 'navigate', url }))
  const read = await driver.runStep(session, { action: 'read' })
  console.log('read →', read.split('\n').filter(line => line.startsWith('[')).join(' | '))
  console.log('click [3] →', await driver.runStep(session, { action: 'click', ref: 3 }))
  console.log('clicked flag →', await driver.runStep(session, { action: 'evaluate', script: "document.body.dataset.clicked" }))
  console.log('type [2] →', await driver.runStep(session, { action: 'type', ref: 2, text: 'hello bot' }))
  console.log('field value →', await driver.runStep(session, { action: 'evaluate', script: "document.querySelector('#field').value" }))
  console.log('screenshot →', await driver.runStep(session, { action: 'screenshot' }))

  // Kill the process: the next action must relaunch on the same profile dir, and
  // the fresh browser must still be drivable (the old tab died with the process).
  session.browser.process()?.kill()
  const old = session.browser
  console.log('after kill, navigate →', await driver.runStep(session, { action: 'navigate', url }))
  console.log('after kill, read →', (await driver.runStep(session, { action: 'read' })).includes('check page') ? 'page back (relaunched)' : 'FAILED')
  console.log('relaunched on same profile:', session.browser !== old && session.userDataDir.endsWith(join('check', 'real')) ? 'yes' : 'FAILED')

  if (!wantHeadless) {
    await setWindowShown(session, await sessions.pageOf(session), true)
    await new Promise(resolve => setTimeout(resolve, 800))
    console.log('bounds after show:', JSON.stringify(await readBounds(await sessions.pageOf(session))))
    await setWindowShown(session, await sessions.pageOf(session), false)
    console.log('bounds after hide:', JSON.stringify(await readBounds(await sessions.pageOf(session))))
  }

  if (process.argv.includes('--stay')) {
    console.log('staying open — close it by hand or Ctrl+C')
    await new Promise(() => {})
  }
  await sessions.close(session.id)
  console.log('closed; artifacts under', home)
} catch (error) {
  console.error('FAILED:', error?.message ?? error)
  process.exitCode = 1
} finally {
  await sessions.dispose()
  server.close()
  if (process.exitCode !== 0 || !process.argv.includes('--stay')) {
    try { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) } catch { /* leave it for inspection */ }
  }
}
