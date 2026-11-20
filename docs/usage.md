# Using the viewer

Select a war paint, choose a supported weapon, and adjust its appearance in the
right sidebar.

On phones and tablets without a mouse or trackpad, the viewer runs without the
custom war paint workbench or Showcase Board.

## Catalog and search

The left sidebar lists every stock war paint grouped by collection, sorted from
newest to oldest by default. Click the sort button to switch between **Newest**
and **Oldest**, or append `?sortdesc=0` to the URL to open oldest first
(`?sortdesc=1` forces newest first).

Use the view toggle to switch between **List** and **Grid** views. Search
matches war paint names and collections while ignoring punctuation and accent
marks (for example, `high rollers` matches `High Roller's`, and `uber` matches
`Übersaw` in weapon pickers).

## Camera controls

| Action       | Touch            | Result                          |
| ------------ | ---------------- | ------------------------------- |
| Drag         | Drag             | Rotate the weapon               |
| Scroll       | Pinch            | Zoom in or out                  |
|              | Two-finger twist | Roll the weapon                 |
| Right-drag   | Two-finger drag  | Move the weapon within the view |
| Double-click | Double-tap       | Reset the view                  |
| `Alt`        |                  | Toggle Advanced Camera          |

Preset angles, projection options, and field-of-view settings are under
**Camera**.

Advanced Camera provides bounded free-flight controls inspired by TF2's roaming
spectator camera. It needs a keyboard and mouse, so touch-only devices do not
offer it.

The toolbar's **Auto spin** button turns the weapon like TF2's inspect panel:
it stops while you drag and eases back in two seconds after you let go. It spins
at the same speed as animated exports, so it previews the turntable.

## Item, Finish, and Custom Lighting

- **Weapon, Wear, Team, and Seed** sit under **Item**. Team switches to BLU on
  any war paint whose BLU textures differ, as it does in game, whether or not
  its definition sets `has_team_textures` (and also stays selectable when the
  `Team Shine` sheen is active). The **Seed** control accepts any 64-bit decimal
  seed and includes **Randomize**, **Previous seed**, **Next seed**, and
  **Copy seed** actions.
- **Lighting, Sheen, Effect, and Stat Clock** sit under **Finish**.
  - **Lighting** chooses between TF2 map presets (`Inspect`, `Daylight`,
    `Overcast`, `Indoors`, `Night`, `Inspect (Legacy)`) and **Custom**. Selecting
    **Custom** opens a custom lighting rig editor where you can add, toggle,
    reposition, aim, color, and duplicate up to 8 lights directly around the
    weapon. Your custom rig is saved in browser storage.
  - **Stat Clock** attaches TF2's kill counter module to supported weapons with
    an editable kill count (`0` to `999999`) and RED/BLU team styling.

## Share links

As you change the war paint, weapon, wear, team, seed, sheen, unusual effect,
lighting preset, projection, field of view, or Stat Clock, the viewer encodes
the current selection into the URL fragment (`#v=...`). Copying the address bar
produces a shareable link, and pasting a `#v=` link into an already-open tab
updates the viewer immediately without reloading the page. Imported custom war
paints live only in memory and are excluded from share links.

## First Person

The sidebar's **Preview** section switches between Inspect and **First Person**.
First Person supports class selection for shared weapons, viewmodel FOV, stock
minimized offsets, a **Show Hands** toggle, and a **Spin Barrel** toggle on
weapons with a spinning barrel. The bar at the bottom of the stage plays the
viewmodel's animations: pick one, drag the scrubber to any point (or use the
Left and Right arrow keys on the scrubber to step one frame at a time), and
cycle the speed through 1x, 0.5x and 0.25x. Inspect, Backstab, and Reload on
weapons that load shell by shell, are a start, a loop and an end, with a tick on
the scrubber where each part begins and stripes on the part that repeats. With
**Loop** on they hold that part, as holding the key does in game; turn it off to
play the end and stop. Pausing, with the button or `Space`, holds the current
pose while sheen, unusual particles, and emissive materials continue animating.
The Holy Mackerel also has an optional **Fish Bone Physics** switch, on by
default; pausing freezes its current bend.

Paint, wear, seed, team, Stat Clock, lighting, effects, and PNG capture use the
current selection. Close visual editors before entering First Person. First
Person is not available for the War Paint item (`paintkit_tool`). Other
procedural weapon motion and animation autolayers are not included. On tall
portrait phone screens the viewer shows the full 4:3 viewmodel frame, centred in
the canvas and lifted above the Controls sheet while it is open. On a phone,
landscape (fullscreen) gives First Person the most room.

First-person assets load on demand. To refresh them from an extracted sibling
viewmodel-editor project, run `node tools/models/import-viewmodels.mjs`,
optionally passing the path to `tf-viewmodel-editor`. The imported subset covers
the stock warpaint-supported weapons and class arms; running the viewer needs
neither that project nor a local game install.

## Settings

The toolbar's **Settings** button holds the theme and the Workshopper Tools.

**Appearance** picks one of five themes: Default, Midnight, Graphite, Ember or
Gold. A theme recolors the interface and the viewer's background, and exported
images stay as they are.

The **Workshopper Tools** are all off by default:

- **Show Paint Kit Details** adds a details button to the selected, hovered, or
  focused war paint (in both List and Grid views) and beside the stage title:
  its `paintkit_proto_def_index`, the operation it uses and the other stock
  paints sharing it, and texture paths, bases, and features from Pyxell's TF2
  Warpaint Texture Directory.
- **Advanced Catalog Search** lets the warpaint filter match an exact paint kit
  ID (`400` or `#400`) and list every paint that uses an operation
  (`op:<name>`).
- **Showcase Board** (desktop only) adds a toolbar button that opens a 2D
  pegboard workspace for arranging multiple painted weapons and custom images
  into a single image.

## Showcase Board

When **Showcase Board** is enabled in Settings (or when a `.pegboard` file is
dropped onto the viewer), you can arrange weapons from the bottom tray or start
from built-in layouts (`Stock`, `Wears`, `RED and BLU`, and others). Each placed
weapon can be moved, scaled, rotated, flipped, posed via weapon handles, split
into detachable parts, given its own wear, team, seed, or Stat Clock, and
exported or copied as a high-resolution PNG.

Boards autosave locally, can be stored in three quick slots, and can be exported
and shared as `.pegboard` files (which also support drag-and-drop onto the
viewer or board).

## Capture

The **Capture** section chooses what the toolbar's save button produces.

**Image** saves a transparent PNG at the chosen size. Copy image puts the same
PNG on the clipboard.

**Animated** saves a full turn of TF2's inspect spin (30 degrees per second, a
12 second turn). Pick a format:

| Format | Transparency | Best for |
| ------ | ------------ | -------- |
| GIF    | On/off only  | Plays everywhere; 256 colors |
| WebP   | Soft         | Full color with soft edges, about the size of a GIF |
| APNG   | Soft         | Lossless archiving; large files |
| MP4    | None         | Smallest and sharpest; what chat apps and social sites embed |

Each format remembers its own size, frame rate, and (for WebP and MP4) quality,
and starts from defaults suited to it. The estimate under the settings warns
when a file will likely exceed Discord's 10 MB upload limit. Transparent GIFs
keep each edge pixel's own color, so they suit any background; glows can only be
on or off, so pick **Solid** with a matching color when the destination is known.

Captures show their progress and can be cancelled. Changing the item or view,
resizing the window, or switching camera mode stops a capture that is running.
Animated capture is available in Inspect only.
