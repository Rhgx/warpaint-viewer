import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { Compositor } from '../compositor';
import type { RecipeNode } from '../compositor/types';
import { createUnusualEffect } from '../viewer/particles';

// /?selftest=1 - composites known recipes offscreen and asserts the compositor's
// pixel math against reference values computed here in JS with the same sRGB and
// combine formulas as compositor_ps2x.fxc. Reports PASS/FAIL to the console, the
// document title, and the DOM.

function srgb2lin(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function lin2srgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
// Reference AdjustLevels (fxc: sRGB-space Photoshop levels).
function adjustLevels(lin: number, black: number, white: number, gamma: number): number {
  if (black === 0 && white === 1 && gamma === 1) return lin;
  const s = lin2srgb(lin);
  const pcg = white === black ? (s > black ? 1 : 0) : Math.min(1, Math.max(0, (s - black) / (white - black)));
  return Math.min(1, Math.max(0, srgb2lin(Math.pow(pcg, gamma))));
}

// A solid RGBA PNG data URL with the given 0..255 channel bytes.
function solid(r: number, g: number, b: number, a = 255): string {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 4;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = `rgba(${r},${g},${b},${a / 255})`;
  ctx.fillRect(0, 0, 4, 4);
  return c.toDataURL('image/png');
}

interface Case {
  name: string;
  recipe: RecipeNode;
  // (px,py) in 0..1, expected linear rgb, tolerance
  sample: [number, number];
  expected: [number, number, number];
  tol: number;
}

function buildCases(): { cases: Case[]; texMap: Record<string, string> } {
  // byte values
  const A = 200,
    B = 150,
    SEL = 188;
  const linA = srgb2lin(A / 255);
  const linB = srgb2lin(B / 255);
  const linSel = srgb2lin(SEL / 255);

  const texA = solid(A, A, A);
  const texB = solid(B, B, B);
  const texSel = solid(SEL, SEL, SEL);
  // groups map sampled raw (no sRGB decode): solid group id byte 16.
  const groupsUniform16 = solid(16, 16, 16);

  const lookupA: RecipeNode = { type: 'texture_lookup', texture: 'A' };
  const lookupB: RecipeNode = { type: 'texture_lookup', texture: 'B' };
  const lookupSel: RecipeNode = { type: 'texture_lookup', texture: 'SEL' };

  // Combine output adjust for the post-pass case (min == max so the value is
  // seed-independent).
  const combineGamma = 1.5;

  const cases: Case[] = [
    {
      name: 'Multiply  (c0 * c1)',
      recipe: { type: 'combine_multiply', nodes: [lookupA, lookupB] },
      sample: [0.5, 0.5],
      expected: [linA * linB, linA * linB, linA * linB],
      tol: 0.02,
    },
    {
      name: 'Multiply n-ary  (c0 * c1 * c2)',
      recipe: { type: 'combine_multiply', nodes: [lookupA, lookupB, lookupSel] },
      sample: [0.5, 0.5],
      expected: [linA * linB * linSel, linA * linB * linSel, linA * linB * linSel],
      tol: 0.02,
    },
    {
      name: 'Add  (c0 + c1)',
      recipe: { type: 'combine_add', nodes: [lookupA, lookupB] },
      sample: [0.5, 0.5],
      expected: [linA + linB, linA + linB, linA + linB],
      tol: 0.02,
    },
    {
      name: 'Lerp  mix(c0, c1, sel.x)',
      recipe: { type: 'combine_lerp', nodes: [lookupA, lookupB, lookupSel] },
      sample: [0.5, 0.5],
      expected: [
        linA + (linB - linA) * linSel,
        linA + (linB - linA) * linSel,
        linA + (linB - linA) * linSel,
      ],
      tol: 0.02,
    },
    {
      name: 'Select leaf  group id 16 matches [16] -> white',
      recipe: { type: 'select', groups: 'G16', select: [16] },
      sample: [0.5, 0.5],
      expected: [1, 1, 1],
      tol: 0.01,
    },
    {
      name: 'Select leaf  group id 16 vs [32] -> black',
      recipe: { type: 'select', groups: 'G16', select: [32] },
      sample: [0.5, 0.5],
      expected: [0, 0, 0],
      tol: 0.01,
    },
    {
      name: 'Combine output adjust  gamma on multiply result',
      recipe: {
        type: 'combine_multiply',
        adjustGamma: [combineGamma, combineGamma],
        nodes: [lookupA, lookupB],
      },
      sample: [0.5, 0.5],
      expected: (() => {
        const v = adjustLevels(linA * linB, 0, 1, combineGamma);
        return [v, v, v] as [number, number, number];
      })(),
      tol: 0.02,
    },
  ];

  const texMap: Record<string, string> = {
    A: texA,
    B: texB,
    SEL: texSel,
    G16: groupsUniform16,
  };
  return { cases, texMap };
}

interface Result {
  name: string;
  pass: boolean;
  got: [number, number, number];
  expected: [number, number, number];
}

// ---------------------------------------------------------------------------
// Unusual effect simulation checks: instantiate each of the four effects for
// c_rocketlauncher with an identity anchor (world space == geometry space),
// step 5 simulated seconds at 60 Hz, and assert population/shape invariants
// against the extracted attachment data.
// ---------------------------------------------------------------------------

interface PointsStats {
  name: string;
  alive: number;
  nan: number;
  mean: [number, number, number];
  livePoints: Array<[number, number, number]>;
  meanAbsOffset: (origin: [number, number, number]) => [number, number, number];
  maxDist: (origin: [number, number, number]) => number;
}

function collectPointsStats(group: THREE.Object3D): PointsStats[] {
  const out: PointsStats[] = [];
  group.traverse((o) => {
    const pts = o as THREE.Points;
    if (!pts.isPoints) return;
    const geo = pts.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const size = geo.getAttribute('aSize') as THREE.BufferAttribute;
    const live: Array<[number, number, number]> = [];
    let nan = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) { nan++; continue; }
      if (size.getX(i) > 0) live.push([x, y, z]);
    }
    const mean: [number, number, number] = [0, 0, 0];
    for (const p of live) { mean[0] += p[0]; mean[1] += p[1]; mean[2] += p[2]; }
    if (live.length) { mean[0] /= live.length; mean[1] /= live.length; mean[2] /= live.length; }
    out.push({
      name: pts.name || '(unnamed)',
      alive: live.length,
      nan,
      mean,
      livePoints: live,
      meanAbsOffset: (origin) => {
        const m: [number, number, number] = [0, 0, 0];
        for (const p of live) { m[0] += Math.abs(p[0] - origin[0]); m[1] += Math.abs(p[1] - origin[1]); m[2] += Math.abs(p[2] - origin[2]); }
        if (live.length) { m[0] /= live.length; m[1] /= live.length; m[2] /= live.length; }
        return m;
      },
      maxDist: (origin) => {
        let d = 0;
        for (const p of live) {
          d = Math.max(d, Math.hypot(p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]));
        }
        return d;
      },
    });
  });
  return out;
}

// Perpendicular distance from p to the segment [a, b], and the (clamped)
// fraction t along that segment where the closest point falls.
function pointToSegment(
  p: [number, number, number],
  a: [number, number, number],
  b: [number, number, number],
): { dist: number; t: number } {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2];
  const abLenSq = abx * abx + aby * aby + abz * abz;
  let t = abLenSq > 1e-12 ? (apx * abx + apy * aby + apz * abz) / abLenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = a[0] + abx * t, cy = a[1] + aby * t, cz = a[2] + abz * t;
  return { dist: Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz), t };
}

async function runEffectSimChecks(): Promise<Result[]> {
  const out: Result[] = [];
  const base = import.meta.env.BASE_URL;
  const attachments = await fetch(`${base}data/effects/attachments.json`).then((r) => r.json());
  const weapon = attachments['c_rocketlauncher'] ?? {};
  const entry = (name: string): [number, number, number] => {
    const e = weapon[name];
    if (Array.isArray(e)) return [e[0], e[1], e[2]];
    if (e && Array.isArray(e.pos)) return [e.pos[0], e.pos[1], e.pos[2]];
    return [0, 0, 0];
  };
  const unusual0 = entry('unusual_0');
  const unusual5 = entry('unusual_5');
  const modelRadius = 40; // roughly the rocket launcher's half-length
  const center = new THREE.Vector3(unusual0[0], unusual0[1], (unusual0[2] + unusual5[2]) / 2);

  for (const id of ['hot', 'isotope', 'cool', 'energy_orb']) {
    const effect = createUnusualEffect(id, modelRadius, 'c_rocketlauncher', center);
    if (!effect) {
      out.push({ name: `Effects: ${id} created`, pass: false, got: [0, 0, 0], expected: [1, 0, 0] });
      continue;
    }
    effect.updateAnchor(new THREE.Matrix4());
    const t0 = performance.now();
    while (effect.object.children.length === 0 && performance.now() - t0 < 8000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    for (let i = 0; i < 300; i++) effect.update(1 / 60);
    const stats = collectPointsStats(effect.object);
    const totalAlive = stats.reduce((n, s) => n + s.alive, 0);
    const totalNan = stats.reduce((n, s) => n + s.nan, 0);
    const maxDist = Math.max(0, ...stats.map((s) => s.maxDist([center.x, center.y, center.z])));

    out.push({
      name: `Effects: ${id} population (alive, NaN, systems)`,
      pass: totalAlive >= 20 && totalNan === 0 && stats.length >= 1,
      got: [totalAlive, totalNan, stats.length],
      expected: [20, 0, 1],
    });
    out.push({
      name: `Effects: ${id} bounded (max dist from model center)`,
      pass: Number.isFinite(maxDist) && maxDist < modelRadius * 5,
      got: [maxDist, 0, 0],
      expected: [modelRadius * 5, 0, 0],
    });

    if (id === 'energy_orb') {
      const orb = stats.find((s) => s.name.includes('energyorb'));
      // Task 1 (path constraint): minimum/maximum distance are both 0 in the
      // extracted data, so the constraint hard-snaps every alive particle
      // onto the straight segment between the CP0 and CP5 attachments (mid
      // is the exact segment midpoint, so the quadratic bezier degenerates
      // to the line); ages should also be spread along that segment rather
      // than clustered at one end, confirming particles actually travel.
      let maxSegDist = 0;
      let minT = Infinity;
      let maxT = -Infinity;
      if (orb) {
        for (const pt of orb.livePoints) {
          const { dist, t } = pointToSegment(pt, unusual0, unusual5);
          maxSegDist = Math.max(maxSegDist, dist);
          minT = Math.min(minT, t);
          maxT = Math.max(maxT, t);
        }
      }
      const tSpread = orb && orb.livePoints.length ? maxT - minT : 0;
      out.push({
        name: 'Effects: energy orb path constraint (on CP0->CP5 segment, spread along it)',
        pass: !!orb && orb.livePoints.length >= 10 && maxSegDist < 0.5 && tSpread > 0.3,
        got: [maxSegDist, tSpread, orb ? orb.livePoints.length : 0],
        expected: [0.5, 0.3, 10],
      });
    }
    if (id === 'cool') {
      // weapon_unusual_cool_rocketlauncher's real children (barrel/vapour "_1"/icecubes/
      // snowflakes) - not the weapon_unusual_water_*/swirls subtree a stale, corrupted copy of
      // weapon_unusual_cool.pcf in the gitignored staging/ dir had wired the tree to instead (see
      // the extract-effects.mjs KNOWN_MISSING_MATERIALS/MATERIAL_FALLBACKS comments for the full
      // story). None of the four real leaf materials (sc_hardglow, smokesprites_0001,
      // fleck_glass3, snowflake01) are missing, so all four should have live rendered points.
      const barrel = stats.find((s) => s.name.endsWith('_barrel'));
      const vapour = stats.find((s) => s.name.endsWith('_rocketlauncher_1'));
      const icecubes = stats.find((s) => s.name.endsWith('_icecubes'));
      const snowflakes = stats.find((s) => s.name.endsWith('_snowflakes'));
      out.push({
        name: 'Effects: cool barrel glow alive and hugging the muzzle (CP0->CP1 path constraint)',
        pass: !!barrel && barrel.alive > 0 && barrel.maxDist(unusual0) < modelRadius,
        got: [barrel ? barrel.alive : 0, barrel ? barrel.maxDist(unusual0) : -1, 0],
        expected: [1, modelRadius, 0],
      });
      out.push({
        name: 'Effects: cool vapour/icecubes/snowflakes systems alive',
        pass: !!vapour && vapour.alive > 0 && !!icecubes && icecubes.alive > 0 && !!snowflakes && snowflakes.alive > 0,
        got: [vapour ? vapour.alive : 0, icecubes ? icecubes.alive : 0, snowflakes ? snowflakes.alive : 0],
        expected: [1, 1, 1],
      });
    }
    effect.dispose();
  }
  return out;
}

// Task 2b: a view-angle preset or reset moves the weapon's whole transform
// in a single frame. Uses "hot", not the energy orb: the orb's motion is
// fully re-derived from control-point positions every frame by the path
// constraint (min/max distance both 0), so it would self-correct on the very
// next tick regardless of whether teleport handling works. Hot's barrel/
// embers children use Movement Lock to Control Point, which reads the
// control point's raw one-frame delta directly, so it is the case that
// actually exercises notifyTeleport()/the automatic anchor-jump fallback.
async function runTeleportCheck(): Promise<Result> {
  const modelRadius = 40;
  const center = new THREE.Vector3(0, 0, 0);
  const effect = createUnusualEffect('hot', modelRadius, 'c_rocketlauncher', center);
  if (!effect) {
    return { name: 'Effects: teleport invariant (no scatter after instant anchor jump)', pass: false, got: [0, 0, 0], expected: [1, 0, 0] };
  }
  effect.updateAnchor(new THREE.Matrix4());
  const t0 = performance.now();
  while (effect.object.children.length === 0 && performance.now() - t0 < 8000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  for (let i = 0; i < 120; i++) effect.update(1 / 60);

  // Instant transform snap, matching InspectControls.apply()'s single-frame
  // jump (setViewDirection / reset both call it synchronously).
  const teleportPos = new THREE.Vector3(500, -300, 200);
  const teleportMatrix = new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(teleportPos);
  effect.updateAnchor(teleportMatrix);
  effect.notifyTeleport();
  effect.update(1 / 60);

  const stats = collectPointsStats(effect.object);
  const totalAlive = stats.reduce((n, s) => n + s.alive, 0);
  const maxDist = Math.max(0, ...stats.map((s) => s.maxDist([teleportPos.x, teleportPos.y, teleportPos.z])));
  effect.dispose();
  return {
    name: 'Effects: teleport invariant (no scatter after instant anchor jump)',
    pass: totalAlive > 0 && Number.isFinite(maxDist) && maxDist < modelRadius * 5,
    got: [maxDist, totalAlive, 0],
    expected: [modelRadius * 5, totalAlive, 0],
  };
}

// Locks in the Alpha Fade and Decay fix: before it, energy orb particles
// died at an absolute end_fade_out_time (3.0s) instead of their lifetime
// attribute (2.1s), so the pool filled past capacity and emission stalled in
// bursts (spawn stall -> mass death -> refill, repeating every ~3s). After a
// warmup to steady state, the alive count should hold roughly steady rather
// than sawtoothing.
async function runEnergyOrbContinuityCheck(): Promise<Result> {
  const modelRadius = 40;
  const center = new THREE.Vector3(0, 0, 0);
  const effect = createUnusualEffect('energy_orb', modelRadius, 'c_rocketlauncher', center);
  if (!effect) {
    return { name: 'Effects: energy orb spawn continuity (no burst/oscillation)', pass: false, got: [0, 0, 0], expected: [1, 0, 0] };
  }
  effect.updateAnchor(new THREE.Matrix4());
  const t0 = performance.now();
  while (effect.object.children.length === 0 && performance.now() - t0 < 8000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  for (let i = 0; i < 240; i++) effect.update(1 / 60); // 4s warmup to steady state

  const samples: number[] = [];
  for (let s = 0; s < 12; s++) {
    for (let i = 0; i < 15; i++) effect.update(1 / 60); // 0.25s per sample, 3s total
    const stats = collectPointsStats(effect.object);
    const orb = stats.find((st) => st.name.includes('energyorb'));
    samples.push(orb ? orb.alive : 0);
  }
  effect.dispose();

  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const minS = Math.min(...samples);
  const maxS = Math.max(...samples);
  const amplitude = mean > 0 ? (maxS - minS) / mean : Number.POSITIVE_INFINITY;
  return {
    name: 'Effects: energy orb spawn continuity (steady alive count, no burst/oscillation)',
    pass: mean > 10 && minS > 0 && amplitude < 0.25,
    got: [mean, minS, amplitude],
    expected: [mean, mean * 0.75, 0.25],
  };
}

export function SelfTestPage() {
  const [results, setResults] = useState<Result[] | null>(null);
  const [allPass, setAllPass] = useState<boolean | null>(null);

  useEffect(() => {
    const { cases, texMap } = buildCases();
    const comp = new Compositor((ref) => texMap[ref] ?? ref, { size: 64 });
    const out: Result[] = [];

    (async () => {
      for (const c of cases) {
        const res = await comp.compose(c.recipe, '1');
        const buf = comp.readPixels(res.target);
        const size = comp.getSize();
        const px = Math.min(size - 1, Math.floor(c.sample[0] * size));
        const py = Math.min(size - 1, Math.floor(c.sample[1] * size));
        const i = (py * size + px) * 4;
        const got: [number, number, number] = [buf[i], buf[i + 1], buf[i + 2]];
        const pass =
          Math.abs(got[0] - c.expected[0]) <= c.tol &&
          Math.abs(got[1] - c.expected[1]) <= c.tol &&
          Math.abs(got[2] - c.expected[2]) <= c.tol;
        out.push({ name: c.name, pass, got, expected: c.expected });
        res.target.dispose();
      }
      try {
        out.push(...await runEffectSimChecks());
      } catch (err) {
        console.error('[selftest] effect sim checks failed to run:', err);
        out.push({ name: 'Effects: sim checks ran', pass: false, got: [0, 0, 0], expected: [1, 0, 0] });
      }
      try {
        out.push(await runTeleportCheck());
      } catch (err) {
        console.error('[selftest] teleport check failed to run:', err);
        out.push({ name: 'Effects: teleport invariant ran', pass: false, got: [0, 0, 0], expected: [1, 0, 0] });
      }
      try {
        out.push(await runEnergyOrbContinuityCheck());
      } catch (err) {
        console.error('[selftest] energy orb continuity check failed to run:', err);
        out.push({ name: 'Effects: energy orb continuity check ran', pass: false, got: [0, 0, 0], expected: [1, 0, 0] });
      }
      const ok = out.every((r) => r.pass);
      setResults(out);
      setAllPass(ok);
      document.title = ok ? 'SELFTEST PASS' : 'SELFTEST FAIL';
      // eslint-disable-next-line no-console
      console.log(`[selftest] ${ok ? 'PASS' : 'FAIL'}`);
      for (const r of out) {
        // eslint-disable-next-line no-console
        console.log(
          `[selftest] ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  got=[${r.got.map((n) => n.toFixed(3)).join(', ')}] expected=[${r.expected.map((n) => n.toFixed(3)).join(', ')}]`,
        );
      }
      comp.dispose();
    })();
  }, []);

  return (
    <div className="selftest">
      <h1>Compositor Self Test</h1>
      <div className={`selftest-status ${allPass == null ? 'pending' : allPass ? 'pass' : 'fail'}`}>
        {allPass == null ? 'RUNNING...' : allPass ? 'ALL PASS' : 'FAILURES'}
      </div>
      <table className="selftest-table">
        <thead>
          <tr>
            <th>Case</th>
            <th>Result</th>
            <th>Got (linear rgb)</th>
            <th>Expected</th>
          </tr>
        </thead>
        <tbody>
          {(results ?? []).map((r) => (
            <tr key={r.name} className={r.pass ? 'pass' : 'fail'}>
              <td>{r.name}</td>
              <td>{r.pass ? 'PASS' : 'FAIL'}</td>
              <td>{r.got.map((n) => n.toFixed(3)).join(', ')}</td>
              <td>{r.expected.map((n) => n.toFixed(3)).join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
