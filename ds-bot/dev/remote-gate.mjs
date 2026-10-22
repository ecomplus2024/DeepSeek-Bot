#!/usr/bin/env node
// Remote gate: a space-PIN login page in front of a loopback DS Bot web, so the
// team can be shared over LAN or the Internet without handing out dsh's token.
//
//   dsh web stays bound to 127.0.0.1; this proxy listens on the LAN address.
//   Loopback clients pass straight through — on the host machine there is no
//   PIN page and no token to paste, the gate injects the upstream session.
//   A remote visitor enters any space PIN (Settings → Bots → Spaces); the gate
//   asks the upstream /api/bot which space it belongs to, then proxies
//   everything. The matching space arrives unlocked through a cookie.
//
//   GATE_LISTEN   default 0.0.0.0:8390 — where remote users connect; can be the
//     old dsh port when the upstream moves to another loopback port
//   GATE_UPSTREAM default http://127.0.0.1:3090 — the loopback dsh web
//   GATE_TOKEN / GATE_TOKEN_FILE — the launch token from "dsh web: …?token=";
//     a file is re-read whenever the upstream session expires, so keeping the
//     dsh log at a stable path survives dsh restarts
//   GATE_SESSION_DAYS default 30 — how long a remote browser stays unlocked
//
// This is a soft boundary for trusted coworkers, not tenant isolation: anyone
// who can reach the loopback port directly still bypasses it, and space locks
// remain display-level inside DS Bot.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { connect as connectSocket } from 'node:net'

const LISTEN = process.env.GATE_LISTEN ?? '0.0.0.0:8390'
const UPSTREAM = process.env.GATE_UPSTREAM ?? 'http://127.0.0.1:3090'
const SESSION_MS = Math.max(1, Number(process.env.GATE_SESSION_DAYS ?? 30)) * 86_400_000
const FAIL_LIMIT = 5
const FAIL_COOLDOWN_MS = 60_000

const SECRET = randomBytes(32)
const COOKIE = 'dsg-session'
const UNLOCK_COOKIE = 'ds-bot-unlocked'

// -- upstream session ------------------------------------------------------

let upstreamCookie = null

async function launchToken() {
  if (process.env.GATE_TOKEN) return process.env.GATE_TOKEN.trim()
  const file = process.env.GATE_TOKEN_FILE
  if (!file) return null
  const text = await readFile(file, 'utf8').catch(() => '')
  return /[?&]token=([^\s"']+)/.exec(text)?.[1] ?? null
}

// Mint the upstream browser cookie once, refresh only when it stops working.
async function upstreamSession(force = false) {
  if (upstreamCookie !== null && !force) return upstreamCookie
  const token = await launchToken()
  if (token === null) throw new Error('no launch token: set GATE_TOKEN or GATE_TOKEN_FILE')
  const response = await fetch(`${UPSTREAM}/?token=${token}`, { redirect: 'manual' })
  const setCookie = response.headers.get('set-cookie') ?? ''
  upstreamCookie = setCookie.split(';')[0] || null
  if (upstreamCookie === null) throw new Error(`upstream refused the token (HTTP ${response.status})`)
  return upstreamCookie
}

async function api(endpoint, payload) {
  const cookie = await upstreamSession()
  const ask = (auth) => fetch(`${UPSTREAM}/api/bot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: auth },
    body: JSON.stringify({ endpoint, payload }),
  })
  let response = await ask(cookie)
  if (response.status === 401) response = await ask(await upstreamSession(true))
  if (!response.ok) throw new Error(`upstream api returned HTTP ${response.status}`)
  return (await response.json()).value
}

// -- gate session ----------------------------------------------------------

const sign = expiresAt => createHmac('sha256', SECRET).update(String(expiresAt)).digest('base64url')

const sessionOf = (headers) => {
  const raw = /(?:^|;\s*)dsg-session=([^;]+)/.exec(headers.cookie ?? '')?.[1]
  if (!raw) return false
  const [stamp, mac] = Buffer.from(raw, 'base64url').toString('utf8').split('.')
  const expiresAt = Number(stamp)
  return Number.isSafeInteger(expiresAt) && expiresAt > Date.now()
    && timingSafeEqual(Buffer.from(mac ?? '', 'utf8'), Buffer.from(sign(expiresAt), 'utf8'))
}

// Loopback peers are the host machine itself: they never see the PIN page.
const isLoopback = ip => ip === '::1' || ip === '::ffff:127.0.0.1' || (ip ?? '').startsWith('127.')

// Per-IP failure bookkeeping; a locked space PIN is cheap to guess without it.
const attempts = new Map()
const pinAllowed = (ip) => {
  const entry = attempts.get(ip)
  if (entry === undefined) return true
  if (entry.until > Date.now()) return false
  if (entry.fails >= FAIL_LIMIT) { attempts.delete(ip); return true }
  return true
}
const pinFailed = (ip) => {
  const entry = attempts.get(ip) ?? { fails: 0, until: 0 }
  entry.fails += 1
  if (entry.fails >= FAIL_LIMIT) entry.until = Date.now() + FAIL_COOLDOWN_MS
  attempts.set(ip, entry)
}
const pinPassed = ip => attempts.delete(ip)

// -- pages and proxy -------------------------------------------------------

const FORM = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DS Bot</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f6f8;color:#1c1f26;font:14px/1.5 system-ui,sans-serif}
form{width:min(320px,90vw);padding:28px;background:#fff;border:1px solid #e3e5ea;border-radius:14px;box-shadow:0 8px 30px #0001}
h1{margin:0 0 4px;font-size:17px}p{margin:0 0 16px;color:#6b7280;font-size:13px}
input{width:100%;box-sizing:border-box;padding:10px 12px;margin-bottom:12px;border:1px solid #d4d7dd;border-radius:8px;font:inherit}
button{width:100%;padding:10px;border:0;border-radius:8px;background:#4d6bfe;color:#fff;font:inherit;font-weight:600;cursor:pointer}
.err{color:#c4314b;font-size:12.5px;min-height:18px;margin:-6px 0 10px}
</style>
<form method="post" action="/unlock">
<h1>DS Bot</h1><p>Enter your space PIN to continue.</p>
<input name="pin" type="password" autocomplete="current-password" autofocus required>
<div class="err">{{ERROR}}</div>
<button type="submit">Continue</button>
</form>`

const send = (res, status, headers, body) => { res.writeHead(status, headers); res.end(body) }
const form = (res, error = '') => send(res, 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, FORM.replace('{{ERROR}}', error))

const HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'cookie'])

function proxy(req, res, cookie) {
  const headers = { ...req.headers }
  for (const name of Object.keys(headers)) if (HOP_HEADERS.has(name.toLowerCase())) delete headers[name]
  headers.host = new URL(UPSTREAM).host
  headers.cookie = [cookie, req.headers.cookie ?? ''].filter(Boolean).join('; ')
  const upstream = httpRequest(UPSTREAM + req.url, { method: req.method, headers }, (answer) => {
    const out = { ...answer.headers }
    delete out['content-length'] // the client agent re-frames; compression varies per hop
    res.writeHead(answer.statusCode ?? 502, out)
    answer.pipe(res)
  })
  upstream.on('error', () => send(res, 502, { 'content-type': 'text/plain' }, 'DS Bot upstream is not reachable.'))
  req.pipe(upstream)
}

// -- server ----------------------------------------------------------------

const readBody = req => new Promise((resolve) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
})

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://gate.invalid')
  try {
    if (req.method === 'POST' && url.pathname === '/unlock') {
      const ip = req.socket.remoteAddress ?? ''
      if (!pinAllowed(ip)) return form(res, 'Too many tries. Wait a minute.')
      const pin = new URLSearchParams(await readBody(req)).get('pin') ?? ''
      const spaceId = pin === '' ? null : await api('check-space-pin', { pin })
      if (typeof spaceId !== 'string' || spaceId === '') { pinFailed(ip); return form(res, 'Wrong PIN.') }
      pinPassed(ip)
      const expiresAt = Date.now() + SESSION_MS
      const session = Buffer.from(`${expiresAt}.${sign(expiresAt)}`).toString('base64url')
      const age = Math.floor(SESSION_MS / 1000)
      return send(res, 303, {
        location: '/',
        'set-cookie': [
          `${COOKIE}=${session}; Max-Age=${age}; Path=/; HttpOnly; SameSite=Lax`,
          `${UNLOCK_COOKIE}=${spaceId}; Max-Age=${age}; Path=/; SameSite=Lax`,
        ],
      })
    }
    if (!isLoopback(req.socket.remoteAddress) && !sessionOf(req.headers)) {
      if (req.method === 'GET' && url.pathname === '/') return form(res)
      return send(res, 401, { 'content-type': 'text/plain; charset=utf-8' }, 'PIN required.\n')
    }
    proxy(req, res, await upstreamSession())
  } catch (error) {
    send(res, 502, { 'content-type': 'text/plain; charset=utf-8' }, `${error.message}\n`)
  }
})

// WebSocket/upgrade paths (terminal, live views) tunnel straight through.
server.on('upgrade', async (req, socket, head) => {
  try {
    if (!isLoopback(req.socket.remoteAddress) && !sessionOf(req.headers)) return socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
    const headers = { ...req.headers, host: new URL(UPSTREAM).host, cookie: [await upstreamSession(), req.headers.cookie ?? ''].filter(Boolean).join('; ') }
    const target = new URL(UPSTREAM)
    const upstream = connectSocket({ host: target.hostname, port: Number(target.port || 80) })
    upstream.on('connect', () => {
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n`)
      for (const [name, value] of Object.entries(headers)) upstream.write(`${name}: ${value}\r\n`)
      upstream.write('\r\n')
      if (head?.length) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    upstream.on('error', () => socket.end())
  } catch { socket.end() }
})

const [host, port] = LISTEN.includes(':') ? [LISTEN.slice(0, LISTEN.lastIndexOf(':')), Number(LISTEN.slice(LISTEN.lastIndexOf(':') + 1))] : ['0.0.0.0', Number(LISTEN)]
server.listen(port, host, () => console.log(`ds-bot remote gate: http://${LISTEN}  →  ${UPSTREAM}`))
