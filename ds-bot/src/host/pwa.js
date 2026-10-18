// PWA on the Web host: manifest, icons and the service worker, index meta, the
// pairing gate for remote devices, and Web Push for "a Bot is waiting" notes.
// All web pieces skip quietly when no webServer exists, so Desktop is untouched.
import { randomUUID, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { connect as connectSocket } from 'node:net'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ICONS_DIR = join(HERE, 'pwa')
const ICONS = new Set(['icon-192.png', 'icon-512.png', 'icon-maskable-192.png', 'icon-maskable-512.png'])
const SW_FILE = join(ICONS_DIR, 'sw.js')

const THEME = '#4d6bfe'
const MANIFEST = {
  name: 'DS Bot',
  short_name: 'DS Bot',
  description: 'A team of long-lived Bots on DeepSeek Harness',
  // start_url/scope resolve against the manifest URL (/ds-bot/), so they must
  // be absolute — a relative one would point the installed app at a 404.
  id: '/',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'portrait',
  theme_color: THEME,
  background_color: '#ffffff',
  icons: [
    { src: '/ds-bot/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/ds-bot/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/ds-bot/icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
    { src: '/ds-bot/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}
const META = [
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
  '<meta name="apple-mobile-web-app-title" content="DS Bot">',
  `<meta name="theme-color" content="${THEME}">`,
  '<link rel="manifest" href="/ds-bot/manifest.webmanifest">',
  '<link rel="apple-touch-icon" href="/ds-bot/icons/icon-192.png">',
].join('')

// --- small shared helpers ---------------------------------------------------

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return undefined }
}
// Same write pattern as secrets.json: temp file, 0o600, rename.
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
    await chmod(temp, 0o600).catch(() => {})
    await rename(temp, path)
  } catch (error) {
    try { await unlink(temp) } catch { /* temp may be gone */ }
    throw error
  }
}
const reply = (res, status, type, body) => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-cache' })
  res.end(body)
}

// --- pairing gate ------------------------------------------------------------
// The gate listens on its own port in front of dsh web. A remote device first
// proves itself with a PIN that only the locally signed-in UI can see and gets
// a signed cookie of its own. dsh's own token exchange still runs, but the gate
// answers it invisibly, so pairing is the only step a remote user ever takes.

const GATE_COOKIE = 'dsb_pair'
const PIN_TTL_MS = 5 * 60_000
const PIN_COOLDOWN_MS = 60_000
const PIN_ATTEMPTS = 5
const GATE_COOKIE_TTL_MS = 30 * 24 * 3600_000

const b64url = bytes => Buffer.from(bytes).toString('base64url')
const sign = (secret, body) => createHmac('sha256', secret).update(body).digest()

function gateCookie(secret) {
  const body = b64url(JSON.stringify({ v: 1, iat: Date.now(), exp: Date.now() + GATE_COOKIE_TTL_MS }))
  return `v1.${body}.${b64url(sign(secret, body))}`
}
function gateCookieValid(secret, value) {
  const [version, body, signature] = String(value ?? '').split('.')
  if (version !== 'v1' || !body || !signature) return false
  const actual = Buffer.from(signature, 'base64url')
  const expected = sign(secret, body)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')).exp > Date.now() } catch { return false }
}
const cookieOf = (req, name) => {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at !== -1 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim()
  }
}

const PIN_FORM = (pinReady, error, next) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>DS Bot — Pair this device</title>
<style>
body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#f4f6ff;font:16px/1.5 system-ui,sans-serif;color:#141416}
form{background:#fff;padding:28px 24px;border-radius:16px;box-shadow:0 8px 30px #4d6bfe18;max-width:320px;width:calc(100% - 48px)}
h1{font-size:18px;margin:0 0 4px}p{font-size:13px;color:#55585f;margin:0 0 16px}
input{width:100%;box-sizing:border-box;font-size:24px;letter-spacing:.5em;text-align:center;padding:10px;border:1.5px solid #d7dae3;border-radius:10px}
input:focus{outline:none;border-color:${THEME}}
button{width:100%;margin-top:14px;padding:12px;font-size:16px;border:0;border-radius:10px;background:${THEME};color:#fff}
.err{color:#c02c2c;font-size:13px;margin:10px 0 0}
</style></head><body>
<form method="post" action="/pair" autocomplete="off">
<h1>Pair this device</h1>
<p>Enter the 6-digit PIN shown in DS Bot on the computer you are pairing with.</p>
${pinReady
  ? `<input type="hidden" name="next" value="${next}"><input name="pin" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="••••••" required autofocus><button type="submit">Pair</button>`
  : '<p class="err">No PIN yet. On the computer, open Settings → This device → Pair a device and generate one, then reload this page.</p>'}
${error ? `<p class="err">${error}</p>` : ''}
</form></body></html>`

// --- web push ----------------------------------------------------------------
// VAPID keys and subscriptions live in push.json (mode 600), never in state.json,
// a prompt, or a conversation. Payloads stay minimal: who waits, and why.

const PUSH_TITLES = {
  question: name => `${name} asks a question`,
  approval: name => `${name} asks for approval`,
  secret: name => `${name} asks for a key`,
}

export function install(rt) {
  const { ctx, home } = rt
  const pushPath = join(home, 'push.json')
  const gatePath = join(home, 'pair-gate.json')

  let webpush = null
  /** @type {{publicKey:string, privateKey:string} | null} */
  let vapid = null
  /** @type {Map<string, {endpoint:string, keys:{p256dh:string, auth:string}, at:number}>} */
  const subscriptions = new Map()
  let pushWrite = Promise.resolve()
  const persistPush = () => {
    if (vapid === null) return Promise.resolve()
    const snapshot = { vapid, subscriptions: [...subscriptions.values()] }
    return pushWrite = pushWrite.then(() => writeJson(pushPath, snapshot))
      .catch(error => rt.warn('ds-bot: push.json write failed: %s', error?.message ?? error))
  }
  const pushReady = (async () => {
    try { webpush = (await import('web-push')).default } catch { webpush = null }
    if (webpush === null) return
    let record = await readJson(pushPath)
    if (typeof record?.vapid?.publicKey !== 'string' || typeof record?.vapid?.privateKey !== 'string') {
      record = { vapid: webpush.generateVAPIDKeys(), subscriptions: [] }
      await writeJson(pushPath, record)
        .catch(error => rt.warn('ds-bot: push.json write failed: %s', error?.message ?? error))
    }
    vapid = record.vapid
    webpush.setVapidDetails('mailto:ds-bot@localhost', vapid.publicKey, vapid.privateKey)
    for (const sub of Array.isArray(record.subscriptions) ? record.subscriptions : []) {
      if (typeof sub?.endpoint === 'string') subscriptions.set(sub.endpoint, sub)
    }
  })()

  const dropSub = (endpoint) => {
    if (subscriptions.delete(endpoint)) void persistPush()
  }
  // A pending item (question card, approval, secret request) pushes once.
  const noted = new Set()
  rt.pushWait = (kind, info) => {
    const key = `${kind}:${info?.id}`
    if (!PUSH_TITLES[kind] || noted.has(key)) return
    noted.add(key)
    void pushReady.then(async () => {
      if (webpush === null) return
      const name = rt.botOf(info.botId)?.name ?? 'A Bot'
      const payload = JSON.stringify({ kind, id: info.id, title: PUSH_TITLES[kind](name), url: './' })
      for (const sub of subscriptions.values()) {
        try {
          await webpush.sendNotification(sub, payload)
        } catch (error) {
          if (error?.statusCode === 404 || error?.statusCode === 410) dropSub(sub.endpoint)
          else rt.warn('ds-bot: push to %s failed: %s', sub.endpoint?.slice(0, 60), error?.message ?? error)
        }
      }
    })
  }

  rt.pushEndpoint = async (endpoint, body) => {
    await pushReady
    switch (endpoint) {
      case 'push-key':
        return { enabled: webpush !== null, publicKey: vapid?.publicKey ?? null }
      case 'push-subscribe': {
        const sub = body?.subscription ?? body
        if (typeof sub?.endpoint !== 'string' || !sub.endpoint.startsWith('https://')
          || typeof sub?.keys?.p256dh !== 'string' || typeof sub?.keys?.auth !== 'string') {
          throw Object.assign(new Error('Not a valid push subscription'), { code: 'bot/invalid' })
        }
        subscriptions.set(sub.endpoint, {
          endpoint: sub.endpoint.slice(0, 1024),
          keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
          at: Date.now(),
        })
        await persistPush()
        return { subscribed: true }
      }
      case 'push-unsubscribe':
        dropSub(String(body?.endpoint ?? ''))
        return { subscribed: false }
      default:
        throw Object.assign(new Error(`Unknown endpoint ${endpoint}`), { code: 'bot/not-found' })
    }
  }

  // --- pairing gate state ----------------------------------------------------
  const gate = { secret: null, pin: null, expiresAt: 0, failures: 0, nextPinAt: 0, port: 0 }
  rt.pairView = () => (gate.port === 0
    ? { enabled: false }
    : gate.pin !== null && gate.expiresAt > Date.now()
      ? { enabled: true, port: gate.port, pin: `${gate.pin.slice(0, 3)} ${gate.pin.slice(3)}`, expiresAt: gate.expiresAt }
      : { enabled: true, port: gate.port, pin: null, cooldownUntil: gate.nextPinAt > Date.now() ? gate.nextPinAt : null })
  rt.pairMint = () => { mintPin(); return rt.pairView() }

  const mintPin = () => {
    const now = Date.now()
    if (gate.pin !== null && gate.expiresAt > now) return gate.pin
    if (now < gate.nextPinAt) return null
    gate.pin = String(randomInt(0, 1_000_000)).padStart(6, '0')
    gate.expiresAt = now + PIN_TTL_MS
    gate.failures = 0
    return gate.pin
  }
  const tryPin = (input) => {
    if (gate.pin === null || gate.expiresAt <= Date.now()) return false
    const actual = Buffer.from(String(input ?? ''), 'utf8')
    const expected = Buffer.from(gate.pin, 'utf8')
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
      gate.pin = null
      gate.failures = 0
      return true
    }
    if (++gate.failures >= PIN_ATTEMPTS) {
      gate.pin = null
      gate.nextPinAt = Date.now() + PIN_COOLDOWN_MS
    }
    return false
  }

  async function startGate(web) {
    const record = await readJson(gatePath)
    gate.secret = typeof record?.secret === 'string' ? Buffer.from(record.secret, 'base64url') : Buffer.alloc(0)
    if (gate.secret.length !== 32) {
      gate.secret = randomBytes(32)
      await writeJson(gatePath, { secret: gate.secret.toString('base64url') })
        .catch(error => rt.warn('ds-bot: pair-gate.json write failed: %s', error?.message ?? error))
    }
    const authed = req => gateCookieValid(gate.secret, cookieOf(req, GATE_COOKIE))
    // A loopback peer already reaches dsh directly, so PIN would only gate the
    // UI that shows it. The Host check stops a remote client from claiming a
    // loopback authority through the tunnel or a LAN port-forward.
    const hostName = (req) => {
      const host = String(req.headers.host ?? '').toLowerCase()
      return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
    }
    const local = req =>
      ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)
      && ['127.0.0.1', 'localhost', '[::1]'].includes(hostName(req))
    // The launch token this process would print for a manual login. The gate
    // replays it upstream so a paired device never handles it.
    const launchToken = (() => {
      try { return new URL(ctx.connection?.authenticatedUrl?.('http://gate.invalid/') ?? '').searchParams.get('token') }
      catch { return null }
    })()
    // The form never mints: a PIN exists only after the owner asks for one in
    // Settings, so the pairing window is always opened deliberately.
    const form = (res, status, error, next) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(PIN_FORM(gate.pin !== null && gate.expiresAt > Date.now(), error, next))
    }
    const safeNext = url => (typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? url : './')
    // The manifest link fetch, the SW script fetch and icon loads all go out
    // WITHOUT cookies in Chrome, so a gated install can never pass. These files
    // are public by design, so they pass the gate like a local request does.
    const publicAsset = pathname =>
      pathname === '/sw.js' || pathname === '/ds-bot/manifest.webmanifest' || pathname.startsWith('/ds-bot/icons/')
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      if (url.pathname === '/pair' && req.method === 'POST') {
        const chunks = []
        req.on('data', chunk => chunks.push(chunk))
        req.on('end', () => {
          const fields = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
          if (tryPin(fields.get('pin'))) {
            const expiry = new Date(Date.now() + GATE_COOKIE_TTL_MS).toUTCString()
            res.writeHead(303, {
              location: safeNext(fields.get('next')),
              'set-cookie': `${GATE_COOKIE}=${gateCookie(gate.secret)}; Max-Age=${Math.floor(GATE_COOKIE_TTL_MS / 1000)}; Path=/; Expires=${expiry}; HttpOnly; SameSite=Strict`,
            })
            res.end()
          } else {
            form(res, 401,
              gate.pin === null && gate.nextPinAt > Date.now() ? 'Too many wrong PINs. Wait a minute, then reload.' : 'Wrong PIN. Check it again on the computer.',
              safeNext(fields.get('next')))
          }
        })
        return
      }
      if (!local(req) && !authed(req) && !publicAsset(url.pathname)) {
        // The form keeps the original URL in `next`, so a shared ?token= link
        // lands on the real dsh auth right after pairing.
        if (req.method === 'GET' || req.method === 'HEAD') form(res, 401, undefined, safeNext(req.url))
        else { res.writeHead(403); res.end('pairing required') }
        return
      }
      // Paired: proxy verbatim (Host kept, so the dsh cookie binds to this
      // origin). When dsh 401s an index request the gate retries once with the
      // launch token, letting dsh mint its cookie without the token ever
      // reaching the browser.
      const pipe = (path, retried) => {
        const upstream = httpRequest(
          { host: '127.0.0.1', port: web.port, path, method: req.method, headers: req.headers },
          (reply) => {
            const indexPath = new URL(req.url ?? '/', 'http://x').pathname
            if (!retried && launchToken !== null && reply.statusCode === 401 && !local(req)
              && (req.method === 'GET' || req.method === 'HEAD') && (indexPath === '/' || indexPath === '/index.html')) {
              reply.resume()
              const url = new URL(req.url ?? '/', 'http://x')
              url.pathname = '/'
              url.searchParams.delete('token')
              url.searchParams.set('token', launchToken)
              pipe(url.pathname + url.search, true)
              return
            }
            res.writeHead(reply.statusCode ?? 502, reply.headers)
            reply.pipe(res)
          },
        )
        upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
        req.pipe(upstream)
      }
      pipe(req.url, false)
    })
    server.on('upgrade', (req, socket, head) => {
      if (!local(req) && !authed(req)) { socket.destroy(); return }
      const upstream = connectSocket(web.port, '127.0.0.1', () => {
        upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`)
        for (const [name, value] of Object.entries(req.headers)) upstream.write(`${name}: ${value}\r\n`)
        upstream.write('\r\n')
        if (head?.length) upstream.write(head)
        upstream.pipe(socket)
        socket.pipe(upstream)
      })
      upstream.on('error', () => socket.destroy())
      socket.on('error', () => upstream.destroy())
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(gate.port, resolve) })
    return server
  }

  // --- webServer attach ------------------------------------------------------
  const attachWeb = (web, effect) => {
    effect(() => web.register({
      kind: 'exact', path: '/ds-bot/manifest.webmanifest',
      handler: async (_req, res) => reply(res, 200, 'application/manifest+json', JSON.stringify(MANIFEST)),
    }), 'ds-bot: manifest route')
    effect(() => web.register({
      kind: 'prefix', path: '/ds-bot/icons',
      handler: async (req, res) => {
        const file = new URL(req.url ?? '/', 'http://x').pathname.slice('/ds-bot/icons/'.length)
        if (!ICONS.has(file)) { res.writeHead(404); res.end(); return }
        reply(res, 200, 'image/png', await readFile(join(ICONS_DIR, file)))
      },
    }), 'ds-bot: icon route')
    // The worker must sit at the origin root or its scope would be /ds-bot/ only.
    effect(() => web.register({
      kind: 'exact', path: '/sw.js',
      handler: async (_req, res) => reply(res, 200, 'text/javascript; charset=utf-8', await readFile(SW_FILE)),
    }), 'ds-bot: service worker route')
    // viewport-fit=cover rides on the app's existing viewport meta.
    effect(() => web.tapIndex(html => html.replace(
      /(<meta name="viewport" content=")([^"]*)"/,
      (match, open, content) => content.includes('viewport-fit') ? match : `${open}${content}, viewport-fit=cover"`,
    )), 'ds-bot: viewport-fit')
    ctx.on('webserver/index-inject', table => table.push({ kind: 'html', placement: 'head', html: META }))

    const pairPort = Number(rt.config.pairPort ?? process.env.DS_BOT_PAIR_PORT ?? 0)
    if (pairPort > 0) {
      gate.port = pairPort
      effect(() => {
        let server
        void startGate(web).then((started) => { server = started })
          .catch(error => rt.warn('ds-bot: pair gate failed to listen on %s: %s', pairPort, error?.message ?? error))
        return async () => { await server?.close() }
      }, 'ds-bot: pair gate')
    }
  }
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], sub => attachWeb(sub.webServer, sub.effect))
  else if (ctx.get?.('webServer') !== undefined) attachWeb(ctx.get('webServer'), (execute, label) => ctx.effect(execute, label))
}
