import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = env.VITE_API_URL || 'http://localhost:8000'

  // VITE_API_URL is inlined into the bundle at build time, so a localhost value produces a
  // build whose every API call goes to the user's own machine. That is correct for the
  // Electron desktop build (it ships its own backend on :8000) and fatal for a Vercel
  // deploy. The local .env sets localhost and is git-ignored, so Vercel builds without it
  // and main.jsx's runtime fallback picks the Render URL instead — but if VITE_API_URL ever
  // does get set on the host, nothing else would tell us. Say so at build time.
  if (command === 'build' && /localhost|127\.0\.0\.1/.test(apiTarget)) {
    console.warn(
      [
        '',
        `[vite] NOTE: building with VITE_API_URL=${apiTarget}`,
        '       Correct for the desktop/Electron build. For a Vercel deploy, leave',
        '       VITE_API_URL unset so the app targets the Render backend.',
        '',
      ].join('\n')
    )
  }

  return {
    base: './',
    plugins: [react()],
    build: {
      chunkSizeWarningLimit: 2000,
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
            'vendor-mui': ['@mui/material', '@mui/icons-material'],
            'vendor-charts': ['recharts'],
            'vendor-utils': ['axios']
          }
        }
      }
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
        '/media': {
          target: apiTarget,
          changeOrigin: true,
        }
      }
    }
  }
})
