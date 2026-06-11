/* Nukki Cutter 서비스 워커 — 설치형(PWA) 동작 + 동일 출처 자산 오프라인 캐싱.
 * 이미지/모델 처리는 모두 브라우저 안에서 일어나므로, 한 번 방문하면 오프라인에서도 동작한다. */

const CACHE = 'nukki-cache-v1'

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
  // 외부 출처(모델 CDN 등)는 각 라이브러리가 알아서 캐싱하므로 건드리지 않는다.
  if (url.origin !== self.location.origin) return

  // 페이지 이동: 네트워크 우선, 실패 시 캐시된 앱 셸로 폴백.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE)
        try {
          const fresh = await fetch(req)
          cache.put(req, fresh.clone())
          return fresh
        } catch {
          return (
            (await cache.match(req)) ||
            (await cache.match('./')) ||
            Response.error()
          )
        }
      })(),
    )
    return
  }

  // 그 외 동일 출처 자산: stale-while-revalidate.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE)
      const cached = await cache.match(req)
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            cache.put(req, res.clone())
          }
          return res
        })
        .catch(() => cached)
      return cached || network
    })(),
  )
})
