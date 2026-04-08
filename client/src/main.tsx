import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

// Prevent Electron/browser default file drop behavior (navigating to file:// URL).
// Individual drop zones (e.g. FileExplorer) call e.preventDefault() themselves and
// handle the files — this global handler is a safety net for drops outside those zones.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

const container = document.getElementById('root')
if (!container) {
  throw new Error('Root element not found')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
