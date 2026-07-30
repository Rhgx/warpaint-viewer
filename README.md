# TF2 Warpaint Viewer

A 1:1 recreation of the Team Fortress 2 lighting engine in Three.js, presented as an interactive viewer.

## Features

- Browse and search war paints by name or collection.
- Preview each paint on its supported weapons.
- Compare wear levels and RED/BLU variants.
- Enter or randomize paint seeds.
- Select different lighting environments, viewing angles, sheens, and unusual effects.
- Adjust the camera projection and field of view.
- Export transparent PNG images at multiple resolutions.
- Preview custom war paints: import your own definitions and textures and view
  them on any supported weapon.

## Usage

Select a war paint, choose a supported weapon, and adjust its appearance using the controls below the viewer.

### Camera controls

| Action       | Result                          |
| ------------ | -------------------------------- |
| Drag         | Rotate the weapon               |
| Scroll       | Zoom in or out                  |
| Right-drag   | Move the weapon within the view |
| Double-click | Reset the view                  |

Preset angles, projection options, field-of-view settings, and image export controls are available under **View**.

### Custom war paints

The panel under the viewer holds four tabs:

- **Files** replaces any single texture the selected recipe reads, with PNG,
  JPG, WebP, TGA, or VTF, and an optional separate alpha mask.
- **Package** mounts a Source asset archive (`.zip` or `.vpk`) whose textures
  then take priority over the built-in ones. Archives that keep their textures
  under `materials/` at any depth are read as authored; an archive with no
  `materials/` directory is treated as if its root were one, and its files are
  matched to a recipe by name when no path matches.
- **Definitions** imports a war paint's own definitions: the two JSON files a
  custom paint ships (its operation and its definition, under any file names),
  or a whole `proto_defs.vpd`. Imported paints appear in the catalog under
  **Imported definitions**. JSON definitions are resolved against the base game
  definitions in `public/data/protodefs-base.bin`, so a paint that reuses a
  stock operation template still resolves.
- **Export** packages edited textures and imported definitions as a folder
  `.zip`, or as a `.zip` containing a game-ready `.vpk` and its README.
  Definition exports require the
  [custom_items_games](https://github.com/ficool2/custom_items_games) client
  plugin and TF2 must be launched with `-insecure`; stock TF2 rejects modified
  `proto_defs.vpd` files during startup.

Appending a definition creates a new war-paint index that no owned item refers
to. The [tf2warpaints](https://github.com/Mince1844/tf2warpaints) server plugin
provides chat commands for giving players those war paints while testing and
authoring them. Overwrite mode instead reuses the index of an existing war
paint.

Any of these files can also be dropped anywhere on the panel; each is routed by
its extension. Nothing is uploaded anywhere, and nothing persists across a
reload.

## Development

Requires Node 22+. Install dependencies with `npm install`, then:

| Script | Purpose |
| ------ | ------- |
| `npm run dev` | Start the Vite dev server |
| `npm run build` | Type-check and build the production bundle |
| `npm run lint` | Run oxlint |
| `npm run update:warpaints` | Regenerate `public/data` (manifest, recipe bundles, textures) from a local TF2 install |
| `npm run extract:effects` | Regenerate unusual-effect particle data from TF2's PCF files |
| `npm run extract:map-lighting` | Regenerate map lighting presets from TF2 BSP files |
| `npm run gen:protodefs` | Regenerate the browser protobuf schema from `tools/proto/tf_proto_def_messages.proto` |

The extraction scripts in `tools/` read a local Team Fortress 2 installation
and write derived data into `public/data`; the app itself never needs the game
installed. Warpaint recipes are stored as one bundle per paint kit
(`public/data/recipes/<id>.json`) holding every weapon/team/wear variant, and
compositor textures are lossless WebP.

Developer harnesses:

- `/?selftest=1` composites known recipes offscreen and asserts the
  compositor's pixel math; the page title becomes `SELFTEST PASS` or
  `SELFTEST FAIL`.
- `/?data=mock` boots the app against tiny generated placeholder data, with no
  real assets required.
- `tools/dev/selftest-driver.mjs` drives the selftest page in headless Edge
  over raw CDP (see its header comment for usage).
- `node tools/verify/protodefs.mjs` resolves every shipped recipe variant
  through the in-browser proto_defs decoder and compares it against both the
  recipe bundles and the extraction pipeline, so a porting difference is told
  apart from data that predates the installed game.
- `node tools/verify/vtf-export.mjs` round-trips the browser VTF writer through
  the extraction pipeline's decoder, and compares a re-encode of a real Valve
  texture against the original's header, flags and image-section size.
- `node tools/verify/vpk-write.mjs` round-trips the VPK writer through this
  repository's reader and through TF2's own `bin/vpk.exe`, which is what catches
  a container the engine's tools read differently than we do.
- `node tools/verify/protodefs-write.mjs` asserts the proto_defs writer
  reproduces the shipped container byte for byte when nothing is spliced, then
  checks both splice modes through two independent decoders.
- `node tools/verify/protodef-json.mjs <dir>` resolves community JSON war paint
  definitions.
- `node tools/verify/vmt-parity.mjs` compares the browser VMT parser against
  the stock materials produced by the extraction pipeline.

## Credits

Team Fortress 2 and its weapon models, war-paint artwork, textures, effects, names, and other game assets are the property of Valve Corporation.

Parts of this project are based on reference material and implementations from the [Source SDK](https://github.com/valvesoftware/source-sdk-2013). Valve's published resources provided the basis for reproducing relevant TF2 material, lighting, pattern, and effect behavior.

This is an independent community project and is not affiliated with, sponsored by, or endorsed by Valve Corporation.

## License

The original source code in this repository is licensed under the [GNU General Public License v3.0](LICENSE).

This license does not apply to Team Fortress 2, the Source SDK, or any Valve-owned assets. Those materials remain subject to their respective terms and ownership.
