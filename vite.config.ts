import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/ui',
  build: {
    outDir: '../../dist/ui',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4050',
      '/health': 'http://127.0.0.1:4050',
    },
  },
});
