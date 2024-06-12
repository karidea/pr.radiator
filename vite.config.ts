import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  base: '/pr.radiator/',
  server: {
    port: 3000,
    open: true,
  },
  build: {
    outDir: 'docs'
  },
  plugins: [react()],
})
