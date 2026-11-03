import { createElement as h, Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChatsIcon, ClockIcon, GoalIcon, MicIcon, PaperclipIcon, PeopleIcon, PlusIcon, WaveIcon } from './icons.js'
import { canSetGoal } from './goal.js'
import { BotMark } from './mark.js'
import { useLinger, useViewport, viewBottom } from './motion.js'
import { usePhone } from './mobile.js'
import { dateLocale, t } from './i18n.js'
import { insertComposerNewline, sendsOnEnter } from './enter-key.js'

// -------------------------------------------------------------------------
// Composer: dictation mic and the voice-chat button. The shell's send
// button stays the submit path; CSS swaps it with the voice button while the draft is
// empty (the send button is disabled then).

export const speechApi = () => window.SpeechRecognition ?? window.webkitSpeechRecognition
const keepComposerFocus = event => event.preventDefault()

export function useDictation(onText) {
  const [listening, setListening] = useState(false)
  const [note, setNote] = useState('')
  const recognition = useRef(null)
  const latest = useRef(onText)
  latest.current = onText
  useEffect(() => () => recognition.current?.abort(), [])
  useEffect(() => {
    if (!note) return undefined
    const timer = setTimeout(() => setNote(''), 2600)
    return () => clearTimeout(timer)
  }, [note])
  const start = ({ continuous = true, onEnd } = {}) => {
    const Api = speechApi()
    if (!Api) { setNote(t('Dictation is not available in this browser')); return false }
    const engine = new Api()
    engine.lang = navigator.language || dateLocale()
    engine.interimResults = true
    engine.continuous = continuous
    engine.onresult = (event) => {
      let interim = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        const text = result[0]?.transcript ?? ''
        if (result.isFinal) { if (text.trim()) latest.current(text, true) } else interim += text
      }
      if (interim) latest.current(interim, false)
    }
    engine.onerror = (event) => {
      if (event.error === 'aborted' || event.error === 'no-speech') return
      setNote(event.error === 'not-allowed' || event.error === 'service-not-allowed' ? t('Microphone access is blocked') : t("Couldn't hear that"))
    }
    engine.onend = () => { setListening(false); recognition.current = null; onEnd?.() }
    recognition.current = engine
    try { engine.start(); setListening(true); return true } catch { setNote(t("Couldn't start dictation")); return false }
  }
  const stop = () => recognition.current?.stop()
  return { listening, note, start, stop }
}

export function ComposerVoice({ sessionId, inputActions, actions, useUi, useRoster }) {
  const enterToSend = useRoster(state => sendsOnEnter(state.prefs))
  const composerRoot = useRef(null)
  useEffect(() => {
    const root = composerRoot.current?.closest('[data-composer-card]')
    if (enterToSend || !inputActions || !root) return undefined
    const onKey = event => insertComposerNewline(event, inputActions)
    root.addEventListener('keydown', onKey, true)
    return () => root.removeEventListener('keydown', onKey, true)
  }, [enterToSend, inputActions])
  const dictation = useDictation((text, final) => {
    if (final && inputActions) inputActions.insertText(text, inputActions.captureInsertion())
  })
  // Reply from a message's hover toolbar quotes it into this composer.
  const quote = useUi(state => (state.quote?.sessionId === sessionId ? state.quote : null))
  useEffect(() => {
    if (!quote || !inputActions) return
    actions.clearQuote(quote.token)
    const excerpt = quote.text.replace(/\s+/g, ' ').trim()
    const line = `> ${excerpt.length > 200 ? `${excerpt.slice(0, 200)}…` : excerpt}\n\n`
    inputActions.insertText(line, inputActions.captureInsertion())
    const box = document.querySelector('[class*="_centerCol"] [role=textbox][contenteditable=true]')
    if (box instanceof HTMLElement) {
      box.focus()
      const selection = window.getSelection()
      selection?.selectAllChildren(box)
      selection?.collapseToEnd()
    }
  }, [quote?.token])
  if (sessionId === undefined) return null
  // With the Voice Input plugin on, its own microphone sits in this composer.
  const pluginMic = actions.speech() !== undefined
  return h(Fragment, null,
    pluginMic ? null : h('button', {
      type: 'button', className: 'bt-mic', 'aria-label': dictation.listening ? t('Stop dictation') : t('Dictate'),
      'aria-pressed': dictation.listening, title: dictation.listening ? t('Stop dictation') : t('Dictate'),
      onMouseDown: keepComposerFocus, onClick: () => (dictation.listening ? dictation.stop() : dictation.start()),
    }, h(MicIcon)),
    h('button', {
      ref: composerRoot, type: 'button', className: 'bt-voice', 'aria-label': t('Start voice chat'), title: t('Voice chat'),
      onMouseDown: keepComposerFocus, onClick: () => actions.openVoice(sessionId),
    }, h(WaveIcon, { size: 18 })),
    dictation.note ? h('span', { className: 'bt-mic-note', role: 'status' }, dictation.note) : null)
}

// Character marks for the "@" menu rows. Each Bot keeps one component, so the menu
// does not remount its mark on every keystroke.
export function menuIcons(roster) {
  const marks = new Map()
  return (row) => {
    if (!row.bot) return PeopleIcon
    const id = row.bot.id
    if (!marks.has(id)) marks.set(id, ({ size = 14 }) => h(BotMark, { bot: roster.getSnapshot().byId[id] ?? row.bot, size }))
    return marks.get(id)
  }
}

// The composer's "+" in a Bot's chat or a group chat: add files, reference another
// chat, or set a scheduled task for this chat. It stands in for the shell's command
// menu, whose plan, permission, model and compact rows reach past what DS Bot keeps
// for its Bots; "/" still opens that menu. Files go through the shell's own file
// input beside it.
export function ComposerPlus({ sessionId, inputActions, useRoster, actions }) {
  const roster = useRoster(value => value)
  const phone = usePhone()
  const [open, setOpen] = useState(null)
  const [shown, leaving] = useLinger(open, 120)
  const button = useRef(null)
  const menu = useRef(null)
  const tick = useViewport()
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => { if (![button.current, menu.current].some(node => node?.contains(event.target))) setOpen(null) }
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(null) } }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown, true); window.removeEventListener('keydown', onKey, true) }
  }, [open])
  // Hooks stay above the early return below: the roster may not know the Bot yet, and a
  // render that skips a hook breaks the composer's slot when the roster arrives.
  // Anchored to the "+" each render: the visible viewport can move (on-screen
  // keyboard) while the menu is open.
  const place = useMemo(() => {
    if (!shown || !button.current) return null
    const rect = button.current.getBoundingClientRect()
    return { left: rect.left, bottom: viewBottom() - rect.top + 8 }
  }, [shown, open, tick])
  const target = roster.byId?.[sessionId]?.id ?? roster.roomsById?.[sessionId]?.id
  if (sessionId === undefined || target === undefined) return null
  const fileInput = () => button.current?.closest('[data-composer-card]')?.querySelector('input[type=file]')
  const toggle = () => {
    if (open) { setOpen(null); return }
    // Files go through the composer's own file input; a composer without one takes none.
    setOpen({ files: Boolean(fileInput()) })
  }
  const attach = () => {
    setOpen(null)
    fileInput()?.click()
  }
  const schedule = () => {
    setOpen(null)
    actions.openSettings('schedules', target)
  }
  // The chats open in the shell's "@" menu at the caret, so the pick lands where the
  // user was typing.
  const reference = () => {
    setOpen(null)
    actions.referenceChat(sessionId, inputActions?.captureInsertion?.())
  }
  const canReference = typeof inputActions?.captureInsertion === 'function' && actions.canReferenceChat()
  const room = roster.roomsById?.[sessionId]
  const goal = () => {
    setOpen(null)
    actions.composeGoal(room.id)
  }
  return h(Fragment, null,
    h('button', {
      ref: button, type: 'button', className: 'bt-plus', 'aria-label': t('Add'), title: t('Add'),
      'aria-haspopup': 'menu', 'aria-expanded': Boolean(open), onMouseDown: keepComposerFocus, onClick: toggle,
    }, h(PlusIcon)),
    shown ? createPortal(h('div', {
      ref: menu, className: `bt-menu bt-menu-up bt-plus-menu${phone ? ' bt-sheet' : ''}`, role: 'menu', 'aria-label': t('Add'),
      style: phone ? undefined : (place ?? {}), 'data-leaving': leaving || undefined,
    },
    shown.files ? h('button', { type: 'button', role: 'menuitem', onClick: attach }, h(PaperclipIcon), h('span', { className: 'bt-menu-label' }, t('Add files'))) : null,
    canReference ? h('button', { type: 'button', role: 'menuitem', onMouseDown: keepComposerFocus, onClick: reference }, h(ChatsIcon), h('span', { className: 'bt-menu-label' }, t('Reference a chat'))) : null,
    canSetGoal(room, roster) ? h('button', { type: 'button', role: 'menuitem', onClick: goal }, h(GoalIcon), h('span', { className: 'bt-menu-label' }, t('Set a goal'))) : null,
    h('button', { type: 'button', role: 'menuitem', onClick: schedule }, h(ClockIcon), h('span', { className: 'bt-menu-label' }, t('Scheduled task')))), document.body) : null)
}

// A message on its way: its pictures upload, then the prompt is admitted, before the turn
// starts. On a slow link that is a long silence with the send button simply greyed out,
// so the dock above the composer says what it waits for - after a moment, so a quick
// send shows nothing at all. A queued message is the shell's own dock, so only a
// transcript or steering send counts here.
const SEND_NOTE_MS = 500

// The composer holds a draft attachment the shell cannot send yet: an upload is still
// running. The shell shows no progress for a picture, only a greyed send button.
function useDraftUploading() {
  const [uploading, setUploading] = useState(false)
  useEffect(() => {
    const read = () => {
      const card = document.querySelector('[data-composer-card]')
      if (card === null) { setUploading(false); return }
      const held = card.querySelector('[data-slot="conversation.input.attachments"] [role=group] > *') !== null
      const send = card.querySelector('button[class*="_primary"]')
      setUploading(held && send !== null && send.disabled === true)
    }
    const observer = new MutationObserver(read)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] })
    read()
    return () => observer.disconnect()
  }, [])
  return uploading
}

export function SendingDock({ sessionId, useSession }) {
  const sending = useSession(snapshot => (snapshot?.pendingSubmissions ?? []).some(submission => submission.placement !== 'queued'))
  const pictures = useSession(snapshot => (snapshot?.pendingSubmissions ?? []).some(submission => submission.placement !== 'queued'
    && (submission.attachments ?? []).some(attachment => attachment.type === 'image')))
  const uploading = useDraftUploading()
  const waiting = uploading || sending
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!waiting) { setShown(false); return undefined }
    const timer = setTimeout(() => setShown(true), SEND_NOTE_MS)
    return () => clearTimeout(timer)
  }, [waiting])
  if (!shown || sessionId === undefined) return null
  const text = uploading ? t('Uploading an attachment…') : pictures ? t('Sending an image…') : t('Sending…')
  return h('div', { className: 'bt-send-dock', role: 'status' },
    h('span', { className: 'bt-send-spin', 'aria-hidden': true }),
    h('span', { className: 'bt-send-text' }, text))
}

export const SENDING_CSS = `
.bt-send-dock{display:flex;align-items:center;gap:8px;width:max-content;max-width:min(420px,calc(100% - 32px));height:30px;margin:0 auto 8px;padding:0 13px;box-sizing:border-box;border-radius:999px;background:var(--bt-main);box-shadow:0 0 0 .5px var(--bt-line-2),0 2px 8px -2px rgba(0,0,0,.12);color:var(--bt-ink-2);font-size:13px;line-height:18px;animation:bt-veil-in .18s ease-out backwards}
.bt-send-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-send-spin{flex:none;width:12px;height:12px;box-sizing:border-box;border-radius:50%;border:1.5px solid color-mix(in srgb,var(--bt-ink) 18%,transparent);border-top-color:var(--bt-ink-2);animation:bt-send-spin .7s linear infinite}
@keyframes bt-send-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.bt-send-dock{animation:none}.bt-send-spin{animation-duration:2s}}
`
