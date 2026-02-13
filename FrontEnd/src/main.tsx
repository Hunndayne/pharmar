import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App'
import { AuthProvider } from './auth/AuthContext'

if (import.meta.env.DEV) {
  const noisyMarkers = [
    '**** InputStreamBrowser createLiveStream',
    '**** InputStreamBrowser createVideoStream',
  ]
  const originalLog = console.log
  console.log = (...args: unknown[]) => {
    const first = typeof args[0] === 'string' ? args[0] : ''
    if (noisyMarkers.some((marker) => first.includes(marker))) return
    originalLog(...args)
  }
}

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <AuthProvider>
      <App />
    </AuthProvider>
  </BrowserRouter>,
)
