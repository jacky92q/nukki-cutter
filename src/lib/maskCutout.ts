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
 * AI 인식 누끼: 칠한 영역의 박스(+여유)를 크롭해 ISNet 으로 피사체를 추출하고,
 * 결과를 원본 좌표에 그대로 합성한 전체 크기 투명 PNG 를 돌려준다.
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

  // 칠한 박스에 12%(최소 16px) 여유를 둬 오브젝트 가장자리가 잘리지 않게 한다.
  const mx = Math.max(16, (box.x2 - box.x1) * 0.12)
  const my = Math.max(16, (box.y2 - box.y1) * 0.12)
  const x1 = Math.max(0, Math.floor(box.x1 - mx))
  const y1 = Math.max(0, Math.floor(box.y1 - my))
  const x2 = Math.min(W, Math.ceil(box.x2 + mx))
  const y2 = Math.min(H, Math.ceil(box.y2 + my))
  const cw = x2 - x1
  const ch = y2 - y1
  if (cw < 8 || ch < 8) throw new Error('칠한 영역이 너무 작아요.')

  // 1) 크롭
  const cc = document.createElement('canvas')
  cc.width = cw
  cc.height = ch
  cc.getContext('2d')!.drawImage(img, x1, y1, cw, ch, 0, 0, cw, ch)
  const cropBlob = await toPng(cc)

  // 2) 크롭 조각에서 피사체 추출(자동 모드와 동일 엔진)
  const cutBlob = await cutout(cropBlob, quality, onProgress)

  // 3) 전체 크기 캔버스의 원래 위치에 합성
  const u = URL.createObjectURL(cutBlob)
  try {
    const cutImg = await loadImage(u)
    const oc = document.createElement('canvas')
    oc.width = W
    oc.height = H
    oc.getContext('2d')!.drawImage(cutImg, x1, y1)
    return await toPng(oc)
  } finally {
    URL.revokeObjectURL(u)
  }
}
