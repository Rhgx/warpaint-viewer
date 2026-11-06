import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './app/App.tsx'
import { syncFavicon } from './settings'

// The script in index.html has already put the saved theme on the page.
if (document.documentElement.hasAttribute('data-theme')) void syncFavicon()

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
