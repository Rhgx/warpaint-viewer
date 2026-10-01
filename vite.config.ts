import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// GitHub Pages project sites live beneath the repository name. The deploy
// workflow supplies this path while local development continues at `/`.
const base = process.env.VITE_BASE_PATH ?? '/'
const textureUrl = process.env.VITE_TEXTURE_URL

// protobufjs probes for Node's fs with a try/catch require. In the dev
// prebundle that lands on Vite's browser-external stub, which warns on every
// property read; an empty module gives the same "no fs" answer quietly.
const emptyFs = {
  name: 'empty-fs',
  resolveId: (id: string) => (id === 'fs' ? '\0empty-fs' : null),
  load: (id: string) => (id === '\0empty-fs' ? 'module.exports = {};' : null),
}

// Boot requests the catalog only after the main bundle has run, and the first
// texture opens a new connection to the texture host mid-boot. Hinting both in
// the HTML starts that work while the bundle is still downloading.
const bootHints = {
  name: 'boot-hints',
  transformIndexHtml: () => [
    ...['manifest.json', 'grades.json'].map((file) => ({
      tag: 'link',
      attrs: { rel: 'preload', href: `${base}data/${file}`, as: 'fetch', crossorigin: true },
    })),
    ...(textureUrl
      ? [{ tag: 'link', attrs: { rel: 'preconnect', href: new URL(textureUrl).origin, crossorigin: true } }]
      : []),
  ],
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), bootHints],
  optimizeDeps: { rolldownOptions: { plugins: [emptyFs] } },
  test: {
    exclude: [...configDefaults.exclude, '**/.tmp/**'],
  },
  base,
})
