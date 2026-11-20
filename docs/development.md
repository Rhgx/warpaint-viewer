# Development

Requires Node 22+. Install dependencies with `npm install`, then:

| Script | Purpose |
| ------ | ------- |
| `npm run dev` | Start the Vite dev server |
| `npm run build` | Type-check and build the production bundle |
| `npm run preview` | Preview the built `dist/` bundle locally |
| `npm run typecheck` | Run `tsc -b` and test-suite type-checking (`typecheck:test`) |
| `npm run lint` | Run oxlint |
| `npm test` | Run the Vitest suites |
| `npm run knip` | Check for unused files, exports, and dependencies |
| `npm run verify:editor` | Run the visual editor Vitest suites |
| `npm run verify:examples` | Audit local `.tmp/example-warpaints/*.zip` archives (opt-in; skipped in default `npm test`) |
| `npm run verify:selftest` | Run `/?selftest=1` compositor and particle checks in a headless browser (pass `-- --preview` to test `dist/`) |
| `npm run verify:e2e` | Run the Showcase Board end-to-end suite in a headless Chromium/Edge browser |
| `npm run verify:perf` | Measure production load and paint-switch timings across profiles (`fast`, `throttled`) |
| `npm run verify:perf:compare` | Compare two saved performance runs from `.tmp/perf/` |
| `npm run update:warpaints` | Regenerate `public/data` (manifest, recipe bundles, textures) from a local TF2 install |
| `npm run update:operation-templates` | Regenerate `public/data/operation-templates.json` from the shipped `protodefs-full.bin` (also runs at the end of `update:warpaints`) |
| `npm run update:texture-directory` | Refresh `public/data/texture-directory.json` from Pyxell's TF2 Warpaint Texture Directory |
| `npm run extract:effects` | Regenerate unusual-effect particle data from TF2's PCF files |
| `npm run extract:map-lighting` | Regenerate map lighting presets from TF2 BSP files |
| `npm run extract:stat-clock` | Regenerate Stat Clock model and digit data from a local TF2 install |
| `npm run gen:protodefs` | Regenerate the browser protobuf schema from `tools/proto/tf_proto_def_messages.proto` |

## Environment variables

| Variable | Purpose |
| -------- | ------- |
| `VITE_BASE_PATH` | Base URL path for Vite builds (defaults to `/`; GitHub Pages sets `/<repo>/`) |
| `VITE_TEXTURE_URL` | External base URL for `public/data/textures/` (when unset, textures load from `public/data/textures/`) |
| `VITE_PERF_MARKS` | Set to `1` during builds to emit `wpv:*` `performance.mark` entries and expose `__perfPaint` / `__showcase` hooks |
| `BROWSER_PATH` | Path to a Chromium, Chrome, or Edge executable for `verify:selftest` and `verify:e2e` (auto-detected if unset) |
| `SELFTEST_TIMEOUT_MS` | Timeout in milliseconds for `npm run verify:selftest` (default `90000`) |

## Game data and texture hosting

The extraction scripts in `tools/` read a local Team Fortress 2 installation
and write derived data into `public/data`; the app itself never needs the game
installed. Warpaint recipes are stored as one bundle per paint kit
(`public/data/recipes/<id>.json`) holding every weapon/team/wear variant, and
compositor textures are lossless WebP.

Because GitHub Pages caps a site at 1 GB, production builds can serve
`public/data/textures/` from Cloudflare Pages via
[deploy-textures.yml](../.github/workflows/deploy-textures.yml). When the
repository variable `TEXTURE_URL` is configured:

- `deploy-textures.yml` deploys `public/data/textures/` to Cloudflare Pages
  whenever files under `public/data/textures/**` change (or via manual
  `workflow_dispatch`).
- `deploy-pages.yml` checks out the repository without `public/data/textures/`
  and passes `VITE_TEXTURE_URL` at build time so `src/data/loader.ts` points
  texture fetches at Cloudflare Pages.
- `ci.yml` also uses a sparse checkout without `public/data/textures/` since
  type-checking, linting, unit tests, `knip`, `vite build`, and `verify:selftest`
  do not require the stock texture corpus.

## Harnesses and verification

- `/?selftest=1` composites known recipes offscreen and asserts the
  compositor's pixel math, scheduling, and particle simulations; the page title
  becomes `SELFTEST PASS` or `SELFTEST FAIL`.
- `npm run verify:selftest` launches a local Vite server and headless browser
  (using `BROWSER_PATH` or platform defaults, with SwiftShader WebGL on Linux)
  and exits non-zero on failure. Pass `-- --preview` to test the built `dist/`
  output (as CI does).
- `tools/dev/selftest-driver.mjs` attaches to an already-running browser on CDP
  port `9334` for manual debugging of `/?selftest=1`.
- `/?data=mock` boots the app against tiny generated placeholder data, with no
  real assets required.
- `npm run verify:e2e` drives Showcase Board saves, `.pegboard` export/import,
  and replaced textures in a real headless browser. Set `BROWSER_PATH` if your
  browser is not in a standard location.
- `npx vitest run tools/verify/protodefs/protodefs.test.mjs` resolves every shipped recipe
  variant through the in-browser proto_defs decoder and compares it against
  both the recipe bundles and the extraction pipeline, so a porting difference
  is told apart from data that predates the installed game.
- `npm test` runs the typed Vitest suites, including deterministic VTF
  encoder/decoder, VPK writer/reader, GIF, and APNG round trips.
- `npm run verify:vtf -- <path>` additionally compares a re-encode of a real
  Valve texture against the original's header, flags and image-section size.
- `npm run verify:vpk-interop` checks the VPK writer against TF2's own
  `bin/vpk.exe`, which catches a container Valve's tools read differently than
  this repository's reader.
- `npx vitest run tools/verify/protodefs/protodefs-write.test.mjs` asserts the proto_defs
  writer reproduces the shipped container byte for byte when nothing is
  spliced, then checks both splice modes through two independent decoders.
- `npx vitest run tools/verify/protodefs/protodef-json.test.mjs` resolves community JSON
  war paint definitions.
- `npx vitest run tools/verify/source/vmt-parity.test.mjs` compares the browser VMT
  parser against the stock materials produced by the extraction pipeline.

Optional verification fixtures can be selected with `TF2_PROTODEFS`,
`TF2_FRAGMENT_DIR`, `TF2_VPK_EXE`, and `TF2_VTF_FIXTURE` environment variables.
Missing optional fixtures are reported as skipped tests.

## Errors

Application errors use stable `WV-AREA-NNNN` codes with separate user-facing
and technical messages. See [Error codes](error-codes.md) for the API,
allocation rules, and current registry.
