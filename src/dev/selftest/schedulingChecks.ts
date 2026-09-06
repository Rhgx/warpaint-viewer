import * as THREE from 'three';
import { Compositor } from '../../compositor/compositor';
import type { RecipeNode } from '../../compositor/types';
import type { CheckResult } from './compositorChecks';

// A repeatable GPU workload comparing the ordinary export queue with the
// latest-only preview queue. Timings include JS submission and final readback;
// they are not GPU timer-query measurements or whole-app frame rates.
export async function compositorSchedulingChecks(): Promise<CheckResult[]> {
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.info.autoReset = false;
  const comp = new Compositor((ref) => ref, { renderer, size: 256 });
  const recipe: RecipeNode = { type: 'combine_multiply', nodes: [] };
  try {
    const warm = await comp.compose(recipe, '0');
    comp.readPixels(warm.target);
    comp.releaseResult(warm);
    const out: CheckResult[] = [];
    for (const latest of [false, true]) {
      renderer.info.reset();
      let completed = 0;
      const start = performance.now();
      const results = await Promise.all(Array.from({ length: 100 }, (_, index) => {
        const pending = latest
          ? comp.composeLatest('selftest-visible', recipe, String(index))
          : comp.compose(recipe, String(index));
        return pending.then((result) => {
          if (!result) return null;
          completed++;
          // Keep only the final output for a pixel check and GPU completion.
          if (index === 99) return result;
          comp.releaseResult(result);
          return null;
        });
      }));
      const draws = renderer.info.render.calls;
      const final = results[99];
      const pixel = final ? comp.readPixels(final.target)[0] : -1;
      const elapsed = performance.now() - start;
      if (final) comp.releaseResult(final);
      console.log(`[perf] ${latest ? 'latest-only' : 'ordinary'} 100-request burst: ${draws} draws, ${completed} results, ${elapsed.toFixed(2)} ms including final readback`);
      const expected = latest ? 1 : 100;
      out.push({
        name: `Scheduling: ${latest ? 'latest-only' : 'ordinary'} 100-request burst (draws, results, final white pixel)`,
        pass: draws === expected && completed === expected && pixel === 1,
        got: [draws, completed, pixel],
        expected: [expected, expected, 1],
      });
    }
    return out;
  } finally {
    comp.dispose();
    renderer.dispose();
  }
}
