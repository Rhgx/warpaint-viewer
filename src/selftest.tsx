import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { Compositor } from './compositor';
import type { RecipeNode } from './compositor/types';
import { createUnusualEffect } from './viewer/effects';

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
  const unusual1 = entry('unusual_1');
  const modelRadius = 40; // roughly the rocket launcher's half-length
  const center = new THREE.Vector3(unusual0[0], unusual0[1], (unusual0[2] + entry('unusual_5')[2]) / 2);

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
      const off = orb ? orb.meanAbsOffset(unusual1) : [0, 0, 0];
      // distance_bias (1,0,1) in the unusual_1 attachment frame zeroes the
      // attachment local Y, which the extracted orientation maps to glb +Y:
      // the orb streams in the horizontal plane through the barrel (glb Z
      // and X) with essentially no vertical spread.
      out.push({
        name: 'Effects: energy orb spread stays in the barrel plane',
        pass: !!orb && orb.alive >= 30 && off[2] > 3 && off[0] > 3 && off[1] < 0.35 * Math.max(off[0], off[2]),
        got: [off[2], off[0], off[1]],
        expected: [3, 3, 0.35 * Math.max(off[0], off[2])],
      });
    }
    if (id === 'cool') {
      const swirls = stats.find((s) => s.name.includes('swirls'));
      out.push({
        name: 'Effects: cool water swirl system alive',
        pass: !!swirls && swirls.alive > 0 && swirls.maxDist([unusual0[0], unusual0[1], unusual0[2]]) < modelRadius * 5,
        got: [swirls ? swirls.alive : 0, 0, 0],
        expected: [1, 0, 0],
      });
    }
    effect.dispose();
  }
  return out;
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
