/**
 * 누끼 모델(@imgly/background-removal-data)을 빌드 산출물에 포함시키기 위해
 * CDN 에서 내려받아 public/imgly/ 에 저장한다.
 *
 * 이렇게 셀프호스팅하면 배포된 사이트가 같은 도메인에서 모델을 받으므로
 * staticimgly.com 이 차단된 회사망에서도 동작한다.
 *
 * 네트워크가 막힌 환경(로컬 샌드박스 등)에서는 경고만 남기고 통과한다 —
 * 런타임에 셀프호스트 실패 시 CDN 으로 폴백하므로 치명적이지 않다.
 */
import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '1.7.0' // @imgly/background-removal 패키지 버전과 일치해야 한다
const BASE = `https://staticimgly.com/@imgly/background-removal-data/${VERSION}/dist/`
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'imgly')

// quint8 모델은 앱에서 쓰지 않으므로 제외해 용량을 줄인다.
const SKIP = /quint8/

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

try {
  const res = await fetch(BASE + 'resources.json')
  if (!res.ok) throw new Error(`resources.json HTTP ${res.status}`)
  const manifest = await res.json()

  let total = 0
  let downloaded = 0
  let bytes = 0
  const kept = {}

  for (const [key, entry] of Object.entries(manifest)) {
    if (SKIP.test(key)) continue
    kept[key] = entry
    for (const chunk of entry.chunks ?? []) {
      const name = String(chunk.name ?? '').replace(/^\.?\//, '')
      if (!name) continue
      total++
      const target = join(OUT, name)
      if (await exists(target)) continue
      await mkdir(dirname(target), { recursive: true })
      const r = await fetch(new URL(name, BASE))
      if (!r.ok) throw new Error(`${name} HTTP ${r.status}`)
      const buf = Buffer.from(await r.arrayBuffer())
      await writeFile(target, buf)
      downloaded++
      bytes += buf.length
    }
  }

  await mkdir(OUT, { recursive: true })
  await writeFile(join(OUT, 'resources.json'), JSON.stringify(kept))
  console.log(
    `[fetch-models] OK — chunks total=${total}, downloaded=${downloaded} (${(bytes / 1e6).toFixed(1)} MB) -> public/imgly/`,
  )
} catch (err) {
  console.warn(
    `[fetch-models] WARN — 모델 다운로드 실패(${err?.message ?? err}). ` +
      '셀프호스트 없이 빌드를 계속합니다(런타임에 CDN 폴백).',
  )
}
