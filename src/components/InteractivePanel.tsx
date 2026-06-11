import { useCallback, useEffect, useRef, useState } from 'react'
import { outputName, triggerDownload, type Loaded } from '../lib/files'

type Tool = 'brush' | 'erase'

interface Props {
  source: Loaded
}

const NAVY = '#1a2a52'

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = url
  })
}

/**
 * 지정 누끼(수동 브러시) — 모델 없이 100% 브라우저에서 동작한다.
 * 남기고 싶은 영역을 브러시로 칠하면, 그 영역만 남긴 투명 PNG 를 만든다.
 * 어떤 환경(WebGPU 미지원·네트워크 차단)에서도 항상 동작한다.
 */
export default function InteractivePanel({ source }: Props) {
  const [tool, setTool] = useState<Tool>('brush')
  const [brush, setBrush] = useState(48) // 화면 기준 지름(px)
  const [hasPaint, setHasPaint] = useState(false)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const resultBlob = useRef<Blob | null>(null)

  const stageRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const maskRef = useRef<HTMLCanvasElement | null>(null) // 원본 해상도 마스크
  const drawing = useRef(false)
  const lastPt = useRef<{ x: number; y: number } | null>(null)
  const cursor = useRef<{ x: number; y: number } | null>(null)

  // 오버레이(마스크 미리보기 + 브러시 커서) 다시 그리기
  const drawOverlay = useCallback(() => {
    const stage = stageRef.current
    const overlay = overlayRef.current
    const img = imgRef.current
    if (!stage || !overlay || !img) return
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

    // 칠한 영역(마스크)을 네이비 반투명으로
    const mask = maskRef.current
    if (mask) {
      ctx.globalAlpha = 0.45
      ctx.drawImage(mask, 0, 0, cw, ch)
      ctx.globalAlpha = 1
    }

    // 브러시 커서(현재 크기 표시)
    if (cursor.current) {
      ctx.beginPath()
      ctx.arc(cursor.current.x, cursor.current.y, brush / 2, 0, Math.PI * 2)
      ctx.strokeStyle = tool === 'brush' ? NAVY : '#dc2626'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  }, [brush, tool])

  // 이미지가 로드되면 마스크 캔버스를 원본 크기로 초기화
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

  // 소스가 바뀌면 결과/마스크 초기화
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
    // 마스크는 이미지 onLoad 에서 초기화된다. 이미 로드돼 있으면 즉시.
    if (imgRef.current?.complete) initMask()
  }, [source, initMask])

  useEffect(() => {
    return () => {
      if (resultUrl) URL.revokeObjectURL(resultUrl)
    }
  }, [resultUrl])

  // 리사이즈 시 오버레이 다시 그리기
  useEffect(() => {
    drawOverlay()
    const stage = stageRef.current
    if (!stage) return
    const ro = new ResizeObserver(() => drawOverlay())
    ro.observe(stage)
    return () => ro.disconnect()
  }, [drawOverlay])

  // 좌표 변환(화면 → 원본 픽셀)
  const getPos = useCallback((e: React.PointerEvent) => {
    const overlay = overlayRef.current!
    const img = imgRef.current!
    const rect = overlay.getBoundingClientRect()
    const dx = e.clientX - rect.left
    const dy = e.clientY - rect.top
    const scale = img.naturalWidth / rect.width // 원본px / 화면px
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
      const radius = (brush / 2) * scale // 원본 픽셀 반지름
      mctx.lineCap = 'round'
      mctx.lineJoin = 'round'
      mctx.lineWidth = radius * 2
      if (tool === 'brush') {
        mctx.globalCompositeOperation = 'source-over'
        mctx.strokeStyle = NAVY
        mctx.fillStyle = NAVY
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
    [brush, tool],
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
    if (mask) {
      const mctx = mask.getContext('2d')
      mctx?.clearRect(0, 0, mask.width, mask.height)
    }
    setHasPaint(false)
    setResultUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    resultBlob.current = null
    drawOverlay()
  }, [drawOverlay])

  const apply = useCallback(async () => {
    const mask = maskRef.current
    const img = imgRef.current
    if (!mask || !img || !hasPaint) return
    setWorking(true)
    setError(null)
    try {
      const w = img.naturalWidth
      const h = img.naturalHeight
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('canvas 컨텍스트를 만들 수 없어요.')

      // 원본을 그린 뒤, 칠하지 않은 픽셀을 투명 처리
      const src = img.complete ? img : await loadImage(source.url)
      ctx.drawImage(src, 0, 0, w, h)
      const out = ctx.getImageData(0, 0, w, h)
      const mctx = mask.getContext('2d')!
      const md = mctx.getImageData(0, 0, w, h).data
      const od = out.data
      for (let i = 0; i < w * h; i++) {
        if (md[i * 4 + 3] === 0) od[i * 4 + 3] = 0
      }
      ctx.putImageData(out, 0, 0)

      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('PNG 생성 실패'))),
          'image/png',
        ),
      )
      resultBlob.current = blob
      const url = URL.createObjectURL(blob)
      setResultUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return url
      })
      triggerDownload(blob, outputName(source.file.name))
    } catch (err) {
      console.error(err)
      const detail = err instanceof Error ? err.message : String(err ?? '')
      setError('누끼 생성에 실패했어요.' + (detail ? ` (${detail})` : ''))
    } finally {
      setWorking(false)
    }
  }, [hasPaint, source.url])

  return (
    <div className="panel">
      <p className="hint">
        남기고 싶은 부분을 브러시로 칠하세요. 칠한 영역만 남고 나머지는 투명해집니다.
        잘못 칠했으면 지우개로 지우면 돼요.
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
              <img src={resultUrl} alt="칠한 영역만 남긴 결과" />
            ) : (
              <div className="canvas__pending">
                {working ? '만드는 중…' : '칠한 뒤 “누끼 만들기”를 눌러 주세요'}
              </div>
            )}
          </div>
        </figure>
      </div>

      {error && <p className="error-note">{error}</p>}

      <div className="controls">
        <div className="actions actions--full">
          <button
            className="btn btn--primary"
            onClick={apply}
            disabled={!hasPaint || working}
          >
            {working ? '만드는 중…' : '누끼 만들기'}
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
