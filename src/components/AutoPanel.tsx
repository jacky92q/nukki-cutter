import { useCallback, useEffect, useRef, useState } from 'react'
import { cutout, type ProgressInfo, type Quality } from '../lib/removeBg'
import { outputName, triggerDownload, type Loaded } from '../lib/files'

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
      const blob = await cutout(source.file, quality, setProgress)
      resultBlob.current = blob
      const url = URL.createObjectURL(blob)
      setResultUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return url
      })
      setStatus('done')
      // 결과가 나오면 자동으로 다운로드.
      triggerDownload(blob, outputName(source.file.name))
    } catch (err) {
      console.error(err)
      setError('배경 제거 중 문제가 발생했어요. 다른 이미지로 다시 시도해 주세요.')
      setStatus('error')
    }
  }, [source, quality])

  return (
    <div className="panel">
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
              onClick={() =>
                resultBlob.current &&
                triggerDownload(resultBlob.current, outputName(source.file.name))
              }
            >
              다시 다운로드
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
          ✓ 누끼 완료! 투명 배경 PNG 가 자동으로 다운로드되었어요.
        </p>
      )}
      {status === 'error' && error && <p className="error-note">{error}</p>}
    </div>
  )
}
