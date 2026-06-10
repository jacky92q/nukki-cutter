import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig(({ command }) => ({
  // 로컬 개발(serve)은 루트(/)에서, GitHub Pages 배포 빌드는 /nukki-cutter/ 하위 경로에서 동작.
  base: command === 'build' ? '/nukki-cutter/' : '/',
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
}))
