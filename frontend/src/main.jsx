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
axios.defaults.baseURL = import.meta.env.VITE_API_URL || ''

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
