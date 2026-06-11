import { useCallback, useEffect, useRef, useState } from 'react'
import {
  SamSession,
  compositeCutout,
  type MaskResult,
  type SamBox,
  type SamPoint,
} from '../lib/samCutout'
import { outputName, triggerDownload, type Loaded } from '../lib/files'

type Tool = 'box' | 'add' | 'remove'
type SessionStatus = 'loading' | 'ready' | 'error'

interface Props {
  source: Loaded
}

const NAVY = '#1a2a52'

/** 마스크(원본 크기 0/1)를 네이비 반투명으로 칠한 오프스크린 캔버스를 만든다. */
function buildMaskTint(mask: MaskResult): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = mask.width
  c.height = mask.height
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(mask.width, mask.height)
  const d = img.data
  for (let i = 0; i < mask.width * mask.height; i++) {
    if (mask.data[i]) {
      d[i * 4] = 26
      d[i * 4 + 1] = 42
      d[i * 4 + 2] = 82
      d[i * 4 + 3] = 120
    }
  }
  ctx.putImageData(img, 0, 0)
  return c
}

/** 지정 누끼(SAM) — 박스/점으로 원하는 오브젝트만 골라 분할한다. */
export default function InteractivePanel({ source }: Props) {
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>('loading')
  const [modelRatio, setModelRatio] = useState(0)
  const [sessionError, setSessionError] = useState<string | null>(null)

  const [tool, setTool] = useState<Tool>('box')
  const [points, setPoints] = useState<SamPoint[]>([])
  const [box, setBox] = useState<SamBox | null>(null)
  const [draftBox, setDraftBox] = useState<SamBox | null>(null)

  const [decoding, setDecoding] = useState(false)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const resultBlob = useRef<Blob | null>(null)

  const sessionRef = useRef<SamSession | null>(null)
  const maskTintRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragging = useRef(false)
  const dragStart = useRef<{ x: number; y: number } | null>(null)

  // ---- 세션(이미지 임베딩) 준비 ----
  useEffect(() => {
    let cancelled = false
    setSessionStatus('loading')
    setModelRatio(0)
    setSessionError(null)
    sessionRef.current = null
    maskTintRef.current = null
    setPoints([])
    setBox(null)
    setDraftBox(null)
    setResultUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    resultBlob.current = null

    SamSession.create(source.file, (r) => {
      if (!cancelled) setModelRatio(r)
    })
      .then((session) => {
        if (cancelled) return
        sessionRef.current = session
        setSessionStatus('ready')
      })
      .catch((err) => {
        console.error(err)
        if (cancelled) return
        const detail =
          err instanceof Error ? err.message : String(err ?? '')
        setSessionError(
          '모델을 불러오지 못했어요. 네트워크를 확인하고 새로고침해 주세요.' +
            (detail ? `\n(상세: ${detail.slice(0, 160)})` : ''),
        )
        setSessionStatus('error')
      })

    return () => {
      cancelled = true
    }
  }, [source])

  useEffect(() => {
    return () => {
      if (resultUrl) URL.revokeObjectURL(resultUrl)
    }
  }, [resultUrl])

  // ---- 오버레이 다시 그리기 ----
  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    const img = imgRef.current
    if (!canvas || !container || !img) return
    const cw = container.clientWidth
    const ch = container.clientHeight
    if (cw === 0 || ch === 0) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = cw * dpr
    canvas.height = ch * dpr
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cw, ch)

    const natW = img.naturalWidth || 1
    const s = cw / natW // 화면 픽셀 / 원본 픽셀

    // 마스크 미리보기
    if (maskTintRef.current) {
      ctx.drawImage(maskTintRef.current, 0, 0, cw, ch)
    }

    // 박스 (확정 또는 드래그 중)
    const b = draftBox ?? box
    if (b) {
      ctx.save()
      ctx.strokeStyle = NAVY
      ctx.lineWidth = 2
      ctx.setLineDash([6, 4])
      ctx.strokeRect(
        Math.min(b.x1, b.x2) * s,
        Math.min(b.y1, b.y2) * s,
        Math.abs(b.x2 - b.x1) * s,
        Math.abs(b.y2 - b.y1) * s,
      )
      ctx.restore()
    }

    // 점
    for (const p of points) {
      ctx.beginPath()
      ctx.arc(p.x * s, p.y * s, 7, 0, Math.PI * 2)
      ctx.fillStyle = p.label === 1 ? '#15a34a' : '#dc2626'
      ctx.fill()
      ctx.lineWidth = 2
      ctx.strokeStyle = '#ffffff'
      ctx.stroke()
    }
  }, [points, box, draftBox])

  useEffect(() => {
    redraw()
    const container = containerRef.current
    if (!container) return
    const ro = new ResizeObserver(() => redraw())
    ro.observe(container)
    return () => ro.disconnect()
  }, [redraw])

  // ---- 좌표 변환 ----
  const toNatural = useCallback((e: React.PointerEvent) => {
    const canvas = canvasRef.current!
    const img = imgRef.current!
    const rect = canvas.getBoundingClientRect()
    const natW = img.naturalWidth
    const natH = img.naturalHeight
    const x = ((e.clientX - rect.left) / rect.width) * natW
    const y = ((e.clientY - rect.top) / rect.height) * natH
    return {
      x: Math.max(0, Math.min(natW, x)),
      y: Math.max(0, Math.min(natH, y)),
    }
  }, [])

  const ready = sessionStatus === 'ready'

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!ready || tool !== 'box') return
      e.currentTarget.setPointerCapture(e.pointerId)
      const p = toNatural(e)
      dragging.current = true
      dragStart.current = p
      setDraftBox({ x1: p.x, y1: p.y, x2: p.x, y2: p.y })
    },
    [ready, tool, toNatural],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current || !dragStart.current) return
      const p = toNatural(e)
      setDraftBox({
        x1: dragStart.current.x,
        y1: dragStart.current.y,
        x2: p.x,
        y2: p.y,
      })
    },
    [toNatural],
  )

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!ready) return
      if (tool === 'box') {
        if (!dragging.current || !dragStart.current) return
        dragging.current = false
        const p = toNatural(e)
        const start = dragStart.current
        dragStart.current = null
        setDraftBox(null)
        const x1 = Math.min(start.x, p.x)
        const y1 = Math.min(start.y, p.y)
        const x2 = Math.max(start.x, p.x)
        const y2 = Math.max(start.y, p.y)
        // 너무 작은 박스는 클릭 실수로 보고 무시.
        if (x2 - x1 < 5 || y2 - y1 < 5) return
        setBox({ x1, y1, x2, y2 })
      } else {
        const p = toNatural(e)
        setPoints((prev) => [
          ...prev,
          { x: p.x, y: p.y, label: tool === 'add' ? 1 : 0 },
        ])
      }
    },
    [ready, tool, toNatural],
  )

  const hasPrompt = points.length > 0 || box !== null

  const clearPrompts = useCallback(() => {
    setPoints([])
    setBox(null)
    setDraftBox(null)
    maskTintRef.current = null
    setResultUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    resultBlob.current = null
    redraw()
  }, [redraw])

  const runSegment = useCallback(async () => {
    const session = sessionRef.current
    if (!session || !hasPrompt) return
    setDecoding(true)
    try {
      const mask = await session.segment(points, box)
      maskTintRef.current = buildMaskTint(mask)
      redraw()
      const blob = await compositeCutout(source.url, mask)
      resultBlob.current = blob
      const url = URL.createObjectURL(blob)
      setResultUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return url
      })
    } catch (err) {
      console.error(err)
    } finally {
      setDecoding(false)
    }
  }, [points, box, hasPrompt, source.url, redraw])

  return (
    <div className="panel">
      <p className="hint">
        {tool === 'box'
          ? '오브젝트를 사각형으로 감싸 보세요. 필요하면 점 도구로 더 다듬을 수 있어요.'
          : tool === 'add'
            ? '남기고 싶은 부분을 클릭하세요 (포함).'
            : '빼고 싶은 부분을 클릭하세요 (제외).'}
      </p>

      <div className="seg-toolbar">
        <div className="seg-tools">
          <button
            className={`chip${tool === 'box' ? ' chip--on' : ''}`}
            onClick={() => setTool('box')}
            disabled={!ready}
          >
            ▭ 박스
          </button>
          <button
            className={`chip${tool === 'add' ? ' chip--on' : ''}`}
            onClick={() => setTool('add')}
            disabled={!ready}
          >
            ＋ 포함 점
          </button>
          <button
            className={`chip${tool === 'remove' ? ' chip--on' : ''}`}
            onClick={() => setTool('remove')}
            disabled={!ready}
          >
            － 제외 점
          </button>
        </div>
        <button className="chip chip--ghost" onClick={clearPrompts} disabled={!hasPrompt}>
          초기화
        </button>
      </div>

      <div className="canvas-grid">
        <figure className="canvas">
          <figcaption className="canvas__label">지정</figcaption>
          <div className="canvas__frame seg-stage" ref={containerRef}>
            <img ref={imgRef} src={source.url} alt="원본 이미지" onLoad={redraw} />
            <canvas
              ref={canvasRef}
              className={`seg-overlay${ready ? '' : ' seg-overlay--disabled'}`}
              style={{ cursor: tool === 'box' ? 'crosshair' : 'pointer' }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            />
            {sessionStatus === 'loading' && (
              <div className="seg-loading">
                <div className="spinner" />
                <span>
                  모델 준비 중…{' '}
                  {modelRatio > 0 ? `${Math.round(modelRatio * 100)}%` : ''}
                </span>
              </div>
            )}
          </div>
        </figure>

        <figure className="canvas">
          <figcaption className="canvas__label">결과 (투명 배경)</figcaption>
          <div className="canvas__frame canvas__frame--checker">
            {resultUrl ? (
              <img src={resultUrl} alt="선택한 오브젝트만 남긴 결과" />
            ) : (
              <div className="canvas__pending">
                {decoding ? '분할 중…' : '영역을 지정하고 누끼를 눌러 주세요'}
              </div>
            )}
          </div>
        </figure>
      </div>

      {sessionStatus === 'error' && sessionError && (
        <p className="error-note">{sessionError}</p>
      )}

      <div className="controls">
        <div className="actions actions--full">
          <button
            className="btn btn--primary"
            onClick={runSegment}
            disabled={!ready || !hasPrompt || decoding}
          >
            {decoding ? '분할 중…' : '이 영역 누끼'}
          </button>
          {resultUrl && resultBlob.current && (
            <button
              className="btn btn--ghost"
              onClick={() =>
                resultBlob.current &&
                triggerDownload(resultBlob.current, outputName(source.file.name))
              }
            >
              다운로드
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
