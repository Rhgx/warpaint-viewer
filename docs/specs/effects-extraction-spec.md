# Spec: effect asset extraction upgrades

Scope: tools/ only (plus regenerated files under public/data/effects/). Do not touch src/.

## Background

The unusual-effect runtime is being rewritten for Source-SDK parity. It needs two things the
current extraction does not provide, and one material is missing.

## Deliverable 1: attachment orientations in attachments.json

File: tools/extract-attachments.mjs

Current output shape (per weapon): `{ "unusual_0": [x, y, z], ... }`.

New output shape (format v2, single consumer is src/viewer/effects.ts which is being updated in
parallel against this exact contract):

```json
{
  "<weaponKey>": {
    "unusual_0": { "pos": [x, y, z], "quat": [qx, qy, qz, qw] },
    ...
    "muzzle": { "pos": [x, y, z], "quat": [qx, qy, qz, qw] }
  }
}
```

- `pos` is exactly the value currently emitted (same transform path, same rounding).
- `quat` is the attachment's local orientation frame expressed in the SAME glb/geometry frame as
  `pos`, as a unit quaternion, rounded to 1e-5 like positions.
- Derivation: the MDL attachment struct's `local` 3x4 matrix holds the attachment frame relative
  to its bone (columns 0..2 of rows are the rotation basis; translation is indices 3, 7, 11,
  already used today). Object-space rotation = boneWorld(3x3) * attachmentLocal(3x3), where
  boneWorld = invertAffine3x4(bone.poseToBone) as used for positions.
- Then re-express in glb space. `rootFrameTransforms(mdl)` currently exposes a `pos` transform.
  Add (or reuse if present) a way to transform direction vectors: transform each rotation basis
  column as a direction (transform point minus transform of origin, or expose the linear part
  directly from rootFrameTransforms in tools/models/lib/mdl.mjs). Build the 3x3 from the three
  transformed columns, orthonormalize, convert to quaternion.
- Convention check that MUST hold and MUST be verified in the validation step: for
  c_rocketlauncher's `unusual_1`, the attachment local +X axis (Source "forward") mapped through
  the transform should point roughly along glb +Z or -Z (the weapon's long axis), i.e.
  abs(dot(mappedX, (0,0,1))) > 0.7. Log the mapped basis for c_rocketlauncher unusual_1 and
  muzzle in the validation output.

Keep the bbox validation. Extend `validateAgainstGLB` to accept the new entry shape.

## Deliverable 2: missing material effects/workshop/water_unusual/circle_half.vmt

File: tools/extract-effects.mjs (and tools/lib/vpk.mjs if new VPKs are added)

`weapon_unusual_cool`'s water swirl system (`weapon_unusual_water_*_swirls`) references material
`effects/workshop/water_unusual/circle_half.vmt`. It is the only referenced material missing from
public/data/effects/particles/index.json. A substring search for "circle_half" and
"water_unusual" over the current four VPK listings (tf2_misc, tf2_textures, hl2_misc,
hl2_textures) found nothing, so it lives somewhere else. Investigate in this order:

1. Loose files under `C:/Program Files (x86)/Steam/steamapps/common/Team Fortress 2/tf/`
   (materials/ on disk, tf/download/, tf/custom/).
2. Other VPKs in the TF2 install (`tf/*.vpk`, `platform/*.vpk`, `hl2/*.vpk`). List each VPK's
   contents and grep for `circle_half` and `water_unusual`.
3. The path may differ from the VMT reference. Also search for just `workshop.*circle` and
   `unusual.*circle` patterns.

When found, make resolveMaterialToVtf able to resolve it (add the containing VPK or a loose-file
source to the search list; loose files can be read directly instead of extractBatch). If it truly
cannot be found anywhere in the install, report that clearly in your final summary and add a
fallback index entry pointing at effects/circle2's texture with a comment in the extractor, but
do not silently skip it.

## Deliverable 3: VTF sprite sheet coverage check

extract-effects.mjs already parses VTF sheet resources (parseVTFSpriteSheet) but the current
index.json has no `sheet` entries at all. In Source, `particle/smokesprites_0001` is a classic
multi-sequence sheet texture. Verify whether these VTFs actually carry sheet resources:

- If parseVTFSpriteSheet (tools/lib/vtf.mjs) has a bug (wrong resource tag, wrong offset,
  bails on valid data), fix it and regenerate.
- If the VTFs genuinely have no sheet resource, note that in the summary and move on. Do not
  fabricate sheet data.

## Deliverable 4: regenerate

Run `node tools/extract-effects.mjs` and confirm:
- attachments.json is v2 shape for all 45 weapons, bbox validation passes, basis check passes.
- index.json gains `effects/workshop/water_unusual/circle_half.vmt` (or the documented fallback).
- unusuals.json unchanged apart from ordering noise (it should be byte-identical; do not change
  the PCF parsing).

## Constraints

- Never use em dashes or en dashes anywhere (code, comments, docs, commit messages). Use commas,
  colons, parentheses, or regular hyphens.
- Do not commit; leave changes in the working tree.
- Do not modify src/.
- TF2 install root: C:/Program Files (x86)/Steam/steamapps/common/Team Fortress 2
