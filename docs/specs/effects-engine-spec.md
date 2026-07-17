# Spec: SDK-faithful unusual particle engine

Scope: src/viewer/effects.ts and src/viewer/Viewer.ts only. Keep every existing export name and
the sheen code untouched. tools/ is being changed in parallel by another task; do not touch it.

Ground truth is the Source SDK (CEconEntity::UpdateSingleParticleSystem wiring, the particle
operator semantics below) and the extracted PCF data in public/data/effects/unusuals.json. The
goal is 1:1 visual parity with TF2's in-game weapon unusual effects (hot, isotope, cool,
energy orb) in the inspect view.

## Verified diagnoses this rewrite must fix

1. Additive sprites black-box the CSS backplate. The particle material writes tex.a (255
   everywhere on additive textures like effects/comball_d, sc_hardglow, circle2, fire_embers1)
   into the framebuffer; THREE.AdditiveBlending accumulates destination alpha so the sprite quad
   occludes the backplate that sits behind the transparent canvas.
2. Energy orb ignores distance_bias and control point local frames, so it puffs uniformly
   instead of streaming along the barrel from CP1 (unusual_1, front) as in game.
3. Cool is missing the ops that drive its water chain (Set child control points from particle
   positions, Movement Maintain Position Along Path, Movement Lock to Control Point,
   Movement Rotate Particle Around Axis), so it degrades into isotope-looking rings and dots.
4. Effects are parented to centerGroup and rotate rigidly with the model. In game, particles
   simulate in world space while control points follow attachments (PATTACH_POINT_FOLLOW).

## Architecture

### Control points

- In game (items_game 701-704 + CEconEntity::UpdateSingleParticleSystem): CP0 follows attachment
  unusual_0, CP1..CP5 follow unusual_1..unusual_5. All six follow the weapon.
- attachments.json is moving to a v2 shape (produced by a parallel task; code against this
  contract, and if at runtime a value is still a plain [x,y,z] array treat it as pos with
  identity quat so the app keeps working with stale data):

```json
{ "<weaponKey>": { "unusual_0": { "pos": [x,y,z], "quat": [qx,qy,qz,qw] }, ... } }
```

  pos/quat are in geometry (glb, uncentered) space. quat maps attachment-local axes into
  geometry space, where attachment-local uses the SOURCE convention: +X forward (along barrel),
  +Y left, +Z up. So a Source CP-local vector v is taken to geometry space by quat * v with NO
  extra swizzle. Replace the current mapAttachmentLocal swizzle with this everywhere a CP-local
  quantity is used; when an attachment has no quat (fallback array shape), use the current
  swizzle (x,y,z)->(-y,z,x) as the identity-frame approximation.
- Each effect instance owns one shared CP table (Source children inherit parent CPs), CP index
  0..5 anchored to attachments, with a per-system override layer (a Map<systemName,
  Map<cpIndex, dynamicCp>>) written by "Set child control points from particle positions".
- Every frame the Viewer passes the current centerGroup.matrixWorld. Effects convert each
  anchored CP: worldPos = anchorPos applied through the matrix, worldQuat = matrix rotation *
  anchorQuat. Keep the previous frame's worldPos/worldQuat per CP to derive per-frame deltas and
  velocity ((pos - prevPos)/dt). Missing attachment names fall back to unusual_0, then the model
  center (current behavior).

### World-space simulation

- All particle state lives in WORLD (scene) space. The effect's THREE object is added to the
  scene root by the Viewer (see Viewer wiring), not to centerGroup.
- System tree: instantiate the selected weapon system and its children as a tree (keep
  parent/child links; a system with renderers gets a Points mesh; container systems still tick
  their operators so Set child control points works). Keep selectSystemName and the
  weapon-key logic exactly as is.

### Particle state (per particle)

pos (Vector3, world), vel (Vector3), age, lifetime, creationSystemAge (system age at spawn),
baseRadius, rotationDeg, rotationSpeedDegPerSec, alphaBase, color (THREE.Color), spawnIndex
(monotonic per system), sequence (int), dead flag. Slot arrays sized
min(max_particles, 512).

## Operator semantics (implement exactly; order of the PCF lists matters, run initializers in
list order at spawn, operators in list order each tick)

Notation: u = fresh uniform random [0,1], lerpExp(a,b,e) = a + (b-a)*pow(u,e).

### Initializers

- Position Within Sphere Random: d = random point in unit ball, normalized to a direction.
  For each component i: if distance_bias_absolute_value[i] != 0, d[i] = abs(d[i]);
  d[i] *= distance_bias[i]. Renormalize d (guard zero). dist = lerpExp(distance_min,
  distance_max, speed... use its own exponent param if present, else 1).
  If "bias in local system": dWorld = cpQuat * d, else dWorld = swizzleSourceWorld(d) where
  swizzleSourceWorld maps Source world (x,y,z) to scene (x,z,y) like the existing gravity
  mapping. pos = cp.worldPos + dWorld * dist.
  vel = dWorld * lerpExp(speed_min, speed_max, speed_random_exponent)
      + cpQuat * randVec(speed_in_local_coordinate_system_min, speed_in_local_coordinate_system_max)
  where randVec lerps each component independently.
- Position Modify Offset Random: o = per-component random between offset_min and offset_max;
  if "offset in local space 0/1" is truthy, o = cpQuat(control_point_number) * o, else
  o = swizzleSourceWorld(o). pos += o.
- Lifetime Random: lifetime = lerpExp(lifetime_min, lifetime_max, lifetime_random_exponent).
- Alpha Random: alphaBase = lerpExp(alpha_min, alpha_max, alpha_random_exponent) / 255.
- Radius Random: baseRadius = lerpExp(radius_min, radius_max, radius_random_exponent).
- Color Random: one u for the whole particle; color = lerp(color1, color2, u) per channel in
  the 0..255 sRGB values, converted like the current colorFromArray.
- Rotation Random ("rotation_initial", "rotation_offset_min/max", "rotation_random_exponent"):
  rotationDeg = rotation_initial + lerpExp(offset_min, offset_max, exp).
- Rotation Yaw Random: yaw attribute; screen-aligned sprites do not use yaw. Ignore, but leave a
  comment saying so.
- Rotation Yaw Flip Random ("flip percentage" p, default 0.5): with probability p add 180 to
  rotationDeg (visual approximation of the yaw flip; comment it).
- Sequence Random: if the material's index entry has sheet sequences, pick a uniform integer in
  [sequence_min, sequence_max] clamped to the available range and store it; otherwise ignore.
- remap initial scalar: only the (input field 8 = CREATION_TIME -> output field 4 = ROTATION)
  form appears in these files. value = clamp/remap of creationSystemAge (seconds since the
  effect instance was created) from [input minimum, input maximum] to [output minimum, output
  maximum]; rotationDeg += value (values are degrees). If "output is scalar of initial random
  range" is set, multiply instead of add. Ignore other field combinations but log-once a
  console.warn naming the unhandled fields.
- Velocity Noise: approximate. Treat "output minimum"/"output maximum" vectors as a per-particle
  random velocity add in the CP local frame if "apply initial velocity in cp space" (or similarly
  named local flag) is set, else Source world. Comment that this approximates the SDK's curl
  noise sampling.
- Velocity Inherit from Control Point ("control point number", "velocity scale" or "scale"):
  vel += cpVelocity(worldspace, tracked per frame) * scale.
- Velocity Random: like the speed part of Position Within Sphere Random: random direction times
  lerpExp(speed_min, speed_max) plus local-coordinate speed box, same frame rules.

### Operators

- Movement Basic: vel += swizzleSourceWorld(gravity) * dt; vel *= pow(max(0, 1 - drag), dt*30)
  (keep the existing 30 Hz reference comment); pos += vel * dt.
- Lifespan Decay: kill when age >= lifetime.
- Alpha Fade and Decay (FadeAndKill): times are ABSOLUTE seconds of particle age.
  scale = start_alpha before start_fade_in_time; lerp(start_alpha, 1) across
  [start_fade_in_time, end_fade_in_time]; 1 until start_fade_out_time; lerp(1, end_alpha)
  across [start_fade_out_time, end_fade_out_time]; KILL the particle at age >=
  end_fade_out_time. Multiplies into the frame alpha. Note: for energy orb this makes real
  lifespan 3.0s while the lifetime attribute stays 2.1 for proportional ops; that is correct.
- Alpha Fade In Random: t = random(fade in time min, fade in time max) chosen per particle at
  spawn (store it); if "proportional 0/1" (default 1) t is a fraction of lifetime, else seconds.
  scale = clamp(age / T, 0, 1) where T = proportional ? t*lifetime : t. Apply ease_in_and_out /
  fade bias if params present via smoothstep (approximation, comment it).
- Alpha Fade Out Random: t as above; fade starts at (lifetime - T) and scales alpha linearly to
  0 at lifetime (smoothstep when "ease in and out"). T = proportional ? t*lifetime : t.
- Radius Scale (InterpolateRadius): f = clamp((lifeFrac - start_time)/(end_time - start_time)).
  If scale_bias != 0.5 apply Bias(f, b) = f / ((1/b - 2)*(1 - f) + 1). If ease_in_and_out,
  SimpleSpline (smoothstep). radius = baseRadius * lerp(radius_start_scale, radius_end_scale, f).
- Color Fade: fade_start_time/fade_end_time are fractions of lifetime. f = clamp((lifeFrac -
  start)/(end - start)), smoothstep if ease_in_and_out; color = lerp(initialColor, color_fade, f).
- Rotation Spin Roll (Spin): rotationDeg += spin_rate_degrees * dt, with the rate decaying to
  spin_rate_min by spin_stop_time seconds of age when spin_stop_time > 0.
- Movement Lock to Control Point (PositionLock, THE op that makes effects follow the weapon):
  per tick compute the CP's world-space delta since last tick: dPos = cp.worldPos -
  cp.prevWorldPos and dQuat = cp.worldQuat * cp.prevWorldQuat^-1. Strength s: 1 while age <
  startFade, linear to 0 at endFade, where startFade = random(start_fadeout_min,
  start_fadeout_max) * lifetime and endFade = random(end_fadeout_min, end_fadeout_max) *
  lifetime, both chosen at spawn; if endFade <= startFade treat the lock as permanent (s = 1).
  Apply: if "lock rotation": target = cp.worldPos + dQuat * (pos - cp.prevWorldPos); else
  target = pos + dPos. pos = lerp(pos, target, s). Also rotate vel by dQuat scaled by s when
  lock rotation is set (approximation, comment it).
- Movement Rotate Particle Around Axis: axis = "Use Local Space" ? cpQuat * axisParam :
  swizzleSourceWorld(axisParam); rotate (pos - cp.worldPos) around axis through cp.worldPos by
  RotationRate degrees/sec * dt.
- Oscillate Vector: approximate as sinusoidal jitter on the target field (only velocity/position
  appear here): add sin(2*pi*freq*(age + phase(particleId))) * rate * dt along each enabled
  axis, with rate/freq randomized per particle between min/max params, respecting
  "oscillation multiplier" and start/end time windows when present. Comment as approximation.
- Movement Maintain Position Along Path (MaintainSequentialPath): path from CP "start control
  point number" to CP "end control point number". N = "particles to map from start to end".
  Each spawned particle gets tPath = (spawnIndex % N) / max(1, N) plus loop behavior: with
  "restart behavior" true, the mapping loops. Each tick: pathPos = lerp(startCp.worldPos,
  endCp.worldPos, tPath) (bulge is 0 in these files; ignore bulge but read mid point position
  0.5 as plain lerp). pos = lerp(pos, pathPos, cohesion strength). This op sets position
  directly; run it after Movement Basic like the PCF order says.
- Set Control Point Positions: sets CPs to fixed offsets; only 20 uses. Read params
  ("first/second/third/fourth control point number/location/parent") and write static CP
  overrides relative to CP0 in its local frame. If params do not match that shape, warn-once
  and skip.
- Set child control points from particle positions: after this system ticks, take its first
  "# of control points to set" live particles starting at "first particle to copy" and write
  their world positions into the CHILD systems' CP override slots starting at "First control
  point to set". This is what carries cool's pos_control -> postest -> swirls chain.

### Emitters

- emit_continuously: accumulate emission_rate * dt, spawn into free slots, capped by
  max_particles. Honor emission_duration > 0 (stop after that much system age) and
  emission_start_time.
- emit_instantaneously: spawn num_to_emit once at system start.
- Remove the current "respawn at end of lifetime" hack; death comes only from kill ops
  (Lifespan Decay / FadeAndKill). If a system has emitters but no kill op at all, keep particles
  alive for lifetime and then kill (sane fallback), warn-once.

## Rendering

- Keep THREE.Points + custom shaders. Add an aRotation attribute (radians); in the fragment
  shader rotate gl_PointCoord around (0.5, 0.5) by it before the frame lookup.
- Blending fix (issue 1): additive materials use CustomBlending with blendSrc SrcAlphaFactor,
  blendDst OneFactor, blendSrcAlpha ZeroFactor, blendDstAlpha OneFactor (RGB adds like Source's
  SRC_ALPHA/ONE, destination alpha untouched so the CSS backplate stays visible). Non-additive
  materials keep NormalBlending. Depth: keep depthWrite false, depthTest true.
- Frames: keep the existing strip animation (one playthrough per lifetime) for multi-frame
  textures without sheet data. If index.json provides sheet sequences (the extraction task may
  add them), sample the stored sequence's frames over the particle lifetime using per-frame uv
  rects; guard so missing sheet data falls back to the strip path.
- Keep the point-scale uniform mechanism (setParticlePointScale) unchanged.
- Keep the safeRadius spawn clamp (relative to the control point) as a sanity guard.

## Viewer wiring (src/viewer/Viewer.ts)

- rebuildUnusualEffect: add effect.object to this.scene instead of centerGroup (remove from
  scene in dispose paths). Update the comment: effects simulate in world space; control points
  are re-anchored every frame from centerGroup.matrixWorld.
- In the render loop, before activeUnusual.update(dt): call
  this.centerGroup.updateWorldMatrix(true, false) and pass the matrix, e.g.
  activeUnusual.updateAnchor(this.centerGroup.matrixWorld) then activeUnusual.update(dt).
  Extend the UnusualEffect interface accordingly (updateAnchor(matrix: THREE.Matrix4): void).
- createUnusualEffect signature stays (id, radius, weaponKey, modelCenter); modelCenter is still
  the geometry-space fallback CP.

## Acceptance checks (do all before finishing)

1. `npm run build` passes (tsc + vite).
2. `npm run lint` passes.
3. Add a small headless sanity harness (a plain node script is fine, e.g.
   scripts/dev/effects-sim-check.mjs, or run logic via vite-node if available; if TS imports are
   awkward, factor the pure sim core so it is importable) that instantiates each of the four
   effects for c_rocketlauncher with mocked fetch data loaded from public/data/effects/*.json,
   steps 5 simulated seconds at 60 Hz, and asserts:
   - energy orb: >= 30 live particles, mean |offset along glb Z from unusual_1| > mean |offset
     along glb X| (stream hugs the barrel axis, does not balloon sideways);
   - cool: the swirl system has live particles positioned between its path CPs, and no system
     is stuck at zero live particles (except containers without renderers);
   - all four: no NaN positions, no particle further than 5x model radius from its CP.
   Wire nothing into package.json scripts unless trivial; running it with node directly is fine.
4. Manually reason through one full frame for weapon_unusual_energyorb_rocketlauncher and write
   the expected behavior as a comment block at the top of the energy-orb-relevant op (Position
   Within Sphere Random) implementation.

## Constraints

- Never use em dashes or en dashes anywhere (code, comments, docs). Use commas, colons,
  parentheses, or regular hyphens.
- Do not commit; leave changes in the working tree.
- Do not touch tools/, public/data (except reading), src/ui, or the sheen sections of
  effects.ts.
- Keep the existing module-level fetch caches and the lazy population pattern of
  createUnusualEffect (returns immediately, populates async).
- Match the file's existing comment density and style: comments explain Source-side rationale
  (which SDK op/behavior a block ports), not what the next line does.
