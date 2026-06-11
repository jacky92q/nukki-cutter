import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/** 캐시 꼬임/잘못된 서비스워커 상태에서 복구한다: SW 해제 + 캐시 비우기 + 새로고침. */
async function recoverAndReload() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(regs.map((r) => r.unregister()))
    }
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
    }
  } catch {
    /* 복구 실패해도 새로고침은 진행 */
  } finally {
    location.reload()
  }
}

/**
 * 렌더 중 발생한 오류(지연 로딩 청크 실패 등)를 잡아 화면이 통째로 사라지는 것을
 * 막는다. 백지 대신 복구 안내와 새로고침 버튼을 보여준다.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI 오류:', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="boundary">
          <div className="boundary__icon" aria-hidden>
            ⚠
          </div>
          <p className="boundary__title">화면을 표시하지 못했어요</p>
          <p className="boundary__sub">
            일시적인 문제일 수 있어요. 새로고침하면 대부분 해결됩니다.
          </p>
          <div className="boundary__actions">
            <button className="btn btn--primary" onClick={recoverAndReload}>
              새로고침 후 복구
            </button>
          </div>
          <p className="boundary__detail">{this.state.error.message}</p>
        </div>
      )
    }
    return this.props.children
  }
}
