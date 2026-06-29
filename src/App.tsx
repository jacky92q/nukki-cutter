import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { ACCEPTED, normalizeImage, type Loaded } from './lib/files'
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
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    return () => {
      if (source) URL.revokeObjectURL(source.url)
    }
    // 언마운트 시 1회 정리.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const acceptFile = useCallback(async (file: File) => {
    if (!ACCEPTED.includes(file.type)) {
      setError('PNG · JPG · WebP 이미지 파일만 사용할 수 있어요.')
      return
    }
    setError(null)
    setLoading(true)
    try {
      // 브라우저에서 직접 디코딩 + EXIF 방향 보정 + 과대 해상도 축소.
      // (고해상도 모바일 원본을 그대로 엔진에 넘기면 디코딩 오류가 날 수 있다)
      const { blob, width, height } = await normalizeImage(file)
      setSource((prev) => {
        if (prev) URL.revokeObjectURL(prev.url)
        return { file, blob, url: URL.createObjectURL(blob), width, height }
      })
    } catch (err) {
      console.error(err)
      setError('이미지를 불러오지 못했어요. 다른 사진으로 다시 시도해 주세요.')
    } finally {
      setLoading(false)
    }
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

  // 클립보드(Ctrl/Cmd+V)로 붙여넣은 이미지 받기 — 파일 첨부가 막힌 환경 대비.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) {
            e.preventDefault()
            acceptFile(file)
            return
          }
        }
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [acceptFile])

  // "클립보드에서 붙여넣기" 버튼 — Clipboard API 로 직접 읽는다(권한 필요할 수 있음).
  const pasteFromClipboard = useCallback(async () => {
    try {
      const clip = navigator.clipboard as Clipboard & {
        read?: () => Promise<ClipboardItem[]>
      }
      if (!clip?.read) {
        setError('이 브라우저는 버튼 붙여넣기를 지원하지 않아요. Ctrl/Cmd+V 로 붙여넣어 보세요.')
        return
      }
      const items = await clip.read()
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'))
        if (type) {
          const blob = await item.getType(type)
          await acceptFile(
            new File([blob], 'pasted.png', { type: blob.type || 'image/png' }),
          )
          return
        }
      }
      setError('클립보드에 이미지가 없어요. 이미지를 복사한 뒤 다시 눌러 주세요.')
    } catch (err) {
      console.error(err)
      setError('클립보드를 읽지 못했어요. Ctrl/Cmd+V 로 직접 붙여넣어 보세요.')
    }
  }, [acceptFile])

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
            <p className="dropzone__title">
              {loading ? '이미지 불러오는 중…' : '이미지를 여기에 끌어다 놓거나 붙여넣으세요'}
            </p>
            <p className="dropzone__sub">
              클릭해서 선택 · <b>Ctrl/Cmd+V 로 붙여넣기</b> · 드래그 앤 드롭 · PNG · JPG · WebP
            </p>
            <button
              type="button"
              className="btn btn--ghost dropzone__paste"
              onClick={(e) => {
                e.stopPropagation()
                pasteFromClipboard()
              }}
            >
              📋 클립보드에서 붙여넣기
            </button>
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
                  <small>대략 칠하면 AI가 인식</small>
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
