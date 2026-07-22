import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.VERIDONE_WEB_PORT ?? '4173'),
    strictPort: process.env.VERIDONE_STRICT_PORT === '1',
    proxy: {
      '/api': `http://127.0.0.1:${process.env.VERIDONE_API_PORT ?? '4317'}`,
    },
  },
  preview: {
    host: '127.0.0.1',
    port: Number(process.env.VERIDONE_WEB_PORT ?? '4173'),
    strictPort: process.env.VERIDONE_STRICT_PORT === '1',
  },
});
