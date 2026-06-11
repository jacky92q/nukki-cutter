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

interface EdgeTouch {
  left: number
  right: number
  top: number
  bottom: number
}

/** 박스를 크롭→ISNet 누끼 후, 결과 알파가 크롭 가장자리에 닿았는지도 분석한다. */
async function cutAndAnalyze(
  img: HTMLImageElement,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  quality: Quality,
  onProgress?: (p: ProgressInfo) => void,
): Promise<{ canvas: HTMLCanvasElement; touch: EdgeTouch; cw: number; ch: number }> {
  const cw = x2 - x1
  const ch = y2 - y1

  // 작은 오브젝트는 크롭을 1024px 까지 고품질 확대해서 추론한다.
  // 모델 입력 해상도를 꽉 채워 쓰게 되어 경계 매트가 훨씬 정밀해진다.
  // (결과는 다시 원본 크기로 줄여 합성 — 픽셀 정보는 원본 그대로)
  const TARGET = 1024
  const f = Math.max(cw, ch) < TARGET ? TARGET / Math.max(cw, ch) : 1
  const iw = Math.round(cw * f)
  const ih = Math.round(ch * f)

  const cc = document.createElement('canvas')
  cc.width = iw
  cc.height = ih
  const cctx = cc.getContext('2d')!
  cctx.imageSmoothingEnabled = true
  cctx.imageSmoothingQuality = 'high'
  cctx.drawImage(img, x1, y1, cw, ch, 0, 0, iw, ih)
  const cropBlob = await toPng(cc)

  const cutBlob = await cutout(cropBlob, quality, onProgress)
  const u = URL.createObjectURL(cutBlob)
  try {
    const cutImg = await loadImage(u)
    const ac = document.createElement('canvas')
    ac.width = cw
    ac.height = ch
    const actx = ac.getContext('2d')!
    actx.imageSmoothingEnabled = true
    actx.imageSmoothingQuality = 'high'
    actx.drawImage(cutImg, 0, 0, iw, ih, 0, 0, cw, ch)
    const d = actx.getImageData(0, 0, cw, ch).data
    const touch: EdgeTouch = { left: 0, right: 0, top: 0, bottom: 0 }
    for (let y = 0; y < ch; y++) {
      if (d[(y * cw + 1) * 4 + 3] > 16) touch.left++
      if (d[(y * cw + cw - 2) * 4 + 3] > 16) touch.right++
    }
    for (let x = 0; x < cw; x++) {
      if (d[(cw + x) * 4 + 3] > 16) touch.top++
      if (d[((ch - 2) * cw + x) * 4 + 3] > 16) touch.bottom++
    }
    return { canvas: ac, touch, cw, ch }
  } finally {
    URL.revokeObjectURL(u)
  }
}

/**
 * AI 인식 누끼: 칠한 영역의 박스(+여유)를 크롭해 ISNet 으로 피사체를 추출하고,
 * 결과를 원본 좌표에 합성한 전체 크기 투명 PNG 를 돌려준다.
 *
 * 누끼 결과가 크롭 가장자리에 닿아 있으면(=오브젝트가 잘린 신호) 닿은 방향으로
 * 박스를 자동 확장해 최대 2회 재시도한다 — 대충 칠해도 오브젝트가 잘리지 않게.
 */
export async function aiRegionCutout(
  sourceUrl: string,
  paint: HTMLCanvasElement,
  quality: Quality,
  onProgress?: (p: ProgressInfo) => void,
): Promise<Blob> {
  const box = paintedBBox(paint)
  if (!box) throw new Error('칠한 영역이 없어요.')

  const img = await loadImage(sourceUrl)
  const W = img.naturalWidth
  const H = img.naturalHeight

  // 칠한 박스에 18%(최소 24px) 여유를 둔 시작 박스.
  const mx = Math.max(24, (box.x2 - box.x1) * 0.18)
  const my = Math.max(24, (box.y2 - box.y1) * 0.18)
  let x1 = Math.max(0, Math.floor(box.x1 - mx))
  let y1 = Math.max(0, Math.floor(box.y1 - my))
  let x2 = Math.min(W, Math.ceil(box.x2 + mx))
  let y2 = Math.min(H, Math.ceil(box.y2 + my))
  if (x2 - x1 < 8 || y2 - y1 < 8) throw new Error('칠한 영역이 너무 작아요.')

  for (let attempt = 0; ; attempt++) {
    const used = { x1, y1, x2, y2 }
    const r = await cutAndAnalyze(img, x1, y1, x2, y2, quality, onProgress)

    // 가장자리에 닿은 변이 있으면 그 방향으로 30% 확장해 재시도.
    const thX = Math.max(4, r.cw * 0.02)
    const thY = Math.max(4, r.ch * 0.02)
    const growX = Math.ceil((x2 - x1) * 0.3)
    const growY = Math.ceil((y2 - y1) * 0.3)
    let grew = false
    if (attempt < 2) {
      if (r.touch.left > thY && x1 > 0) {
        x1 = Math.max(0, x1 - growX)
        grew = true
      }
      if (r.touch.right > thY && x2 < W) {
        x2 = Math.min(W, x2 + growX)
        grew = true
      }
      if (r.touch.top > thX && y1 > 0) {
        y1 = Math.max(0, y1 - growY)
        grew = true
      }
      if (r.touch.bottom > thX && y2 < H) {
        y2 = Math.min(H, y2 + growY)
        grew = true
      }
    }
    if (grew) {
      onProgress?.({ stage: '잘린 부분 감지 — 영역 넓혀 다시 인식 중', ratio: 0 })
      continue
    }

    // 전체 크기 캔버스의 원래 위치에 합성.
    const oc = document.createElement('canvas')
    oc.width = W
    oc.height = H
    oc.getContext('2d')!.drawImage(r.canvas, used.x1, used.y1)
    return toPng(oc)
  }
}
