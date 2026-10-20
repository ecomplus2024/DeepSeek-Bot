import { createElement as h, useRef, useState } from 'react'
import { useMorph } from './motion.js'
import { MaskedInput } from './secret-card.js'
import { t } from './i18n.js'

const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new'

export const GitHubMark = () => h('svg', { width: 20, height: 20, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': true },
  h('path', { d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z' }))

const MARKS = { github: GitHubMark }
const ABOUT = { github: () => t('Repositories, issues, and pull requests') }

function statusText(connector) {
  if (connector.state === 'connecting') return t('Connecting…')
  if (connector.state === 'error') return t('Could not connect: {error}', { error: connector.error ?? '' })
  if (connector.state === 'ready') return connector.account ? t('Connected as {account}', { account: connector.account }) : t('Connected')
  return ABOUT[connector.id]?.() ?? ''
}

function ConnectorRow({ connector, actions }) {
  const [form, setForm] = useState(false)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const run = (task, after) => {
    setBusy(true)
    setError(null)
    return task.then(() => { after?.() }, failure => setError(failure?.message ?? String(failure))).finally(() => setBusy(false))
  }
  const connect = () => {
    if (busy || token.trim() === '') return
    void run(actions.connectorConnect(connector.id, token), () => { setToken(''); setForm(false) })
  }
  const on = connector.state !== 'off'
  const Mark = MARKS[connector.id]
  const row = useRef(null)
  useMorph(row, `${form}:${error !== null}:${connector.state}`)
  return h('div', { ref: row, className: 'bt-connector', 'data-state': connector.state },
    h('div', { className: 'bt-connector-head' },
      h('span', { className: 'bt-connector-mark' }, Mark ? h(Mark) : null),
      h('span', { className: 'bt-connector-text' },
        h('span', { className: 'bt-connector-name' }, connector.name),
        h('span', { className: 'bt-connector-status' }, statusText(connector))),
      h('span', { className: 'bt-connector-actions' },
        connector.state === 'error' ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void run(actions.connectorRetry(connector.id)) }, t('Try again')) : null,
        on
          ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void run(actions.connectorDisconnect(connector.id)) }, t('Disconnect'))
          : form ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setForm(true) }, t('Connect')))),
    !on && form ? h('div', { className: 'bt-connector-form' },
      h('label', { className: 'bt-q-field bt-secret-field' }, h(MaskedInput, { value: token, onChange: setToken, onEnter: connect, label: t('GitHub token'), autoFocus: true })),
      h('div', { className: 'bt-connector-form-row' },
        h('a', { className: 'bt-connector-link', href: TOKEN_URL, target: '_blank', rel: 'noopener noreferrer' }, t('Create a token on GitHub')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => { setForm(false); setToken(''); setError(null) } }, t('Cancel')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || token.trim() === '', onClick: connect }, busy ? t('Connecting…') : t('Connect')))) : null,
    error ? h('div', { className: 'bt-connector-error', role: 'alert' }, error) : null)
}

// Settings → Connectors: one row per connector, then the Zalo card.
export function ConnectorsPage({ roster, actions }) {
  const list = roster?.connectors ?? []
  return h('section', { className: 'bt-set-section' },
    h('div', { className: 'bt-set-card bt-connectors-card' }, list.length === 0
      ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No connectors')))
      : list.map(connector => h(ConnectorRow, { key: connector.id, connector, actions }))),
    h(ZaloCard, { roster, actions }))
}

export const ZaloMark = () => h('svg', { width: 20, height: 20, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': true },
  h('path', { d: 'M2.6 1.5h10.8c.6 0 1.1.5 1.1 1.1v7.6c0 .6-.5 1.1-1.1 1.1H6.4l-3.3 3.2c-.3.3-.8.1-.8-.4V2.6c0-.6.1-1.1.3-1.1z' }),
  h('path', { d: 'M5.2 5h5.6v1.1l-3.6 3.7h3.6v1.2H5.2V9.9l3.6-3.7H5.2z', fill: 'var(--bt-card)' }))

const ZALO_MODES = ['off', 'talk', 'watch']
const modeLabel = { off: () => t('Off'), talk: () => t('Talk'), watch: () => t('Watch') }

function zaloStatus(entry) {
  if (entry === undefined || entry.account === null || entry.account === undefined) return ''
  if (entry.state === 'connecting') return t('Connecting…')
  if (entry.state === 'error') return t('Could not connect: {error}', { error: entry.error ?? '' })
  if (entry.state === 'ready') return entry.account?.name ? t('Connected as {account}', { account: entry.account.name }) : t('Connected')
  return t('Disconnected')
}

function ThreadRow({ botId, thread, actions }) {
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState(thread.mode)
  const [keywords, setKeywords] = useState((thread.keywords ?? []).join(', '))
  const [error, setError] = useState(null)
  const save = (patch) => {
    const next = { mode, ...patch }
    setBusy(true)
    setError(null)
    actions.zaloThreadMode(botId, { threadId: thread.id, kind: thread.kind, name: thread.name, ...next })
      .then(() => setMode(next.mode), failure => setError(failure?.message ?? String(failure)))
      .finally(() => setBusy(false))
  }
  return h('div', { className: 'bt-zalo-thread' },
    h('span', { className: 'bt-zalo-thread-name', title: thread.id },
      thread.name || thread.id,
      h('span', { className: 'bt-zalo-kind' }, thread.kind === 'group' ? t('group') : t('direct'))),
    thread.owner !== undefined
      ? h('span', { className: 'bt-set-hint' }, t('followed by {name}', { name: thread.owner }))
      : h('select', {
          className: 'bt-select bt-zalo-mode', value: mode, disabled: busy,
          onChange: event => save({ mode: event.target.value, keywords: keywords.split(',').map(word => word.trim()).filter(word => word !== '') }),
        }, ZALO_MODES.map(value => h('option', { key: value, value }, modeLabel[value]()))),
    mode === 'watch'
      ? h('input', {
          className: 'bt-input bt-zalo-keys', value: keywords, disabled: busy,
          placeholder: t('Wake keywords, comma-separated'),
          onChange: event => setKeywords(event.target.value),
          onBlur: () => save({ keywords: keywords.split(',').map(word => word.trim()).filter(word => word !== '') }),
        })
      : null,
    error ? h('span', { className: 'bt-connector-error' }, error) : null)
}

const THREADS_PAGE = 50

function ZaloBound({ bot, entry, shared, actions }) {
  const [open, setOpen] = useState(false)
  const [threads, setThreads] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(THREADS_PAGE)
  const state = entry.state === 'error' ? 'error' : entry.state === 'ready' ? 'ready' : 'off'
  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next) {
      setThreads({ loading: true })
      actions.zaloThreads(bot.id).then(setThreads, failure => { setThreads(null); setError(failure?.message ?? String(failure)) })
    }
  }
  const search = query.trim().toLowerCase()
  const matches = thread => search === ''
    || String(thread.name ?? '').toLowerCase().includes(search)
    || String(thread.id).includes(search)
  const sections = threads === null || threads.loading === true ? [] : [
    [t('People'), threads.users ?? []],
    [t('Groups'), threads.groups ?? []],
    [t('Other threads'), threads.others ?? []],
  ]
    .map(([title, list]) => [title, list.filter(matches)])
    .filter(([, list]) => list.length > 0)
  // Spend the page budget across the sections in order; the rest waits for "more".
  let budget = limit
  const visible = []
  let hidden = 0
  for (const [title, list] of sections) {
    const shown = list.slice(0, Math.max(budget, 0))
    hidden += list.length - shown.length
    if (shown.length > 0) visible.push([title, shown])
    budget -= shown.length
  }
  return h('div', { className: 'bt-connector', 'data-state': state },
    h('div', { className: 'bt-connector-head' },
      h('span', { className: 'bt-connector-mark' }, h(ZaloMark)),
      h('span', { className: 'bt-connector-text' },
        h('span', { className: 'bt-connector-name' }, t('Zalo · {bot}', { bot: bot.name })),
        h('span', { className: 'bt-connector-status' }, `${zaloStatus(entry)}${shared ? ` · ${t('shared')}` : ''}`)),
      h('span', { className: 'bt-connector-actions' },
        entry.state === 'off' || entry.state === 'error'
          ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => { setBusy(true); actions.zaloReconnect(bot.id).catch(failure => setError(failure?.message ?? String(failure))).finally(() => setBusy(false)) } }, t('Reconnect'))
          : null,
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: toggle }, open ? t('Hide threads') : t('Threads')),
        h('button', {
          type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
          onClick: () => { setBusy(true); actions.zaloLogout(bot.id).catch(failure => setError(failure?.message ?? String(failure))).finally(() => setBusy(false)) },
        }, t('Disconnect')))),
    open ? h('div', { className: 'bt-zalo-threads' },
      threads !== null && threads.loading !== true
        ? h('input', {
            className: 'bt-input bt-zalo-search', value: query,
            placeholder: t('Search threads…'), 'aria-label': t('Search threads'),
            onChange: event => { setQuery(event.target.value); setLimit(THREADS_PAGE) },
          })
        : null,
      visible.length === 0
        ? h('span', { className: 'bt-set-hint' }, threads === null || threads.loading === true ? t('Loading…') : (search !== '' ? t('No threads match') : t('No threads')))
        : visible.map(([title, list]) => h('div', { key: title, className: 'bt-zalo-thread-group' },
            h('div', { className: 'bt-zalo-thread-title' }, title),
            list.map(thread => h(ThreadRow, { key: thread.id, botId: bot.id, thread, actions })))),
      hidden > 0
        ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-zalo-more', onClick: () => setLimit(value => value + THREADS_PAGE) }, t('Show {count} more', { count: hidden > THREADS_PAGE ? THREADS_PAGE : hidden }))
        : null,
      threads?.error ? h('span', { className: 'bt-connector-error', role: 'alert' }, threads.error) : null) : null,
    error ? h('div', { className: 'bt-connector-error', role: 'alert' }, error) : null)
}

function ZaloConnect({ roster, actions, login }) {
  const unbound = (roster?.bots ?? []).filter(bot => roster?.zalo?.bots?.[bot.id]?.account === undefined || roster?.zalo?.bots?.[bot.id]?.account === null)
  // Accounts another Bot already signed into can be shared, no second scan.
  const accounts = roster?.zalo?.accounts ?? []
  const [botId, setBotId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const picked = botId || unbound[0]?.id || ''
  const start = () => { if (picked !== '') { setBusy(true); setError(null); actions.zaloStart(picked).catch(failure => setError(failure?.message ?? String(failure))).finally(() => setBusy(false)) } }
  const bind = (uid) => { if (picked !== '') { setBusy(true); setError(null); actions.zaloBind(picked, uid).catch(failure => setError(failure?.message ?? String(failure))).finally(() => setBusy(false)) } }
  return h('div', { className: 'bt-connector', 'data-state': 'off' },
    h('div', { className: 'bt-connector-head' },
      h('span', { className: 'bt-connector-mark' }, h(ZaloMark)),
      h('span', { className: 'bt-connector-text' },
        h('span', { className: 'bt-connector-name' }, 'Zalo'),
        h('span', { className: 'bt-connector-status' }, t('Let a Bot follow and answer Zalo chats'))),
      h('span', { className: 'bt-connector-actions' },
        login === null && unbound.length > 1
          ? h('select', { className: 'bt-select bt-zalo-bot', value: picked, onChange: event => setBotId(event.target.value) },
              unbound.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name)))
          : null,
        login === null
          ? [
              ...accounts.map(account => h('button', {
                key: account.uid, type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || unbound.length === 0,
                title: t('Share this account, no new QR scan'), onClick: () => bind(account.uid),
              }, t('Use {name}', { name: account.name || account.uid }))),
              h('button', { key: 'qr', type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || unbound.length === 0, onClick: start },
                busy ? t('Connecting…') : t('Connect')),
            ]
          : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => void actions.zaloCancel() }, t('Cancel')))),
    login !== null && login.phase === 'qr' ? h('div', { className: 'bt-zalo-qr-box' },
      login.qr !== null && login.qr !== undefined
        ? h('img', { className: 'bt-zalo-qr', src: login.qr, alt: t('Zalo login QR code') })
        : h('span', { className: 'bt-set-hint' }, t('Asking Zalo for a QR code…')),
      h('span', { className: 'bt-set-hint' }, t('Scan with the Zalo app to sign the Bot in'))) : null,
    login !== null && login.phase === 'scanned' ? h('div', { className: 'bt-zalo-qr-box' },
      h('span', { className: 'bt-set-hint' }, t('Scanned{name} — confirm on your phone', { name: login.name ? ` (${login.name})` : '' }))) : null,
    login !== null && (login.phase === 'expired' || login.phase === 'error') ? h('div', { className: 'bt-zalo-qr-box' },
      h('span', { className: 'bt-connector-error', role: 'alert' }, login.phase === 'expired' ? t('The QR code expired; try again') : (login.error ?? t('Login failed'))),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: start }, t('Try again'))) : null,
    error ? h('div', { className: 'bt-connector-error', role: 'alert' }, error) : null)
}

// The Zalo card: one account per Bot — or a shared one several Bots follow
// different threads of — QR sign-in, and per-thread modes.
export function ZaloCard({ roster, actions }) {
  const zalo = roster?.zalo ?? { bots: {}, accounts: [], login: null }
  const bots = roster?.bots ?? []
  const bound = bots.filter(bot => zalo.bots?.[bot.id]?.account !== undefined && zalo.bots?.[bot.id]?.account !== null)
  const login = zalo.login ?? null
  // An unbound card stays for the pending login even when every Bot is bound.
  const showConnect = login !== null || bound.length < bots.length
  return h('div', { className: 'bt-set-card bt-connectors-card bt-zalo-card' },
    bound.map(bot => h(ZaloBound, {
      key: bot.id, bot, entry: zalo.bots[bot.id], actions,
      shared: (zalo.accounts ?? []).find(account => account.uid === zalo.bots[bot.id]?.account?.uid)?.bots.length > 1,
    })),
    showConnect ? h(ZaloConnect, { roster, actions, login }) : null,
    bound.length === 0 && !showConnect ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No Bots to link'))) : null)
}
