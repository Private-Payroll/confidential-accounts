import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
export default defineConfig({
  root: 'src/standalone',
  plugins: [react(), viteSingleFile()],
  build: { outDir: '../../dist/standalone', emptyOutDir: true, assetsInlineLimit: 100000000 },
});
