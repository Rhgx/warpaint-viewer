# TF2 Warpaint Viewer

A 1:1 recreation of the Team Fortress 2 lighting engine in Three.js, presented as
an interactive viewer. **[Open the viewer](https://rhgx.github.io/warpaint-viewer/)**

## Features

- Browse war paints on every supported weapon, with wear, team, and seed.
- TF2 lighting environments, sheens, unusual effects, and a first-person view.
- Export transparent PNGs and animated turntables (GIF, WebP, APNG, MP4).
- Preview custom war paints from your own definitions and textures.

## Documentation

- [Using the viewer](docs/usage.md): controls, first person, and capture
- [Custom war paints](docs/custom-war-paints.md): importing and exporting paints
- [Development](docs/development.md): scripts, game data, and verification

## Development

Requires Node 22+.

```sh
npm install
npm run dev
```

## Support

If the viewer is useful to you, you can support its development:

<a href="https://boosty.to/rhgx/donate"><img src="docs/assets/boosty.svg" alt="" width="16" height="16"> <b>Support me on Boosty</b></a>

## Credits

Team Fortress 2 and its weapon models, war-paint artwork, textures, effects,
names, and other game assets are the property of Valve Corporation. Parts of
this project are based on the [Source SDK](https://github.com/valvesoftware/source-sdk-2013).
This is an independent community project and is not affiliated with, sponsored
by, or endorsed by Valve Corporation.

## License

The original source code is licensed under the [GNU General Public License v3.0](LICENSE).
It does not apply to Team Fortress 2, the Source SDK, or any Valve-owned assets,
which remain subject to their respective terms and ownership.
