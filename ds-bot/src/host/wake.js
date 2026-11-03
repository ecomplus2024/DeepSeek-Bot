// Local wake-up calls: a tiny localhost-only HTTP listener that lets a trusted
// script on this same machine queue a follow-up into a Bot's own chat — the
// same `sessionController.prompt(..., { mode: 'queue' })` the GUI Send button
// uses. DSH's own /api/bot needs the browser's signed cookie, which an outside
// script cannot mint; this listener binds 127.0.0.1 only and checks a shared
// secret from a file, so only local processes that can read the file get in.
//
// Usage (PowerShell):
//   $secret = (Get-Content "$env:USERPROFILE\.dsh\bot\wake-secret.txt" -Raw).Trim()
//   Invoke-RestMethod -Uri 'http://127.0.0.1:3099/wake' -Method Post `
//     -Headers @{ 'x-wake-secret' = $secret } -ContentType 'application/json' `
//     -Body (@{ botId = 'session-...'; text = '...' } | ConvertTo-Json)
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { chmod, readFile, writeFile } from 'node:fs/promises'

export const WAKE_PORT = 3099
const SECRET_FILE = 'wake-secret.txt'
const MAX_BODY_BYTES = 64 * 1024

export function install(rt) {
  const { ctx } = rt
  let server = null
  let secret = ''
  let stopped = false

  const sameSecret = (given) => {
    const a = Buffer.from(String(given ?? ''))
    const b = Buffer.from(secret)
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
  }

  const readBody = (request) => new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })

  async function handle(request, response) {
    try {
      if (request.method !== 'POST' || new URL(request.url ?? '/', 'http://127.0.0.1').pathname !== '/wake') {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end('{"ok":false,"error":"Not found"}')
        return
      }
      // Defense in depth: the socket itself must be loopback, not just the bind.
      const remote = String(request.socket?.remoteAddress ?? '')
      if (remote !== '127.0.0.1' && remote !== '::127.0.0.1' && remote !== '::ffff:127.0.0.1' && remote !== '::1') {
        response.writeHead(403, { 'content-type': 'application/json' })
        response.end('{"ok":false,"error":"Loopback only"}')
        return
      }
      if (!sameSecret(request.headers['x-wake-secret'])) {
        response.writeHead(403, { 'content-type': 'application/json' })
        response.end('{"ok":false,"error":"Bad secret"}')
        return
      }
      let body
      try {
        body = JSON.parse(await readBody(request))
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end('{"ok":false,"error":"Bad JSON"}')
        return
      }
      const botId = String(body?.botId ?? '')
      const text = String(body?.text ?? '').trim()
      const bot = rt.botOf(botId)
      if (bot === undefined || text === '') {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end('{"ok":false,"error":"Need a known botId and non-empty text"}')
        return
      }
      await rt.load()
      await rt.ensureCapabilities(rt.chatOf(botId))
      await ctx.sessionController.prompt({
        requestId: randomUUID(),
        sessionId: rt.chatOf(botId),
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, AbortSignal.timeout(30_000))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, value: { bot: bot.name } }))
    } catch (error) {
      rt.warn('ds-bot: wake call failed: %s', String(error?.message ?? error).slice(0, 200))
      try {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end('{"ok":false,"error":"Wake failed"}')
      } catch {}
    }
  }

  async function start() {
    if (stopped) return
    const path = join(rt.home, SECRET_FILE)
    try {
      secret = String(await readFile(path, 'utf8')).trim()
    } catch {
      secret = ''
    }
    if (secret === '') {
      secret = randomBytes(32).toString('hex')
      try {
        await writeFile(path, `${secret}\n`, { encoding: 'utf8', mode: 0o600 })
        await chmod(path, 0o600).catch(() => {})
      } catch (error) {
        rt.warn('ds-bot: cannot save the wake secret (%s); the wake listener stays off', error?.code ?? error)
        return
      }
    }
    await new Promise((resolve) => {
      server = createServer(handle)
      server.on('error', (error) => {
        rt.warn('ds-bot: wake listener failed: %s', String(error?.message ?? error).slice(0, 200))
        server = null
        resolve()
      })
      // 127.0.0.1 only: never exposed to the network.
      server.listen(WAKE_PORT, '127.0.0.1', resolve)
    })
  }

  if (rt.config.wake !== false) {
    ctx.effect(() => {
      stopped = false
      void start()
      return () => {
        stopped = true
        try { server?.close() } catch {}
        server = null
      }
    }, 'ds-bot: wake')
  }

  Object.assign(rt, { wakePort: WAKE_PORT })
}
