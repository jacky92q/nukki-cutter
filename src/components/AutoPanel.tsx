import { useCallback, useEffect, useRef, useState } from 'react'
import { cutout, type ProgressInfo, type Quality } from '../lib/removeBg'
import { outputName, type Loaded } from '../lib/files'
import ResultModal from './ResultModal'

type Status = 'ready' | 'processing' | 'done' | 'error'

interface Props {
  source: Loaded
}

/** 자동 누끼(ISNet) — 사진 전체에서 주요 피사체를 자동으로 잡아 배경을 제거한다. */
export default function AutoPanel({ source }: Props) {
  const [status, setStatus] = useState<Status>('ready')
  const [quality, setQuality] = useState<Quality>('best')
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [progress, setProgress] = useState<ProgressInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [modalBlob, setModalBlob] = useState<Blob | null>(null)
  const resultBlob = useRef<Blob | null>(null)

  // 이미지가 바뀌면 결과를 초기화한다.
  useEffect(() => {
    setStatus('ready')
    setResultUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    setProgress(null)
    setError(null)
    setModalBlob(null)
    resultBlob.current = null
  }, [source])

  useEffect(() => {
    return () => {
      if (resultUrl) URL.revokeObjectURL(resultUrl)
    }
  }, [resultUrl])

  const busy = status === 'processing'

  const start = useCallback(async () => {
    setStatus('processing')
    setError(null)
    setProgress({ stage: '준비 중', ratio: 0 })
    try {
      // 정규화된 Blob 을 넘긴다(원본 File 그대로 넘기면 모바일 고해상도에서 디코딩 실패 가능).
      const blob = await cutout(source.blob, quality, setProgress)
      resultBlob.current = blob
      const url = URL.createObjectURL(blob)
      setResultUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return url
      })
      setStatus('done')
      // 결과 확인 팝업을 열어 다운로드 여부를 사용자가 결정하게 한다.
      setModalBlob(blob)
    } catch (err) {
      console.error(err)
      const detail = err instanceof Error ? err.message : String(err ?? '')
      setError(
        '배경 제거에 실패했어요. 잠시 후 다시 시도하거나 “지정” 모드를 사용해 보세요.' +
          (detail ? `\n(상세: ${detail.slice(0, 200)})` : ''),
      )
      setStatus('error')
    }
  }, [source, quality])

  return (
    <div className="panel">
      <div className="canvas-grid">
        <figure className="canvas">
          <figcaption className="canvas__label">원본</figcaption>
          <div className="media-frame">
            <img src={source.url} alt="원본 이미지" />
          </div>
        </figure>
        <figure className="canvas">
          <figcaption className="canvas__label">결과 (투명 배경)</figcaption>
          <div className="media-frame media-frame--checker">
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

      {status === 'ready' && (
        <p className="hint">
          처음 실행 시 모델을 한 번 내려받아요(수십 MB). 이후에는 캐시되어 빠릅니다.
        </p>
      )}

      <div className="controls">
        <fieldset className="quality" disabled={busy}>
          <legend>품질</legend>
          <label className={`quality__opt${quality === 'best' ? ' quality__opt--on' : ''}`}>
            <input
              type="radio"
              name="quality"
              checked={quality === 'best'}
              onChange={() => setQuality('best')}
            />
            최고 품질
            <small>디테일 정밀 · 조금 느림</small>
          </label>
          <label className={`quality__opt${quality === 'fast' ? ' quality__opt--on' : ''}`}>
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

        <div className="actions">
          {status === 'done' && resultBlob.current ? (
            <button
              className="btn btn--primary"
              onClick={() => resultBlob.current && setModalBlob(resultBlob.current)}
            >
              다운로드 / 편집
            </button>
          ) : (
            <button className="btn btn--primary" onClick={start} disabled={busy}>
              {busy ? '배경 제거 중…' : '작업 시작'}
            </button>
          )}
        </div>
      </div>

      {status === 'done' && (
        <p className="done-note">
          ✓ 누끼 완료! 결과를 확인하고 다운로드하세요.
        </p>
      )}
      {status === 'error' && error && <p className="error-note">{error}</p>}

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
