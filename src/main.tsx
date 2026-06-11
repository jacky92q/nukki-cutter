import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// PWA: 빌드된(설치형) 환경에서만 서비스 워커를 등록한다.
// (개발 모드에서는 Vite HMR 과의 충돌을 피하기 위해 등록하지 않는다.)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch(() => {
        /* 등록 실패는 치명적이지 않으므로 조용히 무시 */
      })
  })
}
