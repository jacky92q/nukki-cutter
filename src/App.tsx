import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { ACCEPTED, type Loaded } from './lib/files'
import ErrorBoundary from './components/ErrorBoundary'

// 모드별로 무거운 모델 코드를 분리해, 해당 모드에 들어갈 때만 불러온다.
const AutoPanel = lazy(() => import('./components/AutoPanel'))
const InteractivePanel = lazy(() => import('./components/InteractivePanel'))

type Mode = 'auto' | 'interactive'

export default function App() {
  const [source, setSource] = useState<Loaded | null>(null)
  const [mode, setMode] = useState<Mode>('auto')
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    return () => {
      if (source) URL.revokeObjectURL(source.url)
    }
    // 언마운트 시 1회 정리.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const acceptFile = useCallback((file: File) => {
    if (!ACCEPTED.includes(file.type)) {
      setError('PNG · JPG · WebP 이미지 파일만 사용할 수 있어요.')
      return
    }
    setError(null)
    setSource((prev) => {
      if (prev) URL.revokeObjectURL(prev.url)
      return { file, url: URL.createObjectURL(file) }
    })
  }, [])

  const onPick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) acceptFile(file)
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

  const reset = useCallback(() => {
    setSource((prev) => {
      if (prev) URL.revokeObjectURL(prev.url)
      return null
    })
    setError(null)
  }, [])

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
              브라우저 안에서만 동작하는 누끼 도구 · 이미지가 외부로 전송되지 않습니다
            </p>
          </div>
        </div>
      </header>

      <main className="main">
        {!source ? (
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
            <p className="dropzone__title">이미지를 여기에 끌어다 놓으세요</p>
            <p className="dropzone__sub">
              또는 클릭해서 사진첩·파일에서 선택 · PNG · JPG · WebP
            </p>
            {error && <p className="dropzone__error">{error}</p>}
          </section>
        ) : (
          <>
            <div className="modebar">
              <div className="tabs" role="tablist">
                <button
                  role="tab"
                  aria-selected={mode === 'auto'}
                  className={`tab${mode === 'auto' ? ' tab--on' : ''}`}
                  onClick={() => setMode('auto')}
                >
                  자동
                  <small>주요 피사체 자동 인식</small>
                </button>
                <button
                  role="tab"
                  aria-selected={mode === 'interactive'}
                  className={`tab${mode === 'interactive' ? ' tab--on' : ''}`}
                  onClick={() => setMode('interactive')}
                >
                  지정
                  <small>원하는 오브젝트 직접 선택</small>
                </button>
              </div>
              <button className="btn btn--ghost" onClick={reset}>
                새 이미지
              </button>
            </div>

            <ErrorBoundary key={mode}>
              <Suspense
                fallback={
                  <div className="panel-loading">
                    <div className="spinner" />
                    <span>불러오는 중…</span>
                  </div>
                }
              >
                {mode === 'auto' ? (
                  <AutoPanel source={source} />
                ) : (
                  <InteractivePanel source={source} />
                )}
              </Suspense>
            </ErrorBoundary>
          </>
        )}

        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED.join(',')}
          hidden
          onChange={onPick}
        />
      </main>

      <footer className="footer">
        모든 처리는 이 기기의 브라우저 안에서 이루어집니다 · 서버 업로드 없음
      </footer>
    </div>
  )
}
