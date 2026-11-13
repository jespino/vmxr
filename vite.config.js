import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// WebXR needs a secure context. localhost is fine over http; to open the app
// from a headset on your LAN run `npm run dev:lan`, which serves over https
// with a self-signed certificate.
export default defineConfig(({ mode }) => ({
  plugins: mode === 'https' ? [basicSsl()] : [],
  base: './',
}));
