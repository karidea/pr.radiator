import { defineConfig } from 'vite';

export default defineConfig({
  base: '/pr.radiator/',
  server: {
    port: 3000,
    open: true,
  },
  build: {
    target: 'esnext',
    outDir: 'docs'
  }
})
