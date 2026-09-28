# Custom war paints

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
its extension. Nothing is uploaded anywhere. Imported package and definition
files, along with definition edits, are saved locally in the browser and
restored or offered for recovery after a reload.

**Clear workspace** in the panel header removes all of it in one step: the
imported archive, the imported definitions, every draft belonging to them, and
any replaced texture files. Viewer settings and drafts for built-in war paints
are kept. It asks for confirmation and names what it will delete first.
