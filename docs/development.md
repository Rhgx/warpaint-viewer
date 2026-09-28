# Development

Requires Node 22+. Install dependencies with `npm install`, then:

| Script | Purpose |
| ------ | ------- |
| `npm run dev` | Start the Vite dev server |
| `npm run build` | Type-check and build the production bundle |
| `npm test` | Run the Vitest suites |
| `npm run lint` | Run oxlint |
| `npm run update:warpaints` | Regenerate `public/data` (manifest, recipe bundles, textures) from a local TF2 install |
| `npm run extract:effects` | Regenerate unusual-effect particle data from TF2's PCF files |
| `npm run extract:map-lighting` | Regenerate map lighting presets from TF2 BSP files |
| `npm run gen:protodefs` | Regenerate the browser protobuf schema from `tools/proto/tf_proto_def_messages.proto` |

## Game data

The extraction scripts in `tools/` read a local Team Fortress 2 installation
and write derived data into `public/data`; the app itself never needs the game
installed. Warpaint recipes are stored as one bundle per paint kit
(`public/data/recipes/<id>.json`) holding every weapon/team/wear variant, and
compositor textures are lossless WebP.

## Harnesses and verification

- `/?selftest=1` composites known recipes offscreen and asserts the
  compositor's pixel math; the page title becomes `SELFTEST PASS` or
  `SELFTEST FAIL`.
- `/?data=mock` boots the app against tiny generated placeholder data, with no
  real assets required.
- `tools/dev/selftest-driver.mjs` drives the selftest page in headless Edge
  over raw CDP (see its header comment for usage).
- `npx vitest run tools/verify/protodefs.test.mjs` resolves every shipped recipe
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
- `npx vitest run tools/verify/protodefs-write.test.mjs` asserts the proto_defs
  writer reproduces the shipped container byte for byte when nothing is
  spliced, then checks both splice modes through two independent decoders.
- `npx vitest run tools/verify/protodef-json.test.mjs` resolves community JSON
  war paint definitions.
- `npx vitest run tools/verify/vmt-parity.test.mjs` compares the browser VMT
  parser against the stock materials produced by the extraction pipeline.

Optional verification fixtures can be selected with `TF2_PROTODEFS`,
`TF2_FRAGMENT_DIR`, `TF2_VPK_EXE`, and `TF2_VTF_FIXTURE` environment variables.
Missing optional fixtures are reported as skipped tests.

## Errors

Application errors use stable `WV-AREA-NNNN` codes with separate user-facing
and technical messages. See [Error codes](error-codes.md) for the API,
allocation rules, and current registry.
