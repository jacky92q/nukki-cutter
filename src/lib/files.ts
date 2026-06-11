/** 업로드/누끼 처리에서 공통으로 쓰는 파일 유틸. */

export const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp']

export interface Loaded {
  file: File
  url: string
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
