/* Nukki Cutter 서비스 워커 (v2)
 *
 * 재배포 후 "옛 번들이 사라진 청크를 요청 → 깨짐" 문제를 막기 위해:
 *  - 내비게이션(HTML): 네트워크 우선 + 서버 재검증(no-cache) → 항상 최신 index 를 받는다.
 *  - 콘텐츠 해시가 붙은 /assets/ 자산: 불변이므로 캐시 우선(빠름 · 오프라인).
 *  - 그 외 동일 출처: 네트워크 우선, 실패 시 캐시 폴백.
 * 응답으로 절대 undefined 를 반환하지 않는다.
 */

const CACHE = 'nukki-cache-v2'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return // 외부(모델 CDN 등)는 건드리지 않음

  // 1) 내비게이션: 네트워크 우선 + 서버 재검증으로 항상 최신 셸을 받는다.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE)
        try {
          const fresh = await fetch(req, { cache: 'no-cache' })
          if (fresh && fresh.ok) cache.put(req, fresh.clone())
          return fresh
        } catch {
          return (
            (await cache.match(req)) ||
            (await cache.match('./')) ||
            new Response('오프라인 상태예요.', {
              status: 503,
              headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            })
          )
        }
      })(),
    )
    return
  }

  // 2) 콘텐츠 해시가 붙은 빌드 자산: 불변이므로 캐시 우선.
  if (url.pathname.includes('/assets/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE)
        const cached = await cache.match(req)
        if (cached) return cached
        try {
          const res = await fetch(req)
          // 정상 응답만 캐시(404 HTML 등을 캐시해 두지 않도록).
          if (res && res.ok && res.type === 'basic') cache.put(req, res.clone())
          return res
        } catch {
          return new Response('', { status: 504 })
        }
      })(),
    )
    return
  }

  // 3) 그 외 동일 출처(매니페스트·아이콘 등): 네트워크 우선, 실패 시 캐시.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE)
      try {
        const res = await fetch(req)
        if (res && res.ok && res.type === 'basic') cache.put(req, res.clone())
        return res
      } catch {
        return (await cache.match(req)) || new Response('', { status: 504 })
      }
    })(),
  )
})
