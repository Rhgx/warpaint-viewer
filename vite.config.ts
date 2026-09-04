import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    exclude: [...configDefaults.exclude, '**/.tmp/**'],
  },
  // GitHub Pages project sites live beneath the repository name. The deploy
  // workflow supplies this path while local development continues at `/`.
  base: process.env.VITE_BASE_PATH ?? '/',
})
