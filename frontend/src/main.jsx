import React from 'react'
import ReactDOM from 'react-dom/client'
import axios from 'axios'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App.jsx'
import { installBranchInterceptor } from './utils/apiClient'
import { installAlertOverride } from './utils/notify'
import { resolveApiBaseUrl, installBackendHealthWatch } from './utils/backendStatus'
import './index.css'

// Every alert(...) in the app shows as an in-page notice at the bottom of the screen
// (rendered by <NotificationHost /> in App.jsx) instead of a blocking browser popup.
installAlertOverride()

// All API calls in this app use relative paths (e.g. '/api/...'). In dev, Vite's
// server.proxy forwards those to the backend. In a production build there is no dev server,
// so axios needs an explicit base URL pointing at the real backend.
//
// resolveApiBaseUrl() owns that decision and the reasoning behind it — including the
// localStorage escape hatch that lets a deployed build be repointed at a different backend
// without rebuilding it. Keep its DEFAULT_DEPLOYED_API_URL in step with vercel.json's
// /api/* rewrite destination and render.yaml's service name.
axios.defaults.baseURL = resolveApiBaseUrl()

// Attach X-Branch-Id / X-User-Name headers to every API request.
installBranchInterceptor()

// Probe /api/health/ at boot and watch every later response, so an unreachable backend or a
// backend running on a dead database shows as a banner instead of as empty screens that
// look identical to a business with no data yet.
installBackendHealthWatch()

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
