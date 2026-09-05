import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  server: { port: 5173, host: true, proxy: { '/api': 'http://localhost:8787' } },
  build: { outDir: '../../dist/web', emptyOutDir: true },
});
