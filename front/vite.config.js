import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  esbuild: {
    charset: 'utf8',
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
    headers: {
      'Content-Language': 'ko',
    },
  },
  preview: {
    headers: {
      'Content-Language': 'ko',
    },
  },
  build: {
    chunkSizeWarningLimit: 1500, // 1.5MB까지만 경고
  },
})
