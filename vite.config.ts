import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// basic auth 配下で動かすため `<script crossorigin>` を除去するplugin。
// crossorigin="anonymous" だと browser が basic auth credentials を送らずに /assets/* を
// fetch し 401 で失敗する。delete することで同origin扱い + 認証ヘッダ送信になる。
const stripCrossOrigin = {
  name: 'strip-crossorigin',
  transformIndexHtml(html: string) {
    return html.replace(/\scrossorigin(="[^"]*")?/g, '');
  },
};

export default defineConfig({
  root: 'src/ui',
  plugins: [react(), stripCrossOrigin],
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
