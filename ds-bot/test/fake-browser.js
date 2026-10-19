// A fake puppeteer Page/Browser pair shared by the browser-driving tests
// (gemlogin.test.js, chromium.test.js). The page answers extractPage with a small
// fixed page, records clicks/typed text/CDP window calls, and pretends every other
// page API succeeds.
import { extractPage } from '../src/host/browse.js'

export function fakePage(url = 'about:blank') {
  const page = {
    _url: url,
    _closed: false,
    clicks: [],
    typed: [],
    mouseClicks: [],
    cdpCalls: [],
    _bounds: { left: 50, top: 50, width: 1280, height: 800, windowState: 'normal' },
    createCDPSession: async () => ({
      send: async (method, params) => {
        page.cdpCalls.push([method, params])
        if (method === 'Browser.getWindowForTarget') return { windowId: 1, bounds: page._bounds }
        if (method === 'Browser.setWindowBounds') page._bounds = { ...page._bounds, ...params.bounds }
        return {}
      },
    }),
    bringToFront: async () => {},
    url() { return page._url },
    isClosed() { return page._closed },
    title: async () => 'Fake title',
    goto: async (u) => { page._url = u },
    evaluate: async (fn, ...rest) => {
      if (fn === extractPage) {
        const scoped = rest[1]
        if (scoped === 'no-such') return { error: `Nothing matches "${scoped}".` }
        return { title: 'Fake title', url: page._url, text: scoped === undefined ? 'page body' : `page body in ${scoped}`, items: [{ role: 'link', name: 'More', href: 'https://x/' }] }
      }
      if (typeof fn === 'function') return undefined
      return 'eval-result'
    },
    click: async (selector) => { page.clicks.push(selector) },
    type: async (selector, text) => { page.typed.push([selector, text]) },
    mouse: { click: async (x, y) => { page.mouseClicks.push([x, y]) } },
    viewport: () => ({ width: 1280, height: 800 }),
    focus: async () => {},
    keyboard: { press: async () => {} },
    screenshot: async () => Buffer.from('jpeg-bytes'),
    waitForSelector: async (selector) => {
      if (selector === 'no-such') return null
      return {
        evaluate: async () => {},
        clickablePoint: async () => { page.clicks.push(selector); return { x: 640, y: 200 } },
        dispose: async () => {},
        _selector: selector,
      }
    },
    goBack: async () => ({}),
    goForward: async () => ({}),
    reload: async () => ({}),
  }
  return page
}

export function fakeBrowser() {
  const browser = {
    connected: true,
    _pages: [fakePage('https://start.example/')],
    pages: async () => browser._pages.filter(page => !page.isClosed()),
    newPage: async () => { const page = fakePage('about:blank'); browser._pages.push(page); return page },
    disconnect: async () => { browser.connected = false },
    close: async () => { browser.connected = false },
    version: async () => 'fake-chromium',
    process: () => ({ kill: () => { browser.connected = false } }),
  }
  return browser
}
