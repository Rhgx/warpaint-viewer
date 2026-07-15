import { useEffect, useState } from 'react';
import { Compositor } from './compositor';
import type { RecipeNode } from './compositor/types';

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

export function SelfTestPage() {
  const [results, setResults] = useState<Result[] | null>(null);
  const [allPass, setAllPass] = useState<boolean | null>(null);

  useEffect(() => {
    const { cases, texMap } = buildCases();
    const comp = new Compositor((ref) => texMap[ref] ?? ref, { size: 64 });
    const out: Result[] = [];

    (async () => {
      for (const c of cases) {
        const res = await comp.compose(c.recipe, 1);
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
