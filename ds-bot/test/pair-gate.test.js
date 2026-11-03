import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install } from '../src/host/pwa.js'
import { fakeContext } from './fake-ctx.js'

// A dsh web stand-in: index asks for the dsh session cookie, mints it when the
// launch token arrives, and serves the page while the cookie holds.
function fakeDsh() {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.searchParams.get('token') === 'launch-token') {
      res.writeHead(303, { location: './', 'set-cookie': 'dsh=1; Path=/; HttpOnly' })
      res.end()
      return
    }
    if (String(req.headers.cookie ?? '').split(';').some(part => part.trim() === 'dsh=1')) {
      res.writeHead(200)
      res.end('app')
      return
    }
    res.writeHead(401)
    res.end('auth required')
  })
}

// A remote client: the gate only engages when the Host authority is not
// loopback, so requests carry a public Host header while connecting locally.
function call(port, { path = '/', host = 'app.example', method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method, headers: { Host: host, ...headers }, setHost: false },
      (res) => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const cookies = response => [].concat(response.headers['set-cookie'] ?? [])

async function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-gate-'))
  const upstream = fakeDsh()
  await new Promise(done => upstream.listen(0, '127.0.0.1', done))
  const probe = createServer()
  await new Promise(done => probe.listen(0, '127.0.0.1', done))
  const pairPort = probe.address().port
  await new Promise(done => probe.close(done))
  const web = { port: upstream.address().port, register: () => () => {}, tapIndex: () => () => {} }
  const ctx = fakeContext({ services: { webServer: web } })
  ctx.connection.authenticatedUrl = base => `${base}?token=launch-token`
  const rt = { ctx, home, config: { pairPort }, warn: () => {} }
  install(rt)
  // The gate listens inside an async effect; wait for the port to answer.
  for (let tries = 0; ; tries++) {
    try { await call(pairPort); break } catch (error) {
      if (tries > 50) throw error
      await new Promise(done => setTimeout(done, 20))
    }
  }
  t.after(async () => { await ctx.dispose(); upstream.close(); rmSync(home, { recursive: true, force: true }) })
  return { rt, pairPort }
}

async function pair(rt, pairPort) {
  const { pin } = rt.pairMint()
  const response = await call(pairPort, {
    path: '/pair',
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `pin=${pin.replace(' ', '')}&next=/`,
  })
  assert.equal(response.status, 303)
  const cookie = cookies(response).find(value => value.startsWith('dsb_pair='))
  assert.ok(cookie !== undefined)
  return cookie
}

test('remote requests get the PIN form and pairing mints a SameSite=Lax cookie', async (t) => {
  const { rt, pairPort } = await start(t)
  const locked = await call(pairPort)
  assert.equal(locked.status, 401)
  assert.match(locked.body, /Pair this device/)

  const denied = await call(pairPort, { method: 'POST', path: '/api/bot' })
  assert.equal(denied.status, 403)

  const cookie = await pair(rt, pairPort)
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Lax/)
})

test('a cold launch past the gate re-mints the dsh cookie without user input', async (t) => {
  const { rt, pairPort } = await start(t)
  const cookie = (await pair(rt, pairPort)).split(';')[0]

  // An installed app's cold launch is a cross-site navigation: the Lax gate
  // cookie rides along, the Strict dsh cookie does not — the gate's token
  // replay answers the 401 and dsh mints a fresh session cookie.
  const cold = await call(pairPort, { headers: { cookie } })
  assert.equal(cold.status, 303)
  const setCookies = cookies(cold)
  assert.ok(setCookies.some(value => value.startsWith('dsh=1')))
  assert.ok(setCookies.some(value => value.startsWith('dsb_pair=') && value.includes('SameSite=Lax')))

  // The redirect's follow-up request is a same-site navigation carrying both.
  const warm = await call(pairPort, { headers: { cookie: `${cookie}; dsh=1` } })
  assert.equal(warm.status, 200)
  assert.equal(warm.body, 'app')
})

test('a stored Strict cookie is rewritten to Lax on an authed response', async (t) => {
  const { rt, pairPort } = await start(t)
  const cookie = (await pair(rt, pairPort)).split(';')[0]
  const response = await call(pairPort, { headers: { cookie: `${cookie}; dsh=1` } })
  assert.equal(response.status, 200)
  const refresh = cookies(response).find(value => value.startsWith('dsb_pair='))
  assert.ok(refresh !== undefined)
  assert.match(refresh, /SameSite=Lax/)
})

test('loopback requests bypass the gate entirely', async (t) => {
  const { pairPort } = await start(t)
  const response = await call(pairPort, { host: 'localhost' })
  // Proxied verbatim: this is the upstream's own 401, not the PIN form.
  assert.equal(response.status, 401)
  assert.equal(response.body, 'auth required')
})
