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

## Credits

Team Fortress 2 and its weapon models, war-paint artwork, textures, effects, names, and other game assets are the property of Valve Corporation.

Parts of this project are based on reference material and implementations from the [Source SDK](https://github.com/valvesoftware/source-sdk-2013). Valve's published resources provided the basis for reproducing relevant TF2 material, lighting, pattern, and effect behavior.

This is an independent community project and is not affiliated with, sponsored by, or endorsed by Valve Corporation.

## License

The original source code in this repository is licensed under the [GNU General Public License v3.0](LICENSE).

This license does not apply to Team Fortress 2, the Source SDK, or any Valve-owned assets. Those materials remain subject to their respective terms and ownership.
