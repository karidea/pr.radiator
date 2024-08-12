import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import checker from 'vite-plugin-checker';

export default defineConfig({
  base: '/pr.radiator/',
  server: {
    port: 3000,
    open: true,
  },
  build: {
    outDir: 'docs'
  },
  plugins: [react(), checker({ typescript: true })],
})
