import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The dev UI proxies /api to the API server; read its PORT from .env so the two always match.
const apiPort = loadEnv('development', process.cwd(), '').PORT || '8787';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': { target: `http://localhost:${apiPort}`, changeOrigin: true } },
  },
});
