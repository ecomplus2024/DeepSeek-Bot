// DS Bot service worker. Navigation and app code stay network-first so updates
// land immediately; only the plugin's own icon set is cache-first. Push shows a
// minimal "a Bot is waiting" note — no message content travels through the push
// service.
const STATIC_CACHE = 'ds-bot-static-v1'
const PAGE_CACHE = 'ds-bot-page-v1'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(names.filter(name => name !== STATIC_CACHE && name !== PAGE_CACHE).map(name => caches.delete(name))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (url.pathname.startsWith('/ds-bot/icons/')) {
    event.respondWith(
      caches.match(request).then(hit => hit ?? fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone()
          caches.open(STATIC_CACHE).then(cache => cache.put(request, copy))
        }
        return response
      })),
    )
    return
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone()
            caches.open(PAGE_CACHE).then(cache => cache.put('./', copy))
          }
          return response
        })
        .catch(() => caches.match('./')),
    )
  }
})

self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { /* unreadable payload */ }
  event.waitUntil(
    self.registration.showNotification(data.title || 'DS Bot', {
      body: data.body || '',
      icon: '/ds-bot/icons/icon-192.png',
      badge: '/ds-bot/icons/icon-maskable-192.png',
      tag: data.id ? `ds-bot-${data.kind}-${data.id}` : 'ds-bot-wait',
      data: { url: data.url || './' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = event.notification.data?.url || './'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (new URL(client.url).origin === self.location.origin) return client.focus()
      }
      return self.clients.openWindow(target)
    }),
  )
})
