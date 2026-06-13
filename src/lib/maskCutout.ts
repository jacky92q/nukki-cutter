import { cutout, type ProgressInfo, type Quality } from './removeBg'

/**
 * 지정 누끼 합성 유틸.
 *
 * AI 인식 경로는 "칠한 영역의 박스를 크롭 → 자동 모드와 동일한 ISNet 엔진으로
 * 누끼 → 원래 위치에 합성" 방식이다. 자동 모드가 동작하는 기기라면 항상 같은
 * 품질로 동작하며(엔진·캐시 공유), 모바일 GPU 의 fp16/양자화 문제가 없다.
 */

export interface MaskResult {
  /** 픽셀당 0/1 */
  data: Uint8Array
  width: number
  height: number
}

export interface Box {
  x1: number
  y1: number
  x2: number
  y2: number
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('이미지를 불러올 수 없어요.'))
    img.src = url
  })
}

function toPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('PNG 생성 실패'))),
      'image/png',
    ),
  )
}

/** 칠해진 픽셀(알파>0)의 경계 박스를 구한다. */
export function paintedBBox(paint: HTMLCanvasElement): Box | null {
  const w = paint.width
  const h = paint.height
  const ctx = paint.getContext('2d')
  if (!ctx) return null
  const d = ctx.getImageData(0, 0, w, h).data
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1
  const stride = 2
  for (let y = 0; y < h; y += stride) {
    for (let x = 0; x < w; x += stride) {
      if (d[(y * w + x) * 4 + 3] > 0) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return maxX < 0 ? null : { x1: minX, y1: minY, x2: maxX, y2: maxY }
}

/** 칠한 캔버스(알파)를 0/1 MaskResult 로 바꾼다 — "칠한 그대로" 누끼용. */
export function maskFromPaint(paint: HTMLCanvasElement): MaskResult | null {
  const w = paint.width
  const h = paint.height
  const ctx = paint.getContext('2d')
  if (!ctx) return null
  const d = ctx.getImageData(0, 0, w, h).data
  const out = new Uint8Array(w * h)
  let any = false
  for (let i = 0; i < w * h; i++) {
    if (d[i * 4 + 3] > 0) {
      out[i] = 1
      any = true
    }
  }
  return any ? { data: out, width: w, height: h } : null
}

/**
 * 마스크를 적용해 선택 영역만 남긴 투명 PNG 를 만든다.
 * feather(px)만큼 외곽을 부드럽게 풀어 경계를 자연스럽게 한다.
 */
export async function compositeCutout(
  sourceUrl: string,
  mask: MaskResult,
  feather = 1,
): Promise<Blob> {
  const { width: w, height: h } = mask
  const img = await loadImage(sourceUrl)

  const mc = document.createElement('canvas')
  mc.width = w
  mc.height = h
  const mctx = mc.getContext('2d')!
  const mi = mctx.createImageData(w, h)
  for (let i = 0; i < w * h; i++) {
    if (mask.data[i]) {
      mi.data[i * 4] = 255
      mi.data[i * 4 + 1] = 255
      mi.data[i * 4 + 2] = 255
      mi.data[i * 4 + 3] = 255
    }
  }
  mctx.putImageData(mi, 0, 0)

  const bc = document.createElement('canvas')
  bc.width = w
  bc.height = h
  const bctx = bc.getContext('2d')!
  if (feather > 0) bctx.filter = `blur(${feather}px)`
  bctx.drawImage(mc, 0, 0)
  const alpha = bctx.getImageData(0, 0, w, h).data

  const oc = document.createElement('canvas')
  oc.width = w
  oc.height = h
  const octx = oc.getContext('2d')!
  octx.drawImage(img, 0, 0, w, h)
  const od = octx.getImageData(0, 0, w, h)
  for (let i = 0; i < w * h; i++) {
    const a = alpha[i * 4 + 3]
    if (a < od.data[i * 4 + 3]) od.data[i * 4 + 3] = a
  }
  octx.putImageData(od, 0, 0)

  return toPng(oc)
}

/**
 * AI 인식 누끼.
 *
 * 핵심: 칠한 영역만 크롭해서 모델에 넣으면, 사용자가 오브젝트 전체를 칠하지
 * 않은 경우 크롭 밖의 부분(예: 모자 챙 끝)이 잘려나간다. 그래서 자동 모드와
 * 똑같이 "이미지 전체"를 ISNet 으로 누끼한 뒤(=잘림 없음), 그 결과에서
 * 사용자가 칠한 오브젝트와 "연결된 덩어리"만 골라낸다. 다른 오브젝트는 버린다.
 */
export async function aiRegionCutout(
  source: { url: string; blob: Blob },
  paint: HTMLCanvasElement,
  quality: Quality,
  onProgress?: (p: ProgressInfo) => void,
): Promise<Blob> {
  // 1) 전체 이미지로 누끼 (자동 모드와 동일 → 모자 등 오브젝트가 온전히 잡힘)
  const cutBlob = await cutout(source.blob, quality, onProgress)
  const cutImg = await loadImage(URL.createObjectURL(cutBlob))
  const W = cutImg.naturalWidth
  const H = cutImg.naturalHeight

  const oc = document.createElement('canvas')
  oc.width = W
  oc.height = H
  const octx = oc.getContext('2d')!
  octx.drawImage(cutImg, 0, 0, W, H)
  URL.revokeObjectURL(cutImg.src)
  const out = octx.getImageData(0, 0, W, H)
  const alpha = out.data

  // 2) 칠한 마스크(원본 크기일 수 있음)를 누끼 결과 크기에 맞춰 샘플링
  const pctx = paint.getContext('2d')!
  const pData = pctx.getImageData(0, 0, paint.width, paint.height).data
  const psx = paint.width / W
  const psy = paint.height / H
  const painted = (x: number, y: number): boolean => {
    const px = Math.min(paint.width - 1, Math.floor(x * psx))
    const py = Math.min(paint.height - 1, Math.floor(y * psy))
    return pData[(py * paint.width + px) * 4 + 3] > 0
  }

  // 3) 칠한 곳 ∩ 불투명 픽셀을 씨앗으로, 불투명 영역을 flood fill →
  //    칠한 오브젝트와 연결된 덩어리만 선택
  const TH = 32
  const visited = new Uint8Array(W * H)
  const stack = new Int32Array(W * H)
  let sp = 0
  let seeds = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (alpha[i * 4 + 3] > TH && painted(x, y)) {
        visited[i] = 1
        stack[sp++] = i
        seeds++
      }
    }
  }

  if (seeds === 0) {
    // 칠한 곳에 피사체가 없으면(빈 곳을 칠함) 칠한 그대로라도 내보낸다.
    const m = maskFromPaint(paint)
    if (!m) throw new Error('칠한 영역이 없어요.')
    return compositeCutout(source.url, m, 1)
  }

  while (sp > 0) {
    const i = stack[--sp]
    const x = i % W
    const y = (i - x) / W
    // 4-이웃
    if (x > 0) {
      const n = i - 1
      if (!visited[n] && alpha[n * 4 + 3] > TH) {
        visited[n] = 1
        stack[sp++] = n
      }
    }
    if (x < W - 1) {
      const n = i + 1
      if (!visited[n] && alpha[n * 4 + 3] > TH) {
        visited[n] = 1
        stack[sp++] = n
      }
    }
    if (y > 0) {
      const n = i - W
      if (!visited[n] && alpha[n * 4 + 3] > TH) {
        visited[n] = 1
        stack[sp++] = n
      }
    }
    if (y < H - 1) {
      const n = i + W
      if (!visited[n] && alpha[n * 4 + 3] > TH) {
        visited[n] = 1
        stack[sp++] = n
      }
    }
  }

  // 4) 선택된 덩어리 밖은 투명 처리
  for (let i = 0; i < W * H; i++) {
    if (!visited[i]) alpha[i * 4 + 3] = 0
  }
  octx.putImageData(out, 0, 0)
  return toPng(oc)
}
