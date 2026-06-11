import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { triggerDownload } from '../lib/files'

interface Props {
  blob: Blob
  filename: string
  onClose: () => void
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 누끼 결과 확인 팝업.
 * - 결과를 미리 보고 다운로드 여부를 결정한다.
 * - "여백 잘라내기"로 투명 여백을 제거해 오브젝트만 남길 수 있다.
 * - 크기 슬라이더(×1~×4)로 키워서 저장할 수 있다.
 */
export default function ResultModal({ blob, filename, onClose }: Props) {
  const url = useMemo(() => URL.createObjectURL(blob), [blob])
  useEffect(() => () => URL.revokeObjectURL(url), [url])

  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [trimBox, setTrimBox] = useState<Rect | null>(null)
  const [trim, setTrim] = useState(false)
  const [scale, setScale] = useState(1)
  const [saving, setSaving] = useState(false)
  const previewRef = useRef<HTMLCanvasElement>(null)

  // 결과 로드 + 오브젝트(불투명 영역) 경계 박스 계산
  useEffect(() => {
    let cancelled = false
    const i = new Image()
    i.onload = () => {
      if (cancelled) return
      setImg(i)
      const w = i.naturalWidth
      const h = i.naturalHeight
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const ctx = c.getContext('2d')
      if (!ctx) return
      ctx.drawImage(i, 0, 0)
      const d = ctx.getImageData(0, 0, w, h).data
      let minX = w
      let minY = h
      let maxX = -1
      let maxY = -1
      const stride = 2
      for (let y = 0; y < h; y += stride) {
        for (let x = 0; x < w; x += stride) {
          if (d[(y * w + x) * 4 + 3] > 8) {
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
          }
        }
      }
      if (maxX >= 0) {
        const pad = Math.max(8, Math.round(Math.max(w, h) * 0.02))
        const x = Math.max(0, minX - pad)
        const y = Math.max(0, minY - pad)
        const box: Rect = {
          x,
          y,
          w: Math.min(w, maxX + pad) - x,
          h: Math.min(h, maxY + pad) - y,
        }
        setTrimBox(box)
        // 오브젝트가 전체의 절반 미만이면 기본으로 여백 제거를 켠다.
        if (box.w * box.h < w * h * 0.5) setTrim(true)
      }
    }
    i.src = url
    return () => {
      cancelled = true
    }
  }, [url])

  // ESC 로 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const rect: Rect | null = img
    ? trim && trimBox
      ? trimBox
      : { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight }
    : null

  // 미리보기 그리기 (현재 선택 영역)
  useEffect(() => {
    const canvas = previewRef.current
    if (!canvas || !img || !rect) return
    const maxW = 520
    const maxH = 320
    const s = Math.min(maxW / rect.w, maxH / rect.h, 1)
    canvas.width = Math.max(1, Math.round(rect.w * s))
    canvas.height = Math.max(1, Math.round(rect.h * s))
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, trim, trimBox])

  const outW = rect ? Math.round(rect.w * scale) : 0
  const outH = rect ? Math.round(rect.h * scale) : 0

  const save = useCallback(async () => {
    if (!img || !rect) return
    setSaving(true)
    try {
      const c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(rect.w * scale))
      c.height = Math.max(1, Math.round(rect.h * scale))
      const ctx = c.getContext('2d')
      if (!ctx) throw new Error('canvas 컨텍스트를 만들 수 없어요.')
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, c.width, c.height)
      const out = await new Promise<Blob>((resolve, reject) =>
        c.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('PNG 생성 실패'))),
          'image/png',
        ),
      )
      triggerDownload(out, filename)
    } finally {
      setSaving(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, trim, trimBox, scale, filename])

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label="누끼 결과"
    >
      <div className="modal">
        <h2 className="modal__title">✓ 누끼 완료 — 결과를 확인하세요</h2>

        <div className="modal__preview">
          <canvas ref={previewRef} />
        </div>

        <div className="modal__row">
          <label className="modal__check">
            <input
              type="checkbox"
              checked={trim}
              disabled={!trimBox}
              onChange={(e) => setTrim(e.target.checked)}
            />
            여백 잘라내기 (오브젝트만)
          </label>
        </div>

        <div className="modal__row">
          <label className="modal__scale">
            크기 ×{scale.toFixed(2).replace(/\.?0+$/, '')}
            <input
              type="range"
              min={1}
              max={4}
              step={0.25}
              value={scale}
              onChange={(e) => setScale(Number(e.target.value))}
            />
          </label>
          <span className="modal__dims">
            출력: {outW} × {outH} px
            {scale > 1 && ' · 확대 시 약간 흐려질 수 있어요'}
          </span>
        </div>

        <div className="modal__actions">
          <button className="btn btn--ghost" onClick={onClose}>
            닫기
          </button>
          <button className="btn btn--primary" onClick={save} disabled={saving || !img}>
            {saving ? '저장 중…' : '⬇ PNG 다운로드'}
          </button>
        </div>
      </div>
    </div>
  )
}
