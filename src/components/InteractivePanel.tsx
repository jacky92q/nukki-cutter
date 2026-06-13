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
type TouchTool = 'restore' | 'erase'

interface Props {
  source: Loaded
}

/** 브러시 표시 색(배경과 겹치지 않게 선택 가능). 마스크 판정은 알파만 사용한다. */
const COLORS = ['#1a2a52', '#dc2626', '#16a34a', '#f59e0b'] as const

/**
 * 지정 누끼 — 남길 오브젝트를 브러시로 "대략" 칠하면 AI 가 경계를 찾아 따낸다.
 * 결과가 나온 뒤에는 결과 위에 직접 칠해 AI 가 놓친 부분을 복원하거나(🖌 복원)
 * 잘못 들어간 부분을 지울 수 있다(🧽 제거) — 흰 배경 위 흰 리본처럼
 * 모델이 인식하지 못하는 저대비 영역을 살리는 용도.
 */
export default function InteractivePanel({ source }: Props) {
  const [tool, setTool] = useState<Tool>('brush')
  const [color, setColor] = useState<(typeof COLORS)[number]>(COLORS[0])
  const [brush, setBrush] = useState(48)
  const [hasPaint, setHasPaint] = useState(false)
  const [hasResult, setHasResult] = useState(false)
  const [touchTool, setTouchTool] = useState<TouchTool>('restore')
  const [working, setWorking] = useState<null | 'ai' | 'manual'>(null)
  const [progress, setProgress] = useState<ProgressInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [modalBlob, setModalBlob] = useState<Blob | null>(null)
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

  // 결과 다듬기(복원/제거)용
  const resultStageRef = useRef<HTMLDivElement>(null)
  const resultViewRef = useRef<HTMLCanvasElement>(null)
  const resultOverlayRef = useRef<HTMLCanvasElement>(null)
  const tDrawing = useRef(false)
  const tLastPt = useRef<{ x: number; y: number } | null>(null)
  const tCursor = useRef<{ x: number; y: number } | null>(null)
  const touchToolRef = useRef<TouchTool>('restore')
  touchToolRef.current = touchTool

  // ---- 칠하기 오버레이(칠 미리보기 + 커서) ----
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

  // ---- 결과 오버레이(다듬기 커서) ----
  const drawResultOverlay = useCallback(() => {
    const stage = resultStageRef.current
    const overlay = resultOverlayRef.current
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

    if (tCursor.current) {
      ctx.beginPath()
      ctx.arc(tCursor.current.x, tCursor.current.y, brush / 2, 0, Math.PI * 2)
      ctx.strokeStyle = touchTool === 'restore' ? '#16a34a' : '#dc2626'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  }, [brush, touchTool])

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
    setHasResult(false)
    setError(null)
    setProgress(null)
    setModalBlob(null)
    maskRef.current = null
    setHasPaint(false)
    cursor.current = null
    lastPt.current = null
    tCursor.current = null
    tLastPt.current = null
    if (imgRef.current?.complete) initMask()
  }, [source, initMask])

  useEffect(() => {
    drawOverlay()
    const stage = stageRef.current
    if (!stage) return
    const ro = new ResizeObserver(() => drawOverlay())
    ro.observe(stage)
    return () => ro.disconnect()
  }, [drawOverlay])

  useEffect(() => {
    drawResultOverlay()
    const stage = resultStageRef.current
    if (!stage) return
    const ro = new ResizeObserver(() => drawResultOverlay())
    ro.observe(stage)
    return () => ro.disconnect()
  }, [drawResultOverlay, hasResult])

  // ---- 칠하기 ----
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
    setError(null)
    drawOverlay()
  }, [drawOverlay])

  // ---- 결과 다듬기(복원/제거) ----
  const getResultPos = useCallback((e: React.PointerEvent) => {
    const overlay = resultOverlayRef.current!
    const view = resultViewRef.current!
    const rect = overlay.getBoundingClientRect()
    const dx = e.clientX - rect.left
    const dy = e.clientY - rect.top
    const scale = view.width / rect.width
    return {
      dx,
      dy,
      nx: (dx / rect.width) * view.width,
      ny: (dy / rect.height) * view.height,
      scale,
    }
  }, [])

  const touchTo = useCallback(
    (nx: number, ny: number, scale: number) => {
      const view = resultViewRef.current
      const img = imgRef.current
      if (!view || !img) return
      const rctx = view.getContext('2d')
      if (!rctx) return
      const radius = (brush / 2) * scale
      const last = tLastPt.current

      if (touchToolRef.current === 'erase') {
        // 결과에서 알파 제거 — 캔버스에 직접 스트로크
        rctx.save()
        rctx.globalCompositeOperation = 'destination-out'
        rctx.lineCap = 'round'
        rctx.lineJoin = 'round'
        rctx.lineWidth = radius * 2
        rctx.strokeStyle = '#000'
        rctx.fillStyle = '#000'
        if (last) {
          rctx.beginPath()
          rctx.moveTo(last.x, last.y)
          rctx.lineTo(nx, ny)
          rctx.stroke()
        } else {
          rctx.beginPath()
          rctx.arc(nx, ny, radius, 0, Math.PI * 2)
          rctx.fill()
        }
        rctx.restore()
      } else {
        // 복원: 스트로크 영역에 원본 픽셀을 다시 채운다 (스트로크 주변만 처리)
        const lx = last ? last.x : nx
        const ly = last ? last.y : ny
        const x0 = Math.max(0, Math.floor(Math.min(lx, nx) - radius - 2))
        const y0 = Math.max(0, Math.floor(Math.min(ly, ny) - radius - 2))
        const x1 = Math.min(view.width, Math.ceil(Math.max(lx, nx) + radius + 2))
        const y1 = Math.min(view.height, Math.ceil(Math.max(ly, ny) + radius + 2))
        const w = x1 - x0
        const h = y1 - y0
        if (w <= 0 || h <= 0) return

        const tmp = document.createElement('canvas')
        tmp.width = w
        tmp.height = h
        const tctx = tmp.getContext('2d')!
        tctx.lineCap = 'round'
        tctx.lineJoin = 'round'
        tctx.lineWidth = radius * 2
        tctx.strokeStyle = '#fff'
        tctx.fillStyle = '#fff'
        if (last) {
          tctx.beginPath()
          tctx.moveTo(lx - x0, ly - y0)
          tctx.lineTo(nx - x0, ny - y0)
          tctx.stroke()
        } else {
          tctx.beginPath()
          tctx.arc(nx - x0, ny - y0, radius, 0, Math.PI * 2)
          tctx.fill()
        }
        // 스트로크 모양으로 원본 이미지를 잘라낸 조각을 만든다
        tctx.globalCompositeOperation = 'source-in'
        tctx.drawImage(img, -x0, -y0, view.width, view.height)
        rctx.drawImage(tmp, x0, y0)
      }

      tLastPt.current = { x: nx, y: ny }
    },
    [brush],
  )

  const onResultPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (workingRef.current) return
      e.currentTarget.setPointerCapture(e.pointerId)
      tDrawing.current = true
      tLastPt.current = null
      const p = getResultPos(e)
      tCursor.current = { x: p.dx, y: p.dy }
      touchTo(p.nx, p.ny, p.scale)
      drawResultOverlay()
    },
    [getResultPos, touchTo, drawResultOverlay],
  )

  const onResultPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const p = getResultPos(e)
      tCursor.current = { x: p.dx, y: p.dy }
      if (tDrawing.current) touchTo(p.nx, p.ny, p.scale)
      drawResultOverlay()
    },
    [getResultPos, touchTo, drawResultOverlay],
  )

  const endResultStroke = useCallback(() => {
    tDrawing.current = false
    tLastPt.current = null
  }, [])

  const onResultPointerLeave = useCallback(() => {
    tCursor.current = null
    drawResultOverlay()
  }, [drawResultOverlay])

  // ---- 누끼 생성/전달 ----
  /** 결과 Blob 을 결과 캔버스에 반영하고 확인 팝업을 연다. */
  const deliver = useCallback(async (blob: Blob) => {
    const bmp = await createImageBitmap(blob)
    const view = resultViewRef.current
    if (view) {
      view.width = bmp.width
      view.height = bmp.height
      const ctx = view.getContext('2d')
      ctx?.clearRect(0, 0, bmp.width, bmp.height)
      ctx?.drawImage(bmp, 0, 0)
    }
    bmp.close()
    setHasResult(true)
    // 결과 확인 팝업을 열어 다운로드 여부를 사용자가 결정하게 한다.
    setModalBlob(blob)
  }, [])

  /** 현재(다듬기 반영된) 결과 캔버스로 팝업을 연다. */
  const openModal = useCallback(() => {
    const view = resultViewRef.current
    if (!view || !hasResult) return
    view.toBlob((b) => {
      if (b) setModalBlob(b)
    }, 'image/png')
  }, [hasResult])

  /** AI 인식: 전체 누끼 후 칠한 오브젝트와 연결된 덩어리만 선택. */
  const aiCutout = useCallback(async () => {
    const mask = maskRef.current
    if (!mask || !hasPaint) return
    setWorking('ai')
    setError(null)
    setProgress({ stage: '준비 중', ratio: 0 })
    try {
      const blob = await aiRegionCutout(source, mask, 'best', setProgress)
      await deliver(blob)
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
  }, [hasPaint, source, deliver])

  /** 칠한 그대로: 모델 없이 칠한 영역만 남긴다. 항상 동작. */
  const manualCutout = useCallback(async () => {
    const mask = maskRef.current
    if (!mask || !hasPaint) return
    setWorking('manual')
    setError(null)
    try {
      const m = maskFromPaint(mask)
      if (!m) throw new Error('칠한 영역이 없어요.')
      await deliver(await compositeCutout(source.url, m, 1))
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
        남기고 싶은 오브젝트를 <b>대략</b> 칠하고 <b>AI 인식 누끼</b>를 누르세요.
        결과가 나오면 결과 위에 <b>🖌 복원</b>으로 AI 가 놓친 부분(흰 배경의 흰
        리본 끈 등)을 직접 살리고, <b>🧽 제거</b>로 불필요한 부분을 지울 수
        있어요.
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
          {hasResult && (
            <div className="touch-tools">
              <button
                className={`chip${touchTool === 'restore' ? ' chip--on' : ''}`}
                onClick={() => setTouchTool('restore')}
                disabled={busy}
              >
                🖌 복원
              </button>
              <button
                className={`chip${touchTool === 'erase' ? ' chip--on' : ''}`}
                onClick={() => setTouchTool('erase')}
                disabled={busy}
              >
                🧽 제거
              </button>
              <span className="hint-mini">결과 위에 직접 칠해 다듬기</span>
            </div>
          )}
          <div className="media-frame media-frame--checker">
            <div
              className="brush-stage"
              ref={resultStageRef}
              style={{ display: hasResult ? 'inline-block' : 'none' }}
            >
              <canvas ref={resultViewRef} className="result-view" />
              <canvas
                ref={resultOverlayRef}
                className={`brush-overlay${busy ? ' brush-overlay--locked' : ''}`}
                onPointerDown={onResultPointerDown}
                onPointerMove={onResultPointerMove}
                onPointerUp={endResultStroke}
                onPointerCancel={endResultStroke}
                onPointerLeave={onResultPointerLeave}
              />
            </div>
            {!hasResult && (
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
          {hasResult && (
            <button className="btn btn--ghost" onClick={openModal} disabled={busy}>
              다운로드 / 편집
            </button>
          )}
        </div>
      </div>

      {hasResult && (
        <p className="done-note">
          ✓ 누끼 완료! 빠진 부분은 결과 위에 🖌 복원으로 칠해 살린 뒤 다운로드하세요.
        </p>
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
