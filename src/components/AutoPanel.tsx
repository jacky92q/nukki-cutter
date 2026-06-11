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
  // 기본값은 가볍고 빠른 모델 — 첫 실행에서 다운로드/추론이 더 빨라 성공 확률이 높다.
  const [quality, setQuality] = useState<Quality>('fast')
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
      const detail = err instanceof Error ? err.message : String(err ?? '')
      setError(
        '배경 제거에 실패했어요. 자동 모드는 처음 한 번 모델(수십 MB)을 내려받아요. ' +
          '네트워크가 막혀 있다면 “지정” 모드(브러시)를 쓰면 모델 없이 누끼할 수 있어요.' +
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
