import React from 'react'
import ReactDOM from 'react-dom/client'
import axios from 'axios'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App.jsx'
import { installBranchInterceptor } from './utils/apiClient'
import { installAlertOverride } from './utils/notify'
import './index.css'

// Every alert(...) in the app shows as an in-page notice at the bottom of the screen
// (rendered by <NotificationHost /> in App.jsx) instead of a blocking browser popup.
installAlertOverride()

// All API calls in this app use relative paths (e.g. '/api/...'). In dev, Vite's
// server.proxy forwards those to the backend. In a production build there is no
// dev server, so axios needs an explicit base URL pointing at the real backend.
//
// Priority: VITE_API_URL (set it in the Vercel project's build env to override — do that
// if the Render service ends up on a different hostname than the default below) → for any
// non-localhost deployment fall back to the Render backend, since the frontend is a
// static site with no /api proxy of its own and a relative '/api/...' would just 404
// against the static host → otherwise '' so the Vite dev proxy handles it locally.
//
// Deliberately absolute rather than relying on the /api/* rewrite in vercel.json: a Render
// free-tier instance spins down when idle and takes ~50s to wake, which outlives Vercel's
// proxy timeout, whereas the browser will happily wait out a direct request. Keep this host
// and vercel.json's rewrite destination in step.
const isLocalhost = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname)
axios.defaults.baseURL =
  import.meta.env.VITE_API_URL ||
  (isLocalhost ? '' : 'https://g-opticals-backend.onrender.com')

// Attach X-Branch-Id / X-User-Name headers to every API request.
installBranchInterceptor()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1
    }
  }
})

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
)
