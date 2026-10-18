// Zalo: a Bot bound to a personal Zalo account follows chosen threads and talks
// with the user there. Login is by QR code; the {cookie, imei, userAgent} session
// lives as one secret, so it reaches no model request and no Bot's shell.
//
// Each thread has a mode: `talk` relays the turn's reply back to Zalo through a
// roomWaiters waiter (the same mechanism a group uses to wait for a member),
// `watch` only buffers messages and wakes the Bot on a @mention or keyword —
// what it says there goes out through zalo_send, never automatically.
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ROOM_REPLY_TIMEOUT_MS, ZALO_BUFFER_MAX, ZALO_MODES, ZALO_SEND_GAP_MS, ZALO_SEND_MAX, ZALO_SEND_WINDOW_MS, ZALO_WAKE_LINES } from './constants.js'
import { output } from './tools.js'

const QR_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
// A message's content is a string only when it is plain text; other kinds land
// as objects with a msgType name.
const PLACEHOLDER = { sticker: '[sticker]', photo: '[image]', 'video.msg': '[video]', voice: '[voice]', file: '[file]', link: '[link]', share: '[shared]' }
const contentOf = message => {
  const content = message?.data?.content
  if (typeof content === 'string') return content.trim()
  const type = String(message?.data?.msgType ?? '')
  return PLACEHOLDER[Object.keys(PLACEHOLDER).find(kind => type.endsWith(kind))] ?? '[message]'
}

export const zaloSecretName = botId => `ZALO_SESSION_${String(botId).toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 40)}`

export function install(rt) {
  const { ctx, state } = rt
  const enabled = rt.config.zalo !== false

  /** @type {Map<string, {api?:any, types?:any, state:string, error?:string, saved?:string}>} */
  const sessions = new Map()
  const sendQueues = new Map()
  const sentAt = new Map()
  // At most one QR login at a time: its QR image and progress feed the panel.
  let pending = null
  let stopped = false

  const loadLib = async () => {
    const custom = rt.config.zalo?.import
    const mod = typeof custom === 'function' ? await custom() : await import(custom ?? 'zca-js')
    return mod?.default?.Zalo !== undefined ? mod.default : mod
  }
  const reason = error => rt.redactSecrets(String(error?.message ?? error)).slice(0, 300)
  const teamOf = botId => state.zalo?.[botId]
  const bound = (botId) => { const team = teamOf(botId); return team?.account ? team : undefined }

  // Sends are serialized per Bot: at least ZALO_SEND_GAP_MS apart and at most
  // ZALO_SEND_MAX per window, so a personal account does not trip Zalo's spam watch.
  function zaloSend(botId, threadId, text) {
    const session = sessions.get(botId)
    if (session?.api === undefined) return Promise.reject(new Error('Zalo is not connected'))
    const thread = teamOf(botId)?.threads?.[threadId]
    const run = (sendQueues.get(botId) ?? Promise.resolve()).then(async () => {
      const now = Date.now()
      const log = (sentAt.get(botId) ?? []).filter(ts => now - ts < ZALO_SEND_WINDOW_MS)
      if (log.length >= ZALO_SEND_MAX) throw new Error(`Zalo limits this account to ${ZALO_SEND_MAX} messages per 10 minutes; wait a few minutes`)
      const wait = (log.at(-1) ?? 0) + ZALO_SEND_GAP_MS - now
      if (wait > 0) await new Promise(done => setTimeout(done, wait))
      await session.api.sendMessage({ msg: text }, threadId, thread?.kind === 'group' ? session.types.group : session.types.user)
      log.push(Date.now())
      sentAt.set(botId, log)
    })
    sendQueues.set(botId, run.catch(() => {}))
    return run
  }

  const mentioned = (message, team, entry) => {
    const uid = team.account?.uid
    if (uid !== undefined && uid !== '' && (message?.data?.mentions ?? []).some(mark => String(mark?.uid ?? mark) === uid)) return true
    const name = String(team.account?.name ?? '').trim().toLowerCase()
    return name !== '' && entry.text.toLowerCase().includes(`@${name}`)
  }
  const wakes = (message, team, thread, entry) => {
    if (thread.kind === 'group' && mentioned(message, team, entry)) return 'you were mentioned'
    const hit = (thread.keywords ?? []).find(word => word !== '' && entry.text.toLowerCase().includes(String(word).toLowerCase()))
    return hit !== undefined ? `keyword "${hit}"` : null
  }

  // A `talk` turn owes the thread its reply. The waiter lives in roomWaiters, so
  // turns.js resolves it with the turn's text (or its failure) exactly like a
  // group round; the timeout matches the group's, refreshed by Session activity.
  async function talkDeliver(botId, threadId, thread, entry) {
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
        role: 'zalo',
        sender: entry.from,
        exchangeId,
        note: `${thread.kind === 'group' ? `group "${thread.name ?? threadId}"` : 'direct message'} from ${entry.from} · your reply is sent back to Zalo`,
        text: entry.text,
      }).catch(error => finish({ failure: { code: 'DELIVERY', message: String(error?.message ?? error).slice(0, 200) } }))
    })
    if (typeof reply === 'string' && reply.trim() !== '') {
      void zaloSend(botId, threadId, reply.trim()).catch(error => rt.warn('ds-bot: zalo reply to %s not sent: %s', threadId, error))
    } else if (reply?.failure !== undefined) {
      void zaloSend(botId, threadId, `Sorry, I could not answer (${reply.failure.code ?? 'error'}).`)
        .catch(error => rt.warn('ds-bot: zalo failure notice to %s not sent: %s', threadId, error))
    } else {
      rt.warn('ds-bot: zalo talk turn for %s ended with no reply to send', threadId)
    }
  }

  // A `watch` wake informs the Bot; nothing it writes in that turn is relayed.
  async function wakeWatch(botId, threadId, thread, why) {
    const text = (thread.buffer ?? []).slice(-ZALO_WAKE_LINES).map(line => `${line.from}: ${line.text}`).join('\n')
    if (text === '') return
    await rt.deliver({
      toId: botId,
      role: 'zalo',
      sender: `Zalo "${thread.name ?? threadId}"`,
      exchangeId: randomUUID(),
      note: `watch ${thread.kind === 'group' ? 'group' : 'chat'} "${thread.name ?? threadId}" · ${why} · speak there only with zalo_send; your reply here is not relayed`,
      text,
    }).catch(error => rt.warn('ds-bot: zalo watch delivery failed: %s', error))
  }

  async function onMessage(botId, message) {
    if (message?.isSelf === true) return
    const team = bound(botId)
    const threadId = String(message?.threadId ?? '')
    if (team === undefined || threadId === '') return
    await rt.load()
    const thread = team.threads?.[threadId]
    if (thread === undefined || !ZALO_MODES.includes(thread.mode) || thread.mode === 'off') return
    if (String(message.data?.uidFrom ?? '') === String(team.account?.uid ?? '')) return
    const entry = {
      from: String(message.data?.dName ?? '').trim() || String(message.data?.uidFrom ?? 'someone'),
      text: contentOf(message),
      ts: Date.now(),
    }
    thread.buffer = [...(thread.buffer ?? []), entry].slice(-ZALO_BUFFER_MAX)
    void rt.save().catch(() => {})
    if (thread.mode === 'talk') {
      rt.warn('ds-bot: zalo talk message in %s from %s; delivering to %s', threadId, entry.from, botId)
      return talkDeliver(botId, threadId, thread, entry)
    }
    const why = wakes(message, team, thread, entry)
    if (why !== null) await wakeWatch(botId, threadId, thread, why)
  }

  function attachSession(botId, api, lib, saved) {
    const types = lib?.ThreadType ?? {}
    const entry = { api, state: 'ready', saved, types: { user: types.User ?? types.user ?? 0, group: types.Group ?? types.group ?? 1 } }
    sessions.set(botId, entry)
    const listener = api.listener
    listener.onConnected?.(() => { if (sessions.get(botId) === entry) entry.state = 'ready' })
    listener.onClosed?.(() => { if (sessions.get(botId) === entry) entry.state = 'off' })
    listener.onError?.((error) => { if (sessions.get(botId) === entry) { entry.state = 'error'; entry.error = reason(error) } })
    listener.onMessage?.((message) => { void onMessage(botId, message).catch(error => rt.warn('ds-bot: zalo message failed: %s', error)) })
    try { listener.start() } catch (error) { entry.state = 'error'; entry.error = reason(error) }
    return entry
  }

  const detach = (botId) => {
    try { sessions.get(botId)?.api?.listener?.stop?.() } catch {}
    sessions.delete(botId)
  }

  // Login from the saved secret; `saved` guards against double connects on a
  // secretsChanged pass, and against an edit racing a connect in flight.
  async function connect(botId) {
    const saved = rt.secretValue(zaloSecretName(botId))
    if (saved === undefined || teamOf(botId)?.account == null) { detach(botId); return }
    const old = sessions.get(botId)
    if (old !== undefined && old.saved === saved && old.state !== 'error') return
    detach(botId)
    const entry = { state: 'connecting', saved }
    sessions.set(botId, entry)
    let credentials
    try { credentials = JSON.parse(saved) } catch {
      entry.state = 'error'
      entry.error = 'The saved Zalo session cannot be read; log in again'
      return
    }
    try {
      const lib = await loadLib()
      const api = await new lib.Zalo({ logging: false, selfListen: false }).login(credentials)
      // A logout or a newer connect while this one was in flight makes it stale.
      if (stopped || sessions.get(botId) !== entry || rt.secretValue(zaloSecretName(botId)) !== saved || teamOf(botId)?.account == null) {
        try { api.listener?.stop?.() } catch {}
        return
      }
      attachSession(botId, api, lib, saved)
    } catch (error) {
      entry.state = 'error'
      entry.error = reason(error)
      rt.warn('ds-bot: zalo login for %s failed: %s', botId, entry.error)
    }
  }

  async function sync() {
    await rt.load().catch(() => {})
    // A read-only host (another DSH holds the lock) must not hold the account:
    // two listeners on one nick kick each other off.
    if (rt.readOnly() !== undefined) { for (const botId of sessions.keys()) detach(botId); return }
    await rt.loadSecrets().catch(() => {})
    for (const botId of new Set([...Object.keys(state.zalo ?? {}), ...sessions.keys()])) {
      if (stopped) return
      await connect(botId).catch(error => rt.warn('ds-bot: zalo connect for %s failed: %s', botId, error))
    }
  }

  const live = () => ({
    bots: Object.fromEntries(Object.keys(state.zalo ?? {}).map((botId) => {
      const session = sessions.get(botId)
      const team = teamOf(botId)
      return [botId, {
        state: session?.state ?? 'off',
        ...(session?.error ? { error: session.error } : {}),
        account: team?.account ?? null,
        threads: Object.fromEntries(Object.entries(team?.threads ?? {}).map(([id, thread]) => [id, {
          kind: thread.kind ?? 'user',
          name: thread.name ?? id,
          mode: thread.mode ?? 'off',
          ...(Array.isArray(thread.keywords) && thread.keywords.length > 0 ? { keywords: thread.keywords } : {}),
          buffered: (thread.buffer ?? []).length,
        }])),
      }]
    })),
    login: pending === null ? null : {
      botId: pending.botId,
      phase: pending.phase,
      qr: pending.qr,
      name: pending.name,
      error: pending.error,
    },
  })

  async function listThreads(botId) {
    const session = sessions.get(botId)
    if (session?.api === undefined) throw new Error('Zalo is not connected')
    const configured = teamOf(botId)?.threads ?? {}
    const friends = await session.api.getAllFriends?.().catch(() => []) ?? []
    const friendList = Array.isArray(friends) ? friends : Array.isArray(friends?.data) ? friends.data : []
    const users = friendList
      .map(friend => ({ id: String(friend?.userId ?? friend?.id ?? ''), kind: 'user', name: String(friend?.displayName || friend?.zaloName || friend?.display_name || friend?.zalo_name || friend?.name || '') }))
      .filter(thread => thread.id !== '')
    // getAllGroups returns {version, gridVerMap: {groupId: version}}, not a group map.
    const groupMap = await session.api.getAllGroups?.().catch(() => ({})) ?? {}
    const groupIds = groupMap?.gridVerMap !== undefined
      ? Object.keys(groupMap.gridVerMap)
      : Object.keys(groupMap ?? {}).filter(id => /^\d+$/.test(id))
    // getGroupInfo rejects large batches; ask in chunks and keep the ids that fail.
    const details = {}
    let groupError = null
    for (let index = 0; index < groupIds.length; index += 40) {
      try {
        const info = await session.api.getGroupInfo?.(groupIds.slice(index, index + 40))
        Object.assign(details, info?.gridInfoMap ?? {})
      } catch (error) { groupError ??= reason(error) }
    }
    const groups = groupIds.map(id => ({ id, kind: 'group', name: String(details[id]?.name ?? configured[id]?.name ?? id) }))
    const mark = thread => ({ ...thread, mode: configured[thread.id]?.mode ?? 'off', keywords: configured[thread.id]?.keywords ?? [] })
    const known = new Set([...users, ...groups].map(thread => thread.id))
    const others = Object.entries(configured)
      .filter(([id]) => !known.has(id))
      .map(([id, thread]) => ({ id, kind: thread.kind ?? 'user', name: thread.name ?? id }))
    return { users: users.map(mark), groups: groups.map(mark), others: others.map(mark), ...(groupError !== null ? { error: groupError } : {}) }
  }

  const endpoints = {
    'zalo-status': () => live(),
    async 'zalo-start'(body) {
      const bot = rt.botOf(String(body.botId ?? ''))
      if (bot === undefined) throw new Error('Unknown Bot')
      if (sessions.get(bot.id)?.api !== undefined) throw new Error('This Bot is already connected; log out first')
      if (pending !== null && pending.phase !== 'error' && pending.phase !== 'expired') throw new Error('A Zalo login is already in progress')
      try { pending?.abort?.() } catch {}
      const entry = { botId: bot.id, phase: 'qr', qr: null, name: null, error: null, credentials: undefined, abort: undefined }
      pending = entry
      void (async () => {
        try {
          const lib = await loadLib()
          const EVT = lib.LoginQRCallbackEventType ?? {}
          const api = await new lib.Zalo({ logging: false, selfListen: false }).loginQR(
            { userAgent: QR_UA, language: 'vi' },
            (event) => {
              if (event?.actions?.abort !== undefined) entry.abort = event.actions.abort
              if (event?.type === EVT.QRCodeGenerated) {
                const image = String(event.data?.image ?? '')
                entry.qr = image.startsWith('data:') ? image : `data:image/png;base64,${image}`
              } else if (event?.type === EVT.QRCodeScanned) {
                entry.phase = 'scanned'
                entry.name = event.data?.display_name ?? null
              } else if (event?.type === EVT.QRCodeExpired) {
                entry.phase = 'expired'
              } else if (event?.type === EVT.QRCodeDeclined) {
                entry.phase = 'error'
                entry.error = 'Login declined on the phone'
              } else if (event?.type === EVT.GotLoginInfo) {
                entry.credentials = event.data
              }
            },
          )
          const credentials = entry.credentials
          if (pending !== entry) {
            // Canceled, or a newer login replaced this one: do not keep a stray session.
            try { api.listener?.stop?.() } catch {}
            return
          }
          if (credentials === undefined) throw new Error('Zalo gave no login credentials')
          const profile = await api.fetchAccountInfo?.().catch(() => undefined)
          state.zalo ??= {}
          const team = state.zalo[bot.id] ??= { account: null, threads: {} }
          team.account = { uid: String(api.getOwnId?.() ?? ''), name: String(profile?.data?.display_name ?? entry.name ?? '') }
          team.threads ??= {}
          await rt.secretEndpoint('secret-set', { name: zaloSecretName(bot.id), value: JSON.stringify(credentials), purpose: `Zalo session for ${bot.name}`, scope: [] })
          await rt.save()
          attachSession(bot.id, api, lib, JSON.stringify(credentials))
          pending = null
        } catch (error) {
          if (pending === entry) { entry.phase = 'error'; entry.error = reason(error) }
        }
      })()
      return live()
    },
    'zalo-cancel': () => {
      try { pending?.abort?.() } catch {}
      pending = null
      return live()
    },
    async 'zalo-logout'(body) {
      const botId = String(body.botId ?? '')
      detach(botId)
      if (state.zalo?.[botId]?.account !== undefined && state.zalo[botId].account !== null) {
        state.zalo[botId].account = null
        await rt.save()
      }
      if (rt.secretValue(zaloSecretName(botId)) !== undefined) await rt.secretEndpoint('secret-delete', { name: zaloSecretName(botId) })
      return live()
    },
    async 'zalo-reconnect'(body) {
      await connect(String(body.botId ?? ''))
      return live()
    },
    'zalo-threads': body => listThreads(String(body.botId ?? '')),
    async 'zalo-thread-mode'(body) {
      const bot = rt.botOf(String(body.botId ?? ''))
      if (bot === undefined) throw new Error('Unknown Bot')
      const threadId = String(body.threadId ?? '')
      if (threadId === '') throw new Error('No thread')
      if (!ZALO_MODES.includes(body.mode)) throw new Error('Unknown mode')
      state.zalo ??= {}
      const team = state.zalo[bot.id] ??= { account: null, threads: {} }
      team.threads ??= {}
      const thread = team.threads[threadId] ??= {}
      thread.kind = body.kind === 'group' ? 'group' : 'user'
      if (typeof body.name === 'string' && body.name.trim() !== '') thread.name = body.name.trim().slice(0, 100)
      thread.mode = body.mode
      thread.keywords = Array.isArray(body.keywords) ? body.keywords.map(word => String(word).trim()).filter(word => word !== '').slice(0, 20) : []
      if (body.mode === 'off') { delete thread.buffer; delete thread.keywords }
      else thread.buffer ??= []
      await rt.save()
      return live()
    },
  }
  const zaloEndpoint = (endpoint, body) => {
    if (!enabled) throw new Error('Zalo is disabled.')
    return endpoints[endpoint](body ?? {})
  }

  // A Bot may use its Zalo tools only while it owns the account: the group
  // Session of a bound Bot reaches the same team record through selfOf.
  const callerTeam = async (exec, tool) => {
    await rt.load()
    const bot = rt.botOf(rt.selfOf(exec.agent?.id))
    if (bot === undefined) return { error: `Only Bots on the team can use ${tool}.` }
    const team = bound(bot.id)
    if (team === undefined) return { error: 'You have no Zalo account linked. Ask the user to link one in Settings → Connectors.' }
    return { bot, team }
  }
  const findThread = (team, ref) => {
    const threads = team.threads ?? {}
    if (threads[ref] !== undefined) return [ref, threads[ref]]
    const wanted = String(ref ?? '').trim().toLowerCase()
    const hits = Object.entries(threads).filter(([, thread]) => String(thread.name ?? '').toLowerCase() === wanted)
    return hits.length === 1 ? hits[0] : undefined
  }

  if (enabled) {
    ctx.tools.register(defineTool({
      name: 'zalo_threads',
      description: 'List the Zalo threads (people and groups) you follow, each with its mode: "talk" threads get your replies automatically, "watch" threads you only read until you zalo_send.',
      parameters: {},
      output,
      async execute(_args, exec) {
        const { team, error } = await callerTeam(exec, 'zalo_threads')
        if (error !== undefined) return error
        const lines = Object.entries(team.threads ?? {}).map(([id, thread]) =>
          `- "${thread.name ?? id}" (${thread.kind ?? 'user'}, id ${id}) — ${thread.mode ?? 'off'}${(thread.buffer ?? []).length > 0 ? `, ${thread.buffer.length} unread` : ''}`)
        return lines.length === 0 ? 'No Zalo threads configured yet. Ask the user to pick them in Settings → Connectors.' : ['Zalo threads:', ...lines].join('\n')
      },
    }))
    ctx.tools.register(defineTool({
      name: 'zalo_read',
      description: 'Read the recent messages buffered from a watched or talked Zalo thread. Name the thread by its exact name or id from zalo_threads.',
      parameters: { thread: { type: 'string', required: true, description: 'Exact thread name or id from zalo_threads' } },
      output,
      async execute(args, exec) {
        const { team, error } = await callerTeam(exec, 'zalo_read')
        if (error !== undefined) return error
        const found = findThread(team, String(args.thread ?? ''))
        if (found === undefined) return 'No such Zalo thread. Call zalo_threads for the list.'
        const [id, thread] = found
        const lines = (thread.buffer ?? []).map(line => `${new Date(line.ts).toISOString().slice(5, 16).replace('T', ' ')} ${line.from}: ${line.text}`)
        if (lines.length === 0) return `Nothing buffered from "${thread.name ?? id}" yet.`
        return [`"${thread.name ?? id}" — last ${lines.length} messages:`, ...lines].join('\n')
      },
    }))
    ctx.tools.register(defineTool({
      name: 'zalo_send',
      description: 'Send a text message to a Zalo thread you follow (mode "talk" or "watch"). Use it to speak in a watched thread; a talk thread already gets your reply automatically.',
      parameters: {
        thread: { type: 'string', required: true, description: 'Exact thread name or id from zalo_threads' },
        text: { type: 'string', required: true, description: 'The message to send' },
      },
      output,
      async execute(args, exec) {
        const { bot, team, error } = await callerTeam(exec, 'zalo_send')
        if (error !== undefined) return error
        const text = String(args.text ?? '').trim()
        if (text === '') return 'Nothing to send.'
        const found = findThread(team, String(args.thread ?? ''))
        if (found === undefined) return 'No such Zalo thread. Call zalo_threads for the list.'
        const [id, thread] = found
        if (thread.mode !== 'talk' && thread.mode !== 'watch') return `"${thread.name ?? id}" is off; only talk and watch threads can be written to.`
        try {
          await zaloSend(bot.id, id, text)
          return `Sent to "${thread.name ?? id}".`
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
        try { pending?.abort?.() } catch {}
        pending = null
        for (const botId of sessions.keys()) detach(botId)
      }
    }, 'ds-bot: zalo')

    // Secrets edits re-link or unlink accounts; a deleted Bot's goes with it.
    const secretsChanged = rt.secretsChanged
    rt.secretsChanged = () => {
      secretsChanged?.()
      void sync()
    }
    const forgetBotSecrets = rt.forgetBotSecrets
    rt.forgetBotSecrets = async (botId) => {
      const result = await forgetBotSecrets?.(botId)
      detach(botId)
      if (state.zalo !== undefined) delete state.zalo[botId]
      return result
    }
  }

  Object.assign(rt, { zaloLive: live, zaloEndpoint, zaloBound: botId => bound(botId) !== undefined, zaloSend })
}
