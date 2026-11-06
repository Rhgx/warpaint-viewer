import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './app/App.tsx'

if (import.meta.env.DEV && new URLSearchParams(location.search).has('profile')) {
  void import('./dev/profile');
}

// index.html removes #root on a browser below the floor and shows its message instead.
const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
