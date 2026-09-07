import React from 'react'
import ReactDOM from 'react-dom/client'
import axios from 'axios'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App.jsx'
import { installBranchInterceptor } from './utils/apiClient'
import './index.css'

// All API calls in this app use relative paths (e.g. '/api/...'). In dev, Vite's
// server.proxy forwards those to the backend. In a production build there is no
// dev server, so axios needs an explicit base URL pointing at the real backend.
//
// Priority: VITE_API_URL (set it in the host's build env to override) → for any
// non-localhost deployment fall back to the Render backend, since the frontend is a
// static site with no /api proxy of its own and a relative '/api/...' would just 404
// against the static host → otherwise '' so the Vite dev proxy handles it locally.
const isLocalhost = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname)
axios.defaults.baseURL =
  import.meta.env.VITE_API_URL ||
  (isLocalhost ? '' : 'https://g-trade-backend.onrender.com')

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
