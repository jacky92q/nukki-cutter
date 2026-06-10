import { useCallback, useEffect, useRef, useState } from 'react'
import { cutout, type ProgressInfo, type Quality } from './lib/removeBg'

type Status = 'idle' | 'loaded' | 'processing' | 'done' | 'error'

interface Loaded {
  file: File
  url: string
}

const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp']

/** 원본 파일명에서 확장자를 떼고 누끼 결과용 이름을 만든다. */
function outputName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '')
  return `${base || 'image'}-nukki.png`
}

export default function App() {
  const [status, setStatus] = useState<Status>('idle')
  const [quality, setQuality] = useState<Quality>('best')
  const [source, setSource] = useState<Loaded | null>(null)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [progress, setProgress] = useState<ProgressInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  // 자동 다운로드를 트리거하기 위한 숨겨진 앵커.
  const downloadRef = useRef<HTMLAnchorElement>(null)

  // 컴포넌트가 사라질 때 object URL 정리 (메모리 누수 방지).
  useEffect(() => {
    return () => {
      if (source) URL.revokeObjectURL(source.url)
      if (resultUrl) URL.revokeObjectURL(resultUrl)
    }
    // 언마운트 시 1회만 정리하면 충분하다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const reset = useCallback(() => {
    setSource((prev) => {
      if (prev) URL.revokeObjectURL(prev.url)
      return null
    })
    setResultUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    setProgress(null)
    setError(null)
    setStatus('idle')
  }, [])

  const acceptFile = useCallback(
    (file: File) => {
      if (!ACCEPTED.includes(file.type)) {
        setError('PNG · JPG · WebP 이미지 파일만 사용할 수 있어요.')
        setStatus('error')
        return
      }
      setSource((prev) => {
        if (prev) URL.revokeObjectURL(prev.url)
        return { file, url: URL.createObjectURL(file) }
      })
      setResultUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return null
      })
      setError(null)
      setProgress(null)
      setStatus('loaded')
    },
    [],
  )

  const onPick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) acceptFile(file)
      // 같은 파일을 다시 선택해도 onChange 가 발화하도록 초기화.
      e.target.value = ''
    },
    [acceptFile],
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      const file = e.dataTransfer.files?.[0]
      if (file) acceptFile(file)
    },
    [acceptFile],
  )

  const start = useCallback(async () => {
    if (!source) return
    setStatus('processing')
    setError(null)
    setProgress({ stage: '준비 중', ratio: 0 })
    try {
      const blob = await cutout(source.file, quality, setProgress)
      const url = URL.createObjectURL(blob)
      setResultUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return url
      })
      setStatus('done')

      // 결과가 나오면 자동으로 다운로드를 트리거한다.
      requestAnimationFrame(() => {
        const a = downloadRef.current
        if (a) {
          a.href = url
          a.download = outputName(source.file.name)
          a.click()
        }
      })
    } catch (err) {
      console.error(err)
      setError(
        '배경 제거 중 문제가 발생했어요. 다른 이미지로 다시 시도해 주세요.',
      )
      setStatus('error')
    }
  }, [source, quality])

  const busy = status === 'processing'

  return (
    <div className="page">
      <header className="header">
        <div className="brand">
          <span className="brand__mark" aria-hidden>
            ✂
          </span>
          <div>
            <h1 className="brand__name">Nukki Cutter</h1>
            <p className="brand__tag">
              브라우저 안에서만 동작하는 누끼 도구 · 이미지가 외부로 전송되지
              않습니다
            </p>
          </div>
        </div>
      </header>

      <main className="main">
        {/* 1) 이미지 불러오기 영역 */}
        {(status === 'idle' || status === 'error') && (
          <section
            className={`dropzone${dragging ? ' dropzone--active' : ''}`}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click()
            }}
          >
            <div className="dropzone__icon" aria-hidden>
              ⬆
            </div>
            <p className="dropzone__title">
              이미지를 여기에 끌어다 놓으세요
            </p>
            <p className="dropzone__sub">
              또는 클릭해서 사진첩·파일에서 선택 · PNG · JPG · WebP
            </p>
            {status === 'error' && error && (
              <p className="dropzone__error">{error}</p>
            )}
          </section>
        )}

        {/* 2) 미리보기 + 작업 시작 */}
        {source && status !== 'idle' && status !== 'error' && (
          <section className="workspace">
            <div className="canvas-grid">
              <figure className="canvas">
                <figcaption className="canvas__label">원본</figcaption>
                <div className="canvas__frame">
                  <img src={source.url} alt="원본 이미지" />
                </div>
              </figure>

              <figure className="canvas">
                <figcaption className="canvas__label">결과 (투명 배경)</figcaption>
                <div className="canvas__frame canvas__frame--checker">
                  {resultUrl ? (
                    <img src={resultUrl} alt="배경이 제거된 결과 이미지" />
                  ) : (
                    <div className="canvas__pending">
                      {busy ? '처리 중…' : '작업 시작을 눌러 주세요'}
                    </div>
                  )}
                </div>
              </figure>
            </div>

            {busy && progress && (
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

            <div className="controls">
              {status === 'loaded' && (
                <fieldset className="quality" disabled={busy}>
                  <legend>품질</legend>
                  <label
                    className={`quality__opt${
                      quality === 'best' ? ' quality__opt--on' : ''
                    }`}
                  >
                    <input
                      type="radio"
                      name="quality"
                      checked={quality === 'best'}
                      onChange={() => setQuality('best')}
                    />
                    최고 품질
                    <small>디테일 정밀 · 조금 느림</small>
                  </label>
                  <label
                    className={`quality__opt${
                      quality === 'fast' ? ' quality__opt--on' : ''
                    }`}
                  >
                    <input
                      type="radio"
                      name="quality"
                      checked={quality === 'fast'}
                      onChange={() => setQuality('fast')}
                    />
                    빠른 속도
                    <small>가벼운 모델 · 빠름</small>
                  </label>
                </fieldset>
              )}

              <div className="actions">
                {status === 'loaded' && (
                  <button className="btn btn--primary" onClick={start}>
                    작업 시작
                  </button>
                )}
                {status === 'processing' && (
                  <button className="btn btn--primary" disabled>
                    배경 제거 중…
                  </button>
                )}
                {status === 'done' && resultUrl && source && (
                  <a
                    className="btn btn--primary"
                    href={resultUrl}
                    download={outputName(source.file.name)}
                  >
                    다시 다운로드
                  </a>
                )}
                <button
                  className="btn btn--ghost"
                  onClick={reset}
                  disabled={busy}
                >
                  새 이미지
                </button>
              </div>
            </div>

            {status === 'done' && (
              <p className="done-note">
                ✓ 누끼 완료! 투명 배경 PNG 가 자동으로 다운로드되었어요.
              </p>
            )}
          </section>
        )}

        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED.join(',')}
          hidden
          onChange={onPick}
        />
        <a ref={downloadRef} hidden aria-hidden />
      </main>

      <footer className="footer">
        모든 처리는 이 기기의 브라우저 안에서 이루어집니다 · 서버 업로드 없음
      </footer>
    </div>
  )
}
