# Using the viewer

Select a war paint, choose a supported weapon, and adjust its appearance in the
right sidebar.

## Camera controls

| Action       | Result                          |
| ------------ | ------------------------------- |
| Drag         | Rotate the weapon               |
| Scroll       | Zoom in or out                  |
| Right-drag   | Move the weapon within the view |
| Double-click | Reset the view                  |
| `Alt`        | Toggle Advanced Camera          |

Preset angles, projection options, and field-of-view settings are under
**Camera**.

Advanced Camera provides bounded free-flight controls inspired by TF2's roaming
spectator camera.

The toolbar's **Auto spin** button turns the weapon like TF2's inspect panel:
it stops while you drag and eases back in two seconds after you let go. It spins
at the same speed as animated exports, so it previews the turntable.

## First Person

The sidebar's **Preview** section switches between Inspect and **First Person**.
First Person supports class selection for shared weapons, idle/inspect
animations, viewmodel FOV, and stock minimized offsets. The play/pause button
beside Animation holds the current pose while sheen, unusual particles, and
emissive materials continue animating. The Holy Mackerel also has an optional
**Fish Bone Physics** switch, on by default; pausing freezes its current bend.
Paint, wear, seed, team, lighting, effects, and PNG capture use the current
selection. Close visual editors before entering First Person. Other procedural
weapon motion and animation autolayers are not included.

First-person assets load on demand. To refresh them from an extracted sibling
viewmodel-editor project, run `node tools/models/import-viewmodels.mjs`,
optionally passing the path to `tf-viewmodel-editor`. The imported subset covers
the stock warpaint-supported weapons and class arms; running the viewer needs
neither that project nor a local game install.

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
