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

  // Windows local edition (windows/tooling/build_frontend.py sets VITE_EDITION=local): the app
  // is served by the shop's own server and must not reach out to the internet on load, so the
  // cloud preconnect and the Google Fonts stylesheet are dropped (system fonts are used).
  const isLocalEdition = (env.VITE_EDITION || process.env.VITE_EDITION) === 'local'
  const localEditionHtml = {
    name: 'gtrade-local-edition-html',
    transformIndexHtml(html) {
      if (!isLocalEdition) return html
      // Browser-tab / app name of the Windows product (must match src/utils/brand.js LOCAL.productName).
      const LOCAL_PRODUCT_NAME = 'G OPTICALS'
      return html
        .replace(/<title>[^<]*<\/title>/, `<title>${LOCAL_PRODUCT_NAME}</title>`)
        .replace(/(name="(?:application-name|apple-mobile-web-app-title)" content=")[^"]*"/g, `$1${LOCAL_PRODUCT_NAME}"`)
        .split('\n')
        .filter((line) => !/onrender\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/.test(line))
        .join('\n')
    },
  }

  return {
    base: './',
    plugins: [react(), localEditionHtml],
    define: { __GTRADE_EDITION__: JSON.stringify(isLocalEdition ? 'local' : 'cloud') },
    build: {
      outDir: isLocalEdition ? 'dist-local' : 'dist',
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
      // Browsers resolve any *.localhost name to this machine (and Vite allows it), so the
      // address bar reads the app's name instead of a bare "localhost".
      open: 'http://greensol-optical-erp.localhost:5173/',
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
