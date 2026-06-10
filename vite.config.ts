import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // 누끼 모델(@imgly/background-removal)이 멀티스레드 WASM/WebGPU를 활용할 수 있도록
    // cross-origin isolation 헤더를 켜둔다. 모든 처리는 브라우저 내부에서만 일어난다.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  optimizeDeps: {
    exclude: ['@imgly/background-removal'],
  },
})
