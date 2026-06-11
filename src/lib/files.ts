/** 업로드/누끼 처리에서 공통으로 쓰는 파일 유틸. */

export const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp']

export interface Loaded {
  /** 사용자가 올린 원본 파일(이름 용도) */
  file: File
  /** 정규화된 이미지의 object URL (미리보기·합성용) */
  url: string
  /** 정규화된 이미지 Blob (모든 엔진에 이걸 넘긴다) */
  blob: Blob
  width: number
  height: number
}

/** 원본 파일명에서 확장자를 떼고 누끼 결과용 PNG 이름을 만든다. */
export function outputName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '')
  return `${base || 'image'}-nukki.png`
}

/** 결과 Blob 을 파일로 즉시 내려받는다. */
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 다운로드가 시작될 시간을 준 뒤 해제.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function decodeViaImg(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const u = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(u)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(u)
      reject(new Error('이미지를 해석할 수 없어요.'))
    }
    img.src = u
  })
}

/**
 * 업로드 이미지를 브라우저에서 직접 디코딩해 정규화한다.
 * - EXIF 회전을 보정하고(모바일 사진 방향 문제 방지)
 * - 너무 큰 사진은 maxSide 기준으로 축소한다.
 * 고해상도 모바일 원본을 그대로 엔진에 넘기면
 * "The source image could not be decoded" 류 오류가 나는 것을 막는다.
 */
export async function normalizeImage(
  file: File,
  maxSide = 2560,
): Promise<{ blob: Blob; width: number; height: number }> {
  let src: ImageBitmap | HTMLImageElement
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    src = await decodeViaImg(file)
  }

  const sw = src instanceof HTMLImageElement ? src.naturalWidth : src.width
  const sh = src instanceof HTMLImageElement ? src.naturalHeight : src.height
  if (!sw || !sh) throw new Error('이미지 크기를 읽을 수 없어요.')

  const scale = Math.min(1, maxSide / Math.max(sw, sh))
  const w = Math.max(1, Math.round(sw * scale))
  const h = Math.max(1, Math.round(sh * scale))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 컨텍스트를 만들 수 없어요.')
  ctx.drawImage(src, 0, 0, w, h)
  if (src instanceof ImageBitmap) src.close()

  // 투명도가 있는 PNG 는 PNG 로, 그 외(사진)는 JPEG 로 재인코딩해 메모리를 아낀다.
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('이미지 변환에 실패했어요.'))),
      type,
      0.95,
    ),
  )
  return { blob, width: w, height: h }
}
