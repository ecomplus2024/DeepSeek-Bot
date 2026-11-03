// Telegram: each Bot reaches the user through its own Telegram bot, so no
// inbound port and no public address are needed — getUpdates long-polls out to
// Telegram and replies go back with sendMessage. The token is one secret per
// Bot (TELEGRAM_TOKEN_<id>), never in state.json and never in a model request.
//
// A chat pairs once: the Bot shows a short code in Settings → Connectors, the
// user types /start <code> in Telegram, and from then on only that chat may
// command the Bot. Every later message runs a turn whose reply goes straight
// back to Telegram through a roomWaiters waiter (the same mechanism a group
// round uses), and telegram_send lets a Bot speak first — a failed sync, a
// stuck ticket — without being asked.
import { randomInt, randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ROOM_REPLY_TIMEOUT_MS, TELEGRAM_CAPTION_MAX, TELEGRAM_IMAGE_MAX_BYTES, TELEGRAM_MESSAGE_MAX, TELEGRAM_POLL_TIMEOUT_S, TELEGRAM_SEND_GAP_MS } from './constants.js'
import { output } from './tools.js'

const API = 'https://api.telegram.org'
// Codes avoid the letters and digits a person misreads out loud.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 6

// `TELEGRAM_TOKEN_` plus 47 characters stays inside the 64 a secret name allows.
const secretName = botId => `TELEGRAM_TOKEN_${String(botId).toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 47)}`

// Telegram sends no content type on a photo download, so the bytes decide.
const mediaTypeOf = (data) =>
  data[0] === 0xFF && data[1] === 0xD8 ? 'image/jpeg'
    : data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47 ? 'image/png'
    : data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 ? 'image/gif'
    : data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50 ? 'image/webp'
    : undefined

// Telegram refuses anything past 4096 characters, so a long reply is split on a
// line boundary where one is near, else hard at the limit.
function splitText(text, max) {
  const chunks = []
  let rest = text
  while (rest.length > max) {
    const window = rest.slice(0, max)
    const cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('. '))
    const end = cut > max / 2 ? cut + 1 : max
    chunks.push(rest.slice(0, end))
    rest = rest.slice(end)
  }
  if (rest !== '') chunks.push(rest)
  return chunks
}

export function install(rt) {
  const { ctx, state } = rt
  const enabled = rt.config.telegram !== false
  const request = typeof rt.config.telegram?.fetch === 'function' ? rt.config.telegram.fetch : (...args) => fetch(...args)

  /** @type {Map<string, {token:string, state:string, error?:string, controller:AbortController, chain:Promise<any>}>} */
  const pollers = new Map()
  const sendQueues = new Map()
  const sentAt = new Map()
  let stopped = false

  const reason = error => rt.redactSecrets(String(error?.message ?? error)).slice(0, 300)
  const recordOf = botId => (state.telegram ??= {})[botId] ??= {}
  const tokenOf = botId => rt.secretValue(secretName(botId))

  async function call(token, method, body, signal) {
    const response = await request(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      ...(signal !== undefined ? { signal } : {}),
    })
    const payload = await response.json().catch(() => ({}))
    if (payload?.ok === true) return payload.result
    const error = new Error(String(payload?.description ?? `Telegram answered ${response.status}`))
    error.code = Number(payload?.error_code ?? response.status)
    throw error
  }

  async function callMultipart(token, method, form, signal) {
    const response = await request(`${API}/bot${token}/${method}`, {
      method: 'POST',
      // No content-type header: fetch sets multipart/form-data with a boundary.
      body: form,
      ...(signal !== undefined ? { signal } : {}),
    })
    const payload = await response.json().catch(() => ({}))
    if (payload?.ok === true) return payload.result
    const error = new Error(String(payload?.description ?? `Telegram answered ${response.status}`))
    error.code = Number(payload?.error_code ?? response.status)
    throw error
  }

  // Sends are serialized per Bot so a burst leaves in order and Telegram's own
  // rate limit is not tripped by one chat answering three times at once.
  function enqueue(botId, task) {
    const run = (sendQueues.get(botId) ?? Promise.resolve()).then(async () => {
      const wait = (sentAt.get(botId) ?? 0) + TELEGRAM_SEND_GAP_MS - Date.now()
      if (wait > 0) await new Promise(done => setTimeout(done, wait))
      await task()
      sentAt.set(botId, Date.now())
    })
    sendQueues.set(botId, run.catch(() => {}))
    return run
  }

  function sendText(botId, session, chatId, text) {
    return enqueue(botId, async () => {
      for (const chunk of splitText(text, TELEGRAM_MESSAGE_MAX)) {
        await call(session.token, 'sendMessage', { chat_id: chatId, text: chunk, disable_web_page_preview: true })
      }
    })
  }

  // A photo goes out with the text as its caption; captions stop at 1024
  // characters, so longer text follows as ordinary messages.
  function sendPhoto(botId, session, chatId, { data, filename, caption }) {
    return enqueue(botId, async () => {
      const form = new FormData()
      form.set('chat_id', String(chatId))
      form.set('photo', new Blob([data], { type: mediaTypeOf(data) ?? 'application/octet-stream' }), filename)
      const head = caption.slice(0, TELEGRAM_CAPTION_MAX)
      const rest = caption.slice(head.length)
      if (head !== '') form.set('caption', head)
      await callMultipart(session.token, 'sendPhoto', form)
      if (rest.trim() !== '') {
        await new Promise(done => setTimeout(done, TELEGRAM_SEND_GAP_MS))
        for (const chunk of splitText(rest, TELEGRAM_MESSAGE_MAX)) {
          await call(session.token, 'sendMessage', { chat_id: chatId, text: chunk, disable_web_page_preview: true })
        }
      }
    })
  }

  // A photo arrives as a list of sizes; the last is the largest Telegram kept.
  async function imageAttachment(session, message) {
    const photos = Array.isArray(message?.photo) ? message.photo : []
    const best = photos.at(-1)
    if (best === undefined) return undefined
    const attachments = ctx.get?.('attachments')
    if (attachments === undefined) return undefined
    try {
      const file = await call(session.token, 'getFile', { file_id: best.file_id })
      const path = String(file?.file_path ?? '')
      if (path === '') return undefined
      const response = await request(`${API}/file/bot${session.token}/${path}`, { signal: AbortSignal.timeout(20_000) })
      if (!response.ok) return undefined
      if (Number(response.headers.get('content-length') ?? 0) > TELEGRAM_IMAGE_MAX_BYTES) return undefined
      const data = new Uint8Array(await response.arrayBuffer())
      if (data.byteLength === 0 || data.byteLength > TELEGRAM_IMAGE_MAX_BYTES) return undefined
      const mediaType = mediaTypeOf(data)
      if (mediaType === undefined) {
        rt.warn('ds-bot: telegram photo %s is not a known image format', best.file_id)
        return undefined
      }
      return await attachments.saveImage({ data, mediaType, name: `telegram-photo.${mediaType.slice('image/'.length)}` })
    } catch (error) {
      rt.warn('ds-bot: telegram photo not attached: %s', reason(error))
      return undefined
    }
  }

  // A turn owes the chat its reply: the waiter lives in roomWaiters, so turns.js
  // resolves it with the turn's text (or its failure) exactly like a group round.
  async function talkDeliver(botId, session, chatId, from, text, images) {
    const exchangeId = randomUUID()
    const reply = await new Promise(resolve => {
      let timer
      const finish = (value) => { clearTimeout(timer); rt.roomWaiters.delete(exchangeId); resolve(value) }
      const touch = () => { clearTimeout(timer); timer = setTimeout(() => finish(null), ROOM_REPLY_TIMEOUT_MS) }
      touch()
      rt.roomWaiters.set(exchangeId, {
        sessionId: rt.chatOf(botId),
        resolve: finish,
        fail: failure => finish({ failure }),
        touch,
        work: () => {},
        say: () => {},
        approval: () => {},
      })
      rt.deliver({
        toId: botId,
        role: 'telegram',
        sender: from.name,
        exchangeId,
        note: `direct message from ${from.name} on Telegram · your reply is sent back to Telegram`,
        text,
        ...(images !== undefined ? { images } : {}),
      }).catch(error => finish({ failure: { code: 'DELIVERY', message: String(error?.message ?? error).slice(0, 200) } }))
    })
    if (typeof reply === 'string' && reply.trim() !== '') {
      await sendText(botId, session, chatId, reply.trim())
        .catch(error => rt.warn('ds-bot: telegram reply to %s not sent: %s', chatId, reason(error)))
    } else if (reply?.failure !== undefined) {
      await sendText(botId, session, chatId, `Sorry, I could not answer (${reply.failure.code ?? 'error'}).`)
        .catch(error => rt.warn('ds-bot: telegram failure notice to %s not sent: %s', chatId, reason(error)))
    } else {
      rt.warn('ds-bot: telegram turn for %s ended with no reply to send', chatId)
    }
  }

  const newCode = () => Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('')

  // A bot with no chat bound yet answers anyone who writes it, so wrong codes are
  // counted per chat: past the limit it goes quiet for a while instead of letting
  // a stranger guess six characters against a Bot that can run shell commands.
  const wrongCodes = new Map()
  const CODE_TRIES = 8
  const CODE_LOCK_MS = 15 * 60 * 1000
  const tooManyTries = (chatId) => {
    const entry = wrongCodes.get(chatId)
    if (entry === undefined) return false
    if (Date.now() - entry.at > CODE_LOCK_MS) { wrongCodes.delete(chatId); return false }
    return entry.count >= CODE_TRIES
  }
  const noteWrongCode = (chatId) => {
    const entry = wrongCodes.get(chatId)
    if (entry === undefined || Date.now() - entry.at > CODE_LOCK_MS) wrongCodes.set(chatId, { count: 1, at: Date.now() })
    else { entry.count += 1; entry.at = Date.now() }
  }

  // `/start <code>` from BotFather's own button, or `/pair <code>` typed by hand.
  const pairCodeOf = (text) => {
    const match = /^\/(?:start|pair)(?:@\w+)?\s+(\S+)/i.exec(text)
    return match === null ? undefined : match[1].toUpperCase()
  }

  async function onUpdate(botId, session, update) {
    const message = update?.message
    if (message === undefined || message === null) return
    await rt.load()
    const record = recordOf(botId)
    const chatId = String(message.chat?.id ?? '')
    if (chatId === '') return
    const text = String(message.text ?? message.caption ?? '').trim()
    const from = {
      id: String(message.from?.id ?? ''),
      name: [message.from?.first_name, message.from?.last_name].filter(part => part !== undefined && part !== '').join(' ') || String(message.from?.username ?? chatId),
      username: message.from?.username ?? null,
    }
    const code = pairCodeOf(text)

    if (record.owner === undefined || record.owner === null) {
      if (tooManyTries(chatId)) return
      // Before pairing only the code counts; a stale code asks for a fresh one.
      if (code !== undefined && typeof record.code === 'string' && code === record.code) {
        record.owner = { id: from.id, chatId, name: from.name, username: from.username, pairedAt: Date.now() }
        delete record.code
        delete record.codeAt
        wrongCodes.delete(chatId)
        await rt.save()
        await sendText(botId, session, chatId, 'Đã ghép nối. Từ giờ bạn nhắn gì tôi cũng nhận được ở đây.').catch(() => {})
        return
      }
      if (code !== undefined) noteWrongCode(chatId)
      const hint = code === undefined
        ? 'Mã ghép nối còn thiếu: nhắn /start <mã> với mã đang hiện trong Settings → Connectors.'
        : 'Mã ghép nối không đúng hoặc đã hết hạn: mở Settings → Connectors để lấy mã mới.'
      await sendText(botId, session, chatId, hint).catch(() => {})
      return
    }

    if (String(record.owner.id) !== from.id) {
      await sendText(botId, session, chatId, 'Telegram bot này đã ghép với một tài khoản khác.').catch(() => {})
      return
    }

    if (text === '/id') {
      await sendText(botId, session, chatId, `chat id: ${chatId}`).catch(() => {})
      return
    }
    if (text.startsWith('/start') || text.startsWith('/pair')) {
      await sendText(botId, session, chatId, 'Đã ghép nối sẵn rồi. Nhắn thẳng câu bạn cần là được.').catch(() => {})
      return
    }
    if (text === '' && !Array.isArray(message.photo)) {
      await sendText(botId, session, chatId, 'Tôi chỉ đọc được tin nhắn chữ và ảnh ở đây.').catch(() => {})
      return
    }

    const image = await imageAttachment(session, message)
    await talkDeliver(botId, session, chatId, from, text === '' ? '[image]' : text, image === undefined ? undefined : [image])
  }

  async function poll(botId, session) {
    while (!stopped && pollers.get(botId) === session) {
      let updates
      try {
        const offset = state.telegram?.[botId]?.offset
        updates = await call(session.token, 'getUpdates', {
          ...(typeof offset === 'number' ? { offset } : {}),
          timeout: TELEGRAM_POLL_TIMEOUT_S,
          allowed_updates: ['message'],
        }, session.controller.signal)
      } catch (error) {
        if (stopped || pollers.get(botId) !== session || session.controller.signal.aborted) return
        session.state = 'error'
        session.error = reason(error)
        rt.warn('ds-bot: telegram poll for %s failed: %s', botId, session.error)
        // A rejected token never recovers on its own; anything else retries.
        if (error?.code === 401 || error?.code === 404) return
        await new Promise(done => setTimeout(done, 5_000))
        continue
      }
      if (stopped || pollers.get(botId) !== session) return
      session.state = 'ready'
      delete session.error
      if (!Array.isArray(updates) || updates.length === 0) {
        // A real long poll waits, so an empty answer means the wait ended early
        // (a proxy cut it, say). Pause before asking again rather than spin.
        await new Promise(done => setTimeout(done, 500))
        continue
      }
      const last = updates.at(-1)?.update_id
      if (typeof last === 'number') {
        recordOf(botId).offset = last + 1
        void rt.save().catch(() => {})
      }
      for (const update of updates) {
        // One message at a time per Bot: a turn can take minutes, and the next
        // message should queue behind it instead of racing it.
        session.chain = session.chain
          .then(() => onUpdate(botId, session, update))
          .catch(error => rt.warn('ds-bot: telegram update failed: %s', reason(error)))
      }
    }
  }

  const detach = (botId) => {
    const session = pollers.get(botId)
    if (session === undefined) return
    pollers.delete(botId)
    try { session.controller.abort() } catch {}
  }

  async function connect(botId) {
    const token = tokenOf(botId)
    if (token === undefined) { detach(botId); return }
    const old = pollers.get(botId)
    // Only a live poller counts as connected: 'off' and 'error' reconnect.
    if (old !== undefined && old.token === token && (old.state === 'ready' || old.state === 'connecting')) return
    detach(botId)
    const session = { token, state: 'connecting', controller: new AbortController(), chain: Promise.resolve() }
    pollers.set(botId, session)
    // A token saved straight into Secrets (rather than through the card) still
    // needs its pairing code and the bot's own name.
    void (async () => {
      try {
        const me = await call(token, 'getMe', {})
        const record = recordOf(botId)
        record.username = String(me?.username ?? '')
        record.botUserId = String(me?.id ?? '')
        if (record.owner === undefined || record.owner === null) {
          if (typeof record.code !== 'string') { record.code = newCode(); record.codeAt = Date.now() }
        }
        await rt.save()
      } catch (error) {
        session.state = 'error'
        session.error = reason(error)
        rt.warn('ds-bot: telegram getMe for %s failed: %s', botId, session.error)
      }
    })()
    void poll(botId, session)
  }

  async function sync() {
    await rt.load().catch(() => {})
    // A read-only host (another DSH holds the lock) must not poll: two pollers
    // on one token split the updates between them.
    if (rt.readOnly() !== undefined) { for (const botId of [...pollers.keys()]) detach(botId); return }
    await rt.loadSecrets().catch(() => {})
    const ids = new Set([...Object.keys(state.telegram ?? {}), ...pollers.keys()])
    for (const botId of Object.keys(state.bots ?? {})) if (tokenOf(botId) !== undefined) ids.add(botId)
    for (const botId of ids) {
      if (stopped) return
      await connect(botId).catch(error => rt.warn('ds-bot: telegram connect for %s failed: %s', botId, reason(error)))
    }
  }

  const live = () => ({
    bots: Object.fromEntries(Object.entries(state.telegram ?? {}).map(([botId, entry]) => {
      const session = pollers.get(botId)
      return [botId, {
        state: session?.state ?? 'off',
        ...(session?.error !== undefined ? { error: session.error } : {}),
        username: entry.username ?? null,
        owner: entry.owner ?? null,
        // A code shows only while no chat is bound; a fresh one is minted per connect.
        code: entry.owner === undefined || entry.owner === null ? entry.code ?? null : null,
      }]
    })),
  })

  const endpoints = {
    'telegram-status': () => live(),
    async 'telegram-connect'(body) {
      const bot = rt.botOf(String(body.botId ?? ''))
      if (bot === undefined) throw new Error('Unknown Bot')
      const token = String(body.token ?? '').trim()
      if (token === '') throw new Error('Paste a bot token first')
      if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('That does not look like a Telegram bot token')
      // getMe is the one call that proves the token before anything is saved.
      let me
      try { me = await call(token, 'getMe', {}) } catch (error) {
        throw new Error(`Telegram refused this token: ${reason(error)}`)
      }
      await rt.loadSecrets()
      const kept = rt.secretValue(secretName(bot.id)) !== undefined
      await rt.secretEndpoint('secret-set', {
        name: secretName(bot.id),
        value: token,
        purpose: `Telegram bot for ${bot.name}`,
        ...(kept ? {} : { scope: [] }),
      })
      const record = recordOf(bot.id)
      record.username = String(me?.username ?? '')
      record.botUserId = String(me?.id ?? '')
      record.code = newCode()
      record.codeAt = Date.now()
      // A different bot means a different chat: pair again from scratch.
      delete record.owner
      delete record.offset
      await rt.save()
      await connect(bot.id).catch(error => rt.warn('ds-bot: telegram connect for %s failed: %s', bot.id, reason(error)))
      return live()
    },
    async 'telegram-disconnect'(body) {
      const botId = String(body.botId ?? '')
      detach(botId)
      if (state.telegram?.[botId] !== undefined) {
        delete state.telegram[botId]
        await rt.save()
      }
      await rt.loadSecrets()
      if (rt.secretValue(secretName(botId)) !== undefined) await rt.secretEndpoint('secret-delete', { name: secretName(botId) })
      return live()
    },
    async 'telegram-reconnect'(body) {
      const botId = String(body.botId ?? '')
      detach(botId)
      await connect(botId)
      return live()
    },
  }
  const telegramEndpoint = (endpoint, body) => {
    if (!enabled) throw new Error('Telegram is disabled.')
    return endpoints[endpoint](body ?? {})
  }

  if (enabled) {
    ctx.tools.register(defineTool({
      name: 'telegram_send',
      description: 'Send a Telegram message to the user from your own chat without being asked — a failed sync, a stuck ticket, work that finished while they were away, a photo they asked for. To send a photo, pass image as a local file path (PNG/JPEG/WebP/GIF under 10 MB); text becomes its caption. Works only once the user has paired your Telegram bot in Settings → Connectors.',
      parameters: {
        text: { type: 'string', required: true, description: 'The message to send (with image: its caption)' },
        image: { type: 'string', description: 'Local image file to send (PNG/JPEG/WebP/GIF, under 10 MB)' },
      },
      output,
      async execute(args, exec) {
        await rt.load()
        const bot = rt.botOf(rt.selfOf(exec.agent?.id))
        if (bot === undefined) return 'Only Bots on the team can use telegram_send.'
        const record = state.telegram?.[bot.id]
        if (record?.owner === undefined || record?.owner === null) return 'Your Telegram bot is not paired yet. Ask the user to connect it in Settings → Connectors and type the pairing code in Telegram.'
        const session = pollers.get(bot.id)
        if (session === undefined) return 'Your Telegram bot is not connected right now; ask the user to reconnect it in Settings → Connectors.'
        const text = String(args.text ?? '').trim()
        const imagePath = String(args.image ?? '').trim()
        if (text === '' && imagePath === '') return 'Nothing to send.'
        try {
          const chatId = String(record.owner.chatId ?? record.owner.id)
          if (imagePath !== '') {
            let info
            try {
              info = await stat(imagePath)
            } catch {
              return `Cannot send the photo: no file at ${imagePath}.`
            }
            if (!info.isFile() || info.size === 0) return `Cannot send the photo: ${imagePath} is not a file.`
            if (info.size > 10 * 1024 * 1024) return `Cannot send the photo: ${imagePath} is over 10 MB.`
            const data = new Uint8Array(await readFile(imagePath))
            if (mediaTypeOf(data) === undefined) return `Cannot send the photo: ${imagePath} is not a PNG, JPEG, GIF or WebP image.`
            await sendPhoto(bot.id, session, chatId, { data, filename: basename(imagePath) || 'photo.jpg', caption: text })
          } else {
            await sendText(bot.id, session, chatId, text)
          }
          return 'Sent on Telegram.'
        } catch (failure) {
          return String(failure?.message ?? failure)
        }
      },
    }))

    ctx.effect(() => {
      stopped = false
      void sync()
      return () => {
        stopped = true
        for (const botId of [...pollers.keys()]) detach(botId)
      }
    }, 'ds-bot: telegram')

    // Secrets edits link or unlink bots; a deleted Bot's token goes with it.
    const secretsChanged = rt.secretsChanged
    rt.secretsChanged = () => {
      secretsChanged?.()
      void sync()
    }
    const forgetBotSecrets = rt.forgetBotSecrets
    rt.forgetBotSecrets = async (botId) => {
      const result = await forgetBotSecrets?.(botId)
      detach(botId)
      if (state.telegram?.[botId] !== undefined) {
        delete state.telegram[botId]
        await rt.save().catch(() => {})
      }
      if (rt.secretValue(secretName(botId)) !== undefined) await rt.secretEndpoint('secret-delete', { name: secretName(botId) }).catch(() => {})
      return result
    }
  }

  Object.assign(rt, { telegramLive: live, telegramEndpoint, telegramBound: botId => state.telegram?.[botId]?.owner != null })
}
