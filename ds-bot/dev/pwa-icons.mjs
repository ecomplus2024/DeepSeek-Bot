// PWA icon generator: renders the DS Bot whale mark (MAIN_LOOK) to PNGs under
// src/host/pwa/ through a headless Chrome canvas. Run a headless Chrome with
// --remote-debugging-port first, then:
//   node dev/pwa-icons.mjs [cdp-port]
// The art is the plugin's own mark; no external assets are involved.
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { characterMarkup, MASK_ID } from '../src/client/characters.js'

const PORT = Number(process.argv[2] ?? 9223)
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'host', 'pwa')
const BG = '#4D6BFE' // deepseek ink, light
const WHALE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${characterMarkup('whale', '#FFFFFF').replaceAll(MASK_ID, 'w')}</svg>`

// [file, pixel size, mark coverage] — the maskable pair keeps the mark inside the
// platform's central safe circle.
const ICONS = [
  ['icon-192.png', 192, 0.8],
  ['icon-512.png', 512, 0.8],
  ['icon-maskable-192.png', 192, 0.64],
  ['icon-maskable-512.png', 512, 0.64],
]

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find(t => t.type === 'page') ?? list[0]
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let seq = 0
const pending = new Map()
ws.onmessage = ({ data }) => {
  const message = JSON.parse(data)
  if (message.id === undefined) return
  const { resolve, reject } = pending.get(message.id)
  pending.delete(message.id)
  if (message.error) reject(new Error(message.error.message))
  else resolve(message.result)
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})

await mkdir(OUT, { recursive: true })
for (const [file, size, scale] of ICONS) {
  const { result } = await send('Runtime.evaluate', {
    returnByValue: true,
    awaitPromise: true,
    expression: `(async (svg, size, scale, bg) => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = size
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, size, size)
      const img = new Image()
      img.src = 'data:image/svg+xml;base64,' + btoa(svg)
      await img.decode()
      const mark = Math.round(size * scale)
      ctx.drawImage(img, Math.round((size - mark) / 2), Math.round((size - mark) / 2), mark, mark)
      return canvas.toDataURL('image/png')
    })(${JSON.stringify(WHALE)}, ${size}, ${scale}, ${JSON.stringify(BG)})`,
  })
  const base64 = result.value.replace(/^data:image\/png;base64,/, '')
  await writeFile(join(OUT, file), Buffer.from(base64, 'base64'))
  console.log('wrote', file, `${size}px`)
}
ws.close()
