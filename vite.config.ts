import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  // dev · preview · 빌드 모두 GitHub Pages 와 동일한 /nukki-cutter/ 경로로 통일.
  // (PWA 매니페스트·서비스워커 경로가 환경마다 어긋나지 않게 하기 위함)
  base: '/nukki-cutter/',
  plugins: [react()],
  server: {
    // 로컬 개발 시 누끼 모델(@imgly/background-removal)이 멀티스레드 WASM 을 쓸 수 있도록
    // cross-origin isolation 헤더를 켜둔다. 모든 처리는 브라우저 내부에서만 일어난다.
    // (GitHub Pages 에는 이 헤더를 줄 수 없으므로, 그곳에서는 WebGPU 또는 단일 스레드 WASM 으로 동작한다.)
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  optimizeDeps: {
    exclude: ['@imgly/background-removal'],
  },
})
