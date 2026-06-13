import { useCallback, useEffect, useRef, useState } from 'react'
import { outputName, type Loaded } from '../lib/files'
import {
  aiRegionCutout,
  compositeCutout,
  maskFromPaint,
} from '../lib/maskCutout'
import type { ProgressInfo } from '../lib/removeBg'
import ResultModal from './ResultModal'

type Tool = 'brush' | 'erase'

interface Props {
  source: Loaded
}

/** 브러시 표시 색(배경과 겹치지 않게 선택 가능). 마스크 판정은 알파만 사용한다. */
const COLORS = ['#1a2a52', '#dc2626', '#16a34a', '#f59e0b'] as const

/**
 * 지정 누끼 — 남길 오브젝트를 브러시로 "대략" 칠하면, 칠한 영역을 크롭해
 * 자동 모드와 동일한 ISNet 엔진으로 피사체 경계를 정확히 따낸다.
 * "칠한 그대로 누끼"는 모델 없이 항상 동작하는 보장 경로.
 */
export default function InteractivePanel({ source }: Props) {
  const [tool, setTool] = useState<Tool>('brush')
  const [color, setColor] = useState<(typeof COLORS)[number]>(COLORS[0])
  const [brush, setBrush] = useState(48)
  const [hasPaint, setHasPaint] = useState(false)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [working, setWorking] = useState<null | 'ai' | 'manual'>(null)
  const [progress, setProgress] = useState<ProgressInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [modalBlob, setModalBlob] = useState<Blob | null>(null)
  const resultBlob = useRef<Blob | null>(null)
  // 포인터 핸들러에서 최신 작업 상태를 참조하기 위한 ref
  const workingRef = useRef<null | 'ai' | 'manual'>(null)
  workingRef.current = working
  /** 누끼 작업 중 — 브러시 편집·도구 변경을 잠근다 */
  const busy = working !== null

  const stageRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const maskRef = useRef<HTMLCanvasElement | null>(null)
  const drawing = useRef(false)
  const lastPt = useRef<{ x: number; y: number } | null>(null)
  const cursor = useRef<{ x: number; y: number } | null>(null)

  // ---- 오버레이(칠 미리보기 + 커서) ----
  const drawOverlay = useCallback(() => {
    const stage = stageRef.current
    const overlay = overlayRef.current
    if (!stage || !overlay) return
    const cw = stage.clientWidth
    const ch = stage.clientHeight
    if (cw === 0 || ch === 0) return

    const dpr = window.devicePixelRatio || 1
    overlay.width = cw * dpr
    overlay.height = ch * dpr
    const ctx = overlay.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cw, ch)

    const mask = maskRef.current
    if (mask) {
      ctx.globalAlpha = 0.45
      ctx.drawImage(mask, 0, 0, cw, ch)
      ctx.globalAlpha = 1
    }

    if (cursor.current) {
      ctx.beginPath()
      ctx.arc(cursor.current.x, cursor.current.y, brush / 2, 0, Math.PI * 2)
      ctx.strokeStyle = tool === 'brush' ? color : '#dc2626'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  }, [brush, tool, color])

  const initMask = useCallback(() => {
    const img = imgRef.current
    if (!img || !img.naturalWidth) return
    const c = document.createElement('canvas')
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    maskRef.current = c
    setHasPaint(false)
    drawOverlay()
  }, [drawOverlay])

  useEffect(() => {
    setResultUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    resultBlob.current = null
    setError(null)
    setProgress(null)
    setModalBlob(null)
    maskRef.current = null
    setHasPaint(false)
    cursor.current = null
    lastPt.current = null
    if (imgRef.current?.complete) initMask()
  }, [source, initMask])

  useEffect(() => {
    return () => {
      if (resultUrl) URL.revokeObjectURL(resultUrl)
    }
  }, [resultUrl])

  useEffect(() => {
    drawOverlay()
    const stage = stageRef.current
    if (!stage) return
    const ro = new ResizeObserver(() => drawOverlay())
    ro.observe(stage)
    return () => ro.disconnect()
  }, [drawOverlay])

  // ---- 그리기 ----
  const getPos = useCallback((e: React.PointerEvent) => {
    const overlay = overlayRef.current!
    const img = imgRef.current!
    const rect = overlay.getBoundingClientRect()
    const dx = e.clientX - rect.left
    const dy = e.clientY - rect.top
    const scale = img.naturalWidth / rect.width
    return {
      dx,
      dy,
      nx: (dx / rect.width) * img.naturalWidth,
      ny: (dy / rect.height) * img.naturalHeight,
      scale,
    }
  }, [])

  const paintTo = useCallback(
    (nx: number, ny: number, scale: number) => {
      const mask = maskRef.current
      if (!mask) return
      const mctx = mask.getContext('2d')
      if (!mctx) return
      const radius = (brush / 2) * scale
      mctx.lineCap = 'round'
      mctx.lineJoin = 'round'
      mctx.lineWidth = radius * 2
      if (tool === 'brush') {
        mctx.globalCompositeOperation = 'source-over'
        mctx.strokeStyle = color
        mctx.fillStyle = color
      } else {
        mctx.globalCompositeOperation = 'destination-out'
        mctx.strokeStyle = '#000'
        mctx.fillStyle = '#000'
      }
      const last = lastPt.current
      if (last) {
        mctx.beginPath()
        mctx.moveTo(last.x, last.y)
        mctx.lineTo(nx, ny)
        mctx.stroke()
      } else {
        mctx.beginPath()
        mctx.arc(nx, ny, radius, 0, Math.PI * 2)
        mctx.fill()
      }
      mctx.globalCompositeOperation = 'source-over'
      lastPt.current = { x: nx, y: ny }
      setHasPaint(true)
    },
    [brush, tool, color],
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (workingRef.current) return // 누끼 작업 중에는 편집 금지
      e.currentTarget.setPointerCapture(e.pointerId)
      drawing.current = true
      lastPt.current = null
      const p = getPos(e)
      cursor.current = { x: p.dx, y: p.dy }
      paintTo(p.nx, p.ny, p.scale)
      drawOverlay()
    },
    [getPos, paintTo, drawOverlay],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const p = getPos(e)
      cursor.current = { x: p.dx, y: p.dy }
      if (drawing.current) paintTo(p.nx, p.ny, p.scale)
      drawOverlay()
    },
    [getPos, paintTo, drawOverlay],
  )

  const endStroke = useCallback(() => {
    drawing.current = false
    lastPt.current = null
  }, [])

  const onPointerLeave = useCallback(() => {
    cursor.current = null
    drawOverlay()
  }, [drawOverlay])

  const clearMask = useCallback(() => {
    const mask = maskRef.current
    if (mask) mask.getContext('2d')?.clearRect(0, 0, mask.width, mask.height)
    setHasPaint(false)
    setResultUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    resultBlob.current = null
    setError(null)
    drawOverlay()
  }, [drawOverlay])

  // ---- 누끼 생성 ----
  const deliver = useCallback((blob: Blob) => {
    resultBlob.current = blob
    const url = URL.createObjectURL(blob)
    setResultUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return url
    })
    // 결과 확인 팝업을 열어 다운로드 여부를 사용자가 결정하게 한다.
    setModalBlob(blob)
  }, [])

  /** AI 인식: 칠한 박스 크롭 → ISNet 으로 피사체 추출 → 원위치 합성. */
  const aiCutout = useCallback(async () => {
    const mask = maskRef.current
    if (!mask || !hasPaint) return
    setWorking('ai')
    setError(null)
    setProgress({ stage: '준비 중', ratio: 0 })
    try {
      const blob = await aiRegionCutout(source, mask, 'best', setProgress)
      deliver(blob)
    } catch (err) {
      console.error(err)
      const detail = err instanceof Error ? err.message : String(err ?? '')
      setError(
        'AI 인식에 실패했어요. “칠한 그대로 누끼”는 항상 사용할 수 있어요.' +
          (detail ? `\n(상세: ${detail.slice(0, 160)})` : ''),
      )
    } finally {
      setWorking(null)
      setProgress(null)
    }
  }, [hasPaint, source.url, deliver])

  /** 칠한 그대로: 모델 없이 칠한 영역만 남긴다. 항상 동작. */
  const manualCutout = useCallback(async () => {
    const mask = maskRef.current
    if (!mask || !hasPaint) return
    setWorking('manual')
    setError(null)
    try {
      const m = maskFromPaint(mask)
      if (!m) throw new Error('칠한 영역이 없어요.')
      deliver(await compositeCutout(source.url, m, 1))
    } catch (err) {
      console.error(err)
      const detail = err instanceof Error ? err.message : String(err ?? '')
      setError('누끼 생성에 실패했어요.' + (detail ? ` (${detail})` : ''))
    } finally {
      setWorking(null)
    }
  }, [hasPaint, source.url, deliver])

  return (
    <div className="panel">
      <p className="hint">
        남기고 싶은 오브젝트를 <b>대략</b> 칠하세요. <b>AI 인식 누끼</b>를 누르면
        그 영역에서 피사체 경계를 정확히 찾아 따냅니다. 정밀하게 칠했다면{' '}
        <b>칠한 그대로 누끼</b>도 좋아요.
      </p>

      <div className="seg-toolbar">
        <div className="seg-tools">
          <button
            className={`chip${tool === 'brush' ? ' chip--on' : ''}`}
            onClick={() => setTool('brush')}
            disabled={busy}
          >
            🖌 브러시
          </button>
          <button
            className={`chip${tool === 'erase' ? ' chip--on' : ''}`}
            onClick={() => setTool('erase')}
            disabled={busy}
          >
            🧽 지우개
          </button>
          <span className="swatches" role="group" aria-label="브러시 색">
            {COLORS.map((c) => (
              <button
                key={c}
                className={`swatch${color === c ? ' swatch--on' : ''}`}
                style={{ background: c }}
                aria-label={`브러시 색 ${c}`}
                onClick={() => setColor(c)}
                disabled={busy}
              />
            ))}
          </span>
          <label className="brush-size">
            굵기
            <input
              type="range"
              min={8}
              max={140}
              value={brush}
              onChange={(e) => setBrush(Number(e.target.value))}
              disabled={busy}
            />
          </label>
        </div>
        <button
          className="chip chip--ghost"
          onClick={clearMask}
          disabled={!hasPaint || busy}
        >
          전체 지우기
        </button>
      </div>

      <div className="canvas-grid">
        <figure className="canvas">
          <figcaption className="canvas__label">칠하기</figcaption>
          <div className="media-frame">
            <div className="brush-stage" ref={stageRef}>
              <img
                ref={imgRef}
                src={source.url}
                alt="원본 이미지"
                onLoad={initMask}
                draggable={false}
              />
              <canvas
                ref={overlayRef}
                className={`brush-overlay${busy ? ' brush-overlay--locked' : ''}`}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endStroke}
                onPointerCancel={endStroke}
                onPointerLeave={onPointerLeave}
              />
            </div>
          </div>
        </figure>

        <figure className="canvas">
          <figcaption className="canvas__label">결과 (투명 배경)</figcaption>
          <div className="media-frame media-frame--checker">
            {resultUrl ? (
              <img src={resultUrl} alt="누끼 결과" />
            ) : (
              <div className="canvas__pending">
                {working ? '만드는 중…' : '칠한 뒤 아래 버튼을 눌러 주세요'}
              </div>
            )}
          </div>
        </figure>
      </div>

      {working === 'ai' && progress && (
        <div className="progress" aria-live="polite">
          <div className="progress__row">
            <span>{progress.stage}</span>
            <span>{Math.round(progress.ratio * 100)}%</span>
          </div>
          <div className="progress__track">
            <div
              className="progress__bar"
              style={{ width: `${Math.max(4, progress.ratio * 100)}%` }}
            />
          </div>
        </div>
      )}

      {error && <p className="error-note">{error}</p>}

      <div className="controls">
        <div className="actions actions--full">
          <button
            className="btn btn--primary"
            onClick={aiCutout}
            disabled={!hasPaint || working !== null}
          >
            {working === 'ai' ? 'AI 인식 중…' : '✨ AI 인식 누끼 (추천)'}
          </button>
          <button
            className="btn btn--ghost"
            onClick={manualCutout}
            disabled={!hasPaint || working !== null}
          >
            {working === 'manual' ? '만드는 중…' : '칠한 그대로 누끼'}
          </button>
          {resultUrl && resultBlob.current && (
            <button
              className="btn btn--ghost"
              onClick={() => resultBlob.current && setModalBlob(resultBlob.current)}
            >
              다운로드 / 편집
            </button>
          )}
        </div>
      </div>

      {resultUrl && (
        <p className="done-note">✓ 누끼 완료! 결과를 확인하고 다운로드하세요.</p>
      )}

      {modalBlob && (
        <ResultModal
          blob={modalBlob}
          filename={outputName(source.file.name)}
          onClose={() => setModalBlob(null)}
        />
      )}
    </div>
  )
}
