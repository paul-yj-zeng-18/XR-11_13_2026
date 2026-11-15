import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `npm run dev`        -> http://localhost:5173 (mic + webcam work on localhost)
// `npm run dev:https`  -> https://<your-lan-ip>:5173 so a Quest / phone on the
//                         same Wi-Fi can open it (browsers need HTTPS for mic + WebXR)
export default defineConfig(({ mode }) => ({
  // relative paths so the build works under https://<user>.github.io/<repo>/
  base: './',
  plugins: mode === 'https' ? [basicSsl()] : [],
  server: {
    host: mode === 'https' ? true : 'localhost',
    port: 5173,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
}));
