import { useCallback, useEffect, useRef, useState } from 'react'
import { outputName, triggerDownload, type Loaded } from '../lib/files'
import {
  SamSession,
  compositeCutout,
  type MaskResult,
  type SamBox,
  type SamPoint,
} from '../lib/samCutout'

type Tool = 'brush' | 'erase'
type AiStatus = 'loading' | 'ready' | 'error'

interface Props {
  source: Loaded
}

/** 브러시 표시 색(배경과 겹치지 않게 선택 가능). 마스크 판정은 알파만 사용한다. */
const COLORS = ['#1a2a52', '#dc2626', '#16a34a', '#f59e0b'] as const

/** 칠한 마스크에서 SAM 프롬프트(박스 + 포함 점들)를 뽑는다. */
function promptsFromMask(
  mask: HTMLCanvasElement,
): { box: SamBox; points: SamPoint[] } | null {
  const w = mask.width
  const h = mask.height
  const ctx = mask.getContext('2d')
  if (!ctx) return null
  const d = ctx.getImageData(0, 0, w, h).data

  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1
  let sumX = 0
  let sumY = 0
  let n = 0
  const sampled: Array<[number, number]> = []
  const stride = 2
  for (let y = 0; y < h; y += stride) {
    for (let x = 0; x < w; x += stride) {
      if (d[(y * w + x) * 4 + 3] > 0) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        sumX += x
        sumY += y
        n++
        if (n % 37 === 0) sampled.push([x, y])
      }
    }
  }
  if (maxX < 0 || n === 0) return null

  const points: SamPoint[] = [{ x: sumX / n, y: sumY / n, label: 1 }]
  // 칠한 영역에서 점을 고르게 몇 개 더 뽑아 인식 안정성을 높인다.
  const want = Math.min(3, sampled.length)
  for (let i = 0; i < want; i++) {
    const [x, y] = sampled[Math.floor((i + 0.5) * (sampled.length / want))]
    points.push({ x, y, label: 1 })
  }

  return { box: { x1: minX, y1: minY, x2: maxX, y2: maxY }, points }
}

/** 칠한 캔버스(알파)를 0/1 MaskResult 로 바꾼다 — "칠한 그대로" 누끼용. */
function maskFromPaint(mask: HTMLCanvasElement): MaskResult | null {
  const w = mask.width
  const h = mask.height
  const ctx = mask.getContext('2d')
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
 * 지정 누끼 — 남길 영역을 브러시로 "대략" 칠하면 AI(SAM)가 오브젝트 경계를
 * 정확히 인식해 누끼를 딴다. AI 가 불가한 환경에서도 "칠한 그대로 누끼"는
 * 모델 없이 항상 동작한다.
 */
export default function InteractivePanel({ source }: Props) {
  const [tool, setTool] = useState<Tool>('brush')
  const [color, setColor] = useState<(typeof COLORS)[number]>(COLORS[0])
  const [brush, setBrush] = useState(48)
  const [hasPaint, setHasPaint] = useState(false)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [working, setWorking] = useState<null | 'ai' | 'manual'>(null)
  const [error, setError] = useState<string | null>(null)
  const resultBlob = useRef<Blob | null>(null)

  const [aiStatus, setAiStatus] = useState<AiStatus>('loading')
  const [aiRatio, setAiRatio] = useState(0)
  const [aiError, setAiError] = useState<string | null>(null)
  const sessionRef = useRef<SamSession | null>(null)

  const stageRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const maskRef = useRef<HTMLCanvasElement | null>(null)
  const drawing = useRef(false)
  const lastPt = useRef<{ x: number; y: number } | null>(null)
  const cursor = useRef<{ x: number; y: number } | null>(null)

  // ---- AI 세션(모델 + 이미지 임베딩)을 백그라운드에서 준비 ----
  useEffect(() => {
    let cancelled = false
    setAiStatus('loading')
    setAiRatio(0)
    setAiError(null)
    sessionRef.current = null

    SamSession.create(source.blob, (r) => {
      if (!cancelled) setAiRatio(r)
    })
      .then((s) => {
        if (cancelled) return
        sessionRef.current = s
        setAiStatus('ready')
      })
      .catch((err) => {
        console.error(err)
        if (cancelled) return
        const detail = err instanceof Error ? err.message : String(err ?? '')
        setAiError(detail.slice(0, 160))
        setAiStatus('error')
      })

    return () => {
      cancelled = true
    }
  }, [source])

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
  const finish = useCallback(
    async (mask: MaskResult, feather: number) => {
      const blob = await compositeCutout(source.url, mask, feather)
      resultBlob.current = blob
      const url = URL.createObjectURL(blob)
      setResultUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return url
      })
      triggerDownload(blob, outputName(source.file.name))
    },
    [source],
  )

  /** AI 인식: 칠한 영역 → 프롬프트 → SAM → 오브젝트 경계 마스크. */
  const aiCutout = useCallback(async () => {
    const mask = maskRef.current
    const session = sessionRef.current
    if (!mask || !session || !hasPaint) return
    setWorking('ai')
    setError(null)
    try {
      const prompts = promptsFromMask(mask)
      if (!prompts) throw new Error('칠한 영역을 찾지 못했어요.')
      const result = await session.segment(prompts.points, prompts.box)
      await finish(result, 1.5)
    } catch (err) {
      console.error(err)
      const detail = err instanceof Error ? err.message : String(err ?? '')
      setError(
        'AI 인식에 실패했어요. “칠한 그대로 누끼”는 항상 사용할 수 있어요.' +
          (detail ? `\n(상세: ${detail.slice(0, 160)})` : ''),
      )
    } finally {
      setWorking(null)
    }
  }, [hasPaint, finish])

  /** 칠한 그대로: 모델 없이 칠한 영역만 남긴다. 항상 동작. */
  const manualCutout = useCallback(async () => {
    const mask = maskRef.current
    if (!mask || !hasPaint) return
    setWorking('manual')
    setError(null)
    try {
      const m = maskFromPaint(mask)
      if (!m) throw new Error('칠한 영역이 없어요.')
      await finish(m, 1)
    } catch (err) {
      console.error(err)
      const detail = err instanceof Error ? err.message : String(err ?? '')
      setError('누끼 생성에 실패했어요.' + (detail ? ` (${detail})` : ''))
    } finally {
      setWorking(null)
    }
  }, [hasPaint, finish])

  const aiReady = aiStatus === 'ready'

  return (
    <div className="panel">
      <p className="hint">
        남기고 싶은 오브젝트를 <b>대략</b> 칠하세요. <b>AI 인식 누끼</b>를 누르면
        모델이 경계를 정확히 찾아 따냅니다. 정밀하게 칠했다면 <b>칠한 그대로
        누끼</b>도 좋아요.
      </p>

      <div className="seg-toolbar">
        <div className="seg-tools">
          <button
            className={`chip${tool === 'brush' ? ' chip--on' : ''}`}
            onClick={() => setTool('brush')}
          >
            🖌 브러시
          </button>
          <button
            className={`chip${tool === 'erase' ? ' chip--on' : ''}`}
            onClick={() => setTool('erase')}
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
            />
          </label>
        </div>
        <button className="chip chip--ghost" onClick={clearMask} disabled={!hasPaint}>
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
                className="brush-overlay"
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

      {aiStatus === 'loading' && (
        <div className="progress" aria-live="polite">
          <div className="progress__row">
            <span>AI 모델 준비 중… (이번 한 번만 내려받아요)</span>
            <span>{aiRatio > 0 ? `${Math.round(aiRatio * 100)}%` : ''}</span>
          </div>
          <div className="progress__track">
            <div
              className="progress__bar"
              style={{ width: `${Math.max(4, aiRatio * 100)}%` }}
            />
          </div>
        </div>
      )}
      {aiStatus === 'error' && (
        <p className="hint">
          ⚠ AI 모델을 준비하지 못했어요{aiError ? ` (${aiError})` : ''}. “칠한
          그대로 누끼”는 계속 사용할 수 있어요.
        </p>
      )}

      {error && <p className="error-note">{error}</p>}

      <div className="controls">
        <div className="actions actions--full">
          <button
            className="btn btn--primary"
            onClick={aiCutout}
            disabled={!hasPaint || !aiReady || working !== null}
          >
            {working === 'ai'
              ? 'AI 인식 중…'
              : aiStatus === 'loading'
                ? 'AI 준비 중…'
                : '✨ AI 인식 누끼 (추천)'}
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
              onClick={() =>
                resultBlob.current &&
                triggerDownload(resultBlob.current, outputName(source.file.name))
              }
            >
              다시 다운로드
            </button>
          )}
        </div>
      </div>

      {resultUrl && (
        <p className="done-note">✓ 누끼 완료! 투명 배경 PNG 가 다운로드되었어요.</p>
      )}
    </div>
  )
}
