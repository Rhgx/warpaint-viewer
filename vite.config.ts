import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// protobufjs probes for Node's fs with a try/catch require. In the dev
// prebundle that lands on Vite's browser-external stub, which warns on every
// property read; an empty module gives the same "no fs" answer quietly.
const emptyFs = {
  name: 'empty-fs',
  resolveId: (id: string) => (id === 'fs' ? '\0empty-fs' : null),
  load: (id: string) => (id === '\0empty-fs' ? 'module.exports = {};' : null),
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  optimizeDeps: { rolldownOptions: { plugins: [emptyFs] } },
  test: {
    exclude: [...configDefaults.exclude, '**/.tmp/**'],
  },
  // GitHub Pages project sites live beneath the repository name. The deploy
  // workflow supplies this path while local development continues at `/`.
  base: process.env.VITE_BASE_PATH ?? '/',
})
