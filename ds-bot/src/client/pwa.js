// PWA client: service-worker registration and the Web Push subscription the
// settings toggle drives. All of it is a no-op where the browser cannot do it
// (http origins, Desktop, no PushManager).
import { call } from './api.js'

export const pushSupported = () => window.isSecureContext
  && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

export function installPwa() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return
  navigator.serviceWorker.register('/sw.js').catch(() => {})
}

export const pushSubscribed = async () => {
  if (!pushSupported()) return null
  const registration = await navigator.serviceWorker.getRegistration('/')
  return (await registration?.pushManager.getSubscription()) ?? null
}

const urlB64ToUint8 = (value) => {
  const padded = `${value.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat((4 - (value.length % 4)) % 4)}`
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0))
}

export async function subscribePush() {
  const { enabled, publicKey } = await call('push-key')
  if (!enabled || !publicKey) throw new Error('Push is not running on this host')
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Notifications are off for this device')
  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlB64ToUint8(publicKey),
  })
  await call('push-subscribe', subscription.toJSON())
  return subscription
}

export async function unsubscribePush() {
  const subscription = await pushSubscribed()
  if (subscription === null) return
  await call('push-unsubscribe', { endpoint: subscription.endpoint }).catch(() => {})
  await subscription.unsubscribe()
}
