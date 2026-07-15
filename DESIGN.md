# TF2 Warpaint Viewer - Design Document

A Vite web app that lets the user browse every warpaint (paint kit) in Team Fortress 2 and preview
how it looks on each weapon it supports, under different lighting conditions, at different wear
levels, for both teams, and with different pattern seeds.

## Source data locations (this machine)

- TF2 install: `C:\Program Files (x86)\Steam\steamapps\common\Team Fortress 2`
  - `tf\scripts\protodefs\proto_defs.vpd` - ALL paintkit definitions, binary protobuf container
  - `tf\scripts\items\items_game.txt` - item schema (KeyValues text)
  - `tf\resource\tf_proto_obj_defs_english.txt` - localization for warpaint names (UCS-2 LE KeyValues)
  - `tf\resource\tf_english.txt` - general localization (weapon names)
  - `tf\tf2_misc_dir.vpk` - models (`models/weapons/c_models/**`), VMT materials
  - `tf\tf2_textures_dir.vpk` - VTF textures: patterns at `materials/patterns/**`,
    weapon composite inputs at `materials/models/workshop/weapons/**`
  - `bin\vpk.exe` - Valve's VPK tool. Usage: `vpk.exe l <dir.vpk>` lists, `vpk.exe x <dir.vpk> <relpath>` extracts
    (extracts into cwd preserving relative path). Extract in batches; it accepts multiple file args.
- TF2 SDK source: `C:\Users\TR\Desktop\projects\tf2\source-sdk-2013`
  - `src\game\shared\tf\tf_proto_def_messages.proto` - protobuf schema for proto_defs.vpd
    (self-contained except google/protobuf/descriptor.proto; uses proto2 syntax and custom options)
  - `src\game\shared\econ\econ_paintkit.cpp` - how paintkit defs resolve to compositor KV stage trees
    (see `CPaintKitDefinition::GetItemPaintKitDefinitionKV` and helpers)
  - `src\public\materialsystem\combineoperations.h` - combine op enum
  - `src\materialsystem\stdshaders\compositor.cpp` + `compositor_ps2x.fxc` - the GPU combine shaders
    (exact blend math for Multiply, Add, Lerp, Select, Blend)
  - `src\game\client\tf\vgui\tf_item_inspection_panel.cpp` - in-game inspect view (lighting reference)
  - `src\game\shared\econ\econ_item_view.cpp` - how seed/wear/team feed the compositor at runtime

## proto_defs.vpd container format

Little-endian. Repeated blocks until EOF:

```
int32 defType        // ProtoDefTypes enum from the .proto (9=variables, 10=operation, 11=paintkit item def, 12=paintkit def)
int32 numDefs
repeat numDefs times:
    int32 size
    byte[size]       // serialized protobuf message of that type, e.g. CMsgPaintKit_Definition
```

Each message has a `header` field (`CMsgProtoDefHeader`) with `defindex`, `name`, etc.

## Repo layout and module ownership

```
warpaint-viewer/
  DESIGN.md              (this file)
  tools/                 <- OWNED BY: pipeline agent (task 2)
    extract.mjs          entry point: node tools/extract.mjs [--only step]
    lib/                 vpd/kv/vtf/localization helpers
    proto/               copy of tf_proto_def_messages.proto (trimmed of custom options if needed)
  tools/models/          <- OWNED BY: model converter agent (task 3)
    mdl2gltf.mjs         entry point: node tools/models/mdl2gltf.mjs <mdlPath...> --out <dir>
    lib/                 mdl/vvd/vtx parsers, glb writer
  public/data/           generated output, gitignored, consumed by the app at runtime
  src/                   <- OWNED BY: app agent (task 4)
    main.tsx, App.tsx
    compositor/          WebGL paintkit compositor
    viewer/              three.js scene + lighting presets
    ui/                  Base UI based components
    data/                typed loaders for the manifest (types below)
  staging/               scratch dir for raw extracted vpk files, gitignored
```

Do not edit files outside your owned directories, except: the app agent may edit `index.html`,
`src/**`, and add npm deps; pipeline agents may add npm deps. All deps are already installed:
react, react-dom, @base-ui/react (v1.6, package name is `@base-ui/react` NOT @base-ui-components),
three, @types/three, protobufjs, vite, typescript.

## Data contract (public/data)

### `public/data/manifest.json`

```jsonc
{
  "generatedAt": "ISO date",
  "paintkits": [
    {
      "id": 290,                       // paintkit defindex
      "name": "Civic Duty Mk.II",     // resolved localized name
      "collection": "...",             // if derivable from items_game, else null
      "hasTeamTextures": true,
      "weapons": ["c_shotgun", "c_flamethrower"]   // weapon keys this kit can render on
    }
  ],
  "weapons": [
    {
      "key": "c_shotgun",             // canonical key: model file stem
      "name": "Shotgun",              // localized
      "model": "models/c_shotgun.glb",// relative to public/data/
      "material": {                    // render params from the weapon's paintkit VMT
        "phongExponent": 10, "phongBoost": 1, "envmapTint": [r,g,b],
        "normalMap": "textures/models/workshop/weapons/.../c_shotgun_normal.png" // or null
      }
    }
  ],
  "wearLevels": [0.2, 0.4, 0.6, 0.8, 1.0],
  "wearNames": ["Factory New", "Minimal Wear", "Field-Tested", "Well-Worn", "Battle Scarred"]
}
```

### `public/data/recipes/<paintkitId>/<weaponKey>_<team>.json`

One resolved compositor stage tree per (paintkit, weapon, team). team is `red` or `blu`
(emit only `red` when `hasTeamTextures` is false, and app falls back red -> blu).
This is the output of porting `GetItemPaintKitDefinitionKV`: the operation template with all
variables substituted. JSON mirrors the proto stage structure with these node shapes:

```jsonc
// A node is exactly one of:
{ "type": "texture_lookup", "texture": "textures/patterns/yeti/macaw_feathers_base.png",
  "adjustBlack": [0,0], "adjustOffset": [1,1], "adjustGamma": [1,1],   // ranges [min,max] resolved from seed at runtime
  "rotation": [0,360], "translateU": [0,1], "translateV": [0,1],
  "scaleUV": [1,1], "allowFlip": false }
{ "type": "combine_multiply" | "combine_add" | "combine_lerp", "nodes": [ ...2 or 3 children ] }
{ "type": "select", "groups": "textures/.../groups.png", "select": [ ... ], "nodes": [ child ] }
{ "type": "apply_sticker", "stickers": [ { "base": "png path", "weight": 1.0 } ], "destBl": [u,v], ... , "nodes": [ child ] }
```

Field names/semantics follow `CMsgPaintKit_Operation_*Stage` in the .proto; keep every field the
proto carries (the app resolves seeded randoms at runtime from [min,max] ranges). If the pipeline
finds fields not listed above, INCLUDE them with proto field names converted to camelCase and
update this file. Wear: the operation trees reference wear via variables/texture choices; if the
resolved tree differs per wear level, emit `<weaponKey>_<team>_w<0..4>.json` instead and set
`"perWear": true` on the paintkit manifest entry.

### Textures

`public/data/textures/<original vpk path with .vtf -> .png>`. Decode VTF (DXT1, DXT5, BGRA8888,
BGR888, RGBA8888, I8, IA88 cover TF2 content; error loudly on others) taking the largest mip.

### Models

`public/data/models/<weaponKey>.glb`. Requirements: positions, normals, UV0, indices; single mesh
or one primitive per material; embed no textures (app applies composited texture); Y-up; real-world
scale consistent across weapons (Source units are fine, app frames camera by bounding box). Include
LOD0 only. Skins/bodygroups: bodygroup 0, skin 0 geometry only.

## Runtime parameters (resolved in the app, not the pipeline)

- **seed**: uint32. Drives resolution of every [min,max] range in texture_lookup stages via a
  deterministic PRNG. Research the exact in-game RNG (community docs / leaked compositor knowledge);
  if unknown, use a documented approximation (mulberry32 walked in stage traversal order) and note it.
- **wear**: index 0..4 -> float 0.2..1.0 (see manifest).
- **team**: red / blu -> picks recipe file.
- **lighting preset**: app-side three.js setups. Include at least: "Inspect (itemtest)" modeled on
  tf_item_inspection_panel.cpp, "Daylight (Badlands)", "Overcast (Sawmill)", "Indoors (2fort intel)",
  "Night (Halloween)". Simple ambient+directional(+rim) approximations are acceptable; flat UI slider
  for exposure is a plus.

## UI (Base UI, simple and flat)

- Left: scrollable warpaint list with text filter and collection grouping. No thumbnails needed for v1
  (name list is fine); thumbnails can come later from the compositor itself.
- Center: large three.js canvas, orbit controls.
- Right/bottom bar: weapon select, wear select, team toggle, seed input + randomize button,
  lighting preset select.
- Flat styling: system font, 1px borders, no shadows/gradients/rounded corners beyond 2-4px, dark
  and light via prefers-color-scheme. Plain CSS (CSS modules or a single stylesheet). No Tailwind,
  no CSS-in-JS.

## Notes and known risks

- The compositor engine (`ctexturecompositor.cpp`) is NOT in the SDK; only shaders and protos are.
  Blend math comes from `compositor_ps2x.fxc`. Stage-tree semantics come from the proto + econ_paintkit.cpp.
  Seeded RNG order is the main fidelity risk; get it as close as practical, expose seed in UI regardless.
- vpk.exe writes extracted files relative to cwd; run it from `staging/`.
- items_game.txt is ~4MB; parse with a streaming or fast KV parser, and cache parsed JSON in staging/.
- Localization files are UTF-16 LE with BOM.
- Never commit anything; this is not a git repository. Do not add AI attribution anywhere.

## Pipeline schema amendments

The extraction pipeline (tools/extract.mjs) added the following to the data contract, discovered
while porting econ_paintkit.cpp and the CMsgPaintKit_* messages:

- Recipe node `texture_lookup`: the proto has separate `flip_u` / `flip_v` bool fields, not a single
  `allowFlip`. Emitted as `"flipU": bool, "flipV": bool` (already seed-independent booleans).
- Recipe nodes `combine_multiply` / `combine_add` / `combine_lerp` carry the same transform fields
  the proto defines on CMsgPaintKit_Operation_CombineStage: `adjustBlack`, `adjustOffset`,
  `adjustGamma`, `rotation`, `translateU`, `translateV`, `scaleUV` (all [min,max]), plus `flipU`,
  `flipV`. Defaults when absent in the proto: black [0,0], offset [1,1], gamma [1,1], rotation
  [0,0], translate [0,0], scale [1,1].
- `select` nodes are LEAVES in the actual data (no `nodes` child array; the groups texture is the
  input). `select` values are numbers (0..255 group ids compared against the groups texture R
  channel). Range semantics per compositor: value matches when groupPixel*255 is within +-8.
- `apply_sticker` fields emitted: `stickers` [ { base, weight, spec? } ], `destTl`, `destTr`,
  `destBl` ([u,v] each), `adjustBlack`, `adjustOffset`, `adjustGamma`, `nodes` [1 child].
  `spec` is a texture path when the proto provides one (rare; most stickers omit it).
- Value pre-parsing (done by the pipeline, mirroring the KV parse comments in the proto):
  adjust_black and adjust_offset are divided by 255; adjust_gamma is inverted (1/x). So recipe
  values are already in shader-space; the app should NOT re-transform them.
- Every paintkit turned out to differ across wear levels (wear is baked into per-wear variable
  sets in CMsgPaintKit_ItemDefinition.definition[0..4]), so ALL kits emit
  `<weaponKey>_<team>_w<0..4>.json` and every manifest paintkit entry has `"perWear": true`.
- Manifest weapon `material` gained two extra fields from the VMTs: `"phong": bool and
  `"phongExponentFactor": number|null` (set when the VMT uses $phongexponentfactor with an
  exponent texture instead of a scalar $phongexponent; treat null phongExponent + factor as
  "use factor as approximate exponent scale"). No TF2 paintkit weapon base VMT carries $bumpmap,
  so `normalMap` is null for all 45 weapons.
- Manifest paintkit `collection` is the LOCALIZED collection display name (e.g. "Concealed Killer
  Collection") derived from items_game.txt `item_collections`: each collection's item names are
  matched to item defs by `name`, and the item def's `static_attrs`/`attributes`
  `paintkit_proto_def_index` links it to the paintkit. Reference/master collections
  (`is_reference_collection`) are skipped; a kit in multiple collections keeps the first; kits in
  no collection stay null.
