import type { Manifest, PaintkitEntry, Team } from './types';
import type { RecipeNode, TextureResolver } from '../compositor/types';
import { mockManifest, mockRecipe } from './mock/data';
import { mockTextures } from './mock/textures';

export interface DataSource {
  readonly kind: 'real' | 'mock';
  readonly manifest: Manifest;
  // Resolve a texture ref (path or mock key or data: URL) to a loadable URL.
  resolveTexture: TextureResolver;
  // Load and parse a recipe stage tree; null if none exists for this combo.
  getRecipe(kit: PaintkitEntry, weaponKey: string, team: Team, wearIndex: number): Promise<RecipeNode | null>;
  // Absolute URL of a weapon GLB, or null when absent (app uses placeholder).
  getModelUrl(weaponKey: string): string | null;
}

const DATA_ROOT = '/data';

function joinData(rel: string): string {
  if (rel.startsWith('data:') || rel.startsWith('http')) return rel;
  return `${DATA_ROOT}/${rel.replace(/^\/+/, '')}`;
}

class RealDataSource implements DataSource {
  readonly kind = 'real' as const;
  private recipeCache = new Map<string, Promise<RecipeNode | null>>();
  readonly manifest: Manifest;
  constructor(manifest: Manifest) {
    this.manifest = manifest;
  }

  resolveTexture: TextureResolver = (ref) => joinData(ref);

  getModelUrl(weaponKey: string): string | null {
    const w = this.manifest.weapons.find((x) => x.key === weaponKey);
    return w ? joinData(w.model) : null;
  }

  private async fetchRecipe(url: string): Promise<RecipeNode | null> {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return (await res.json()) as RecipeNode;
    } catch {
      return null;
    }
  }

  async getRecipe(kit: PaintkitEntry, weaponKey: string, team: Team, wearIndex: number): Promise<RecipeNode | null> {
    const wearSuffix = kit.perWear ? `_w${wearIndex}` : '';
    const key = `${kit.id}/${weaponKey}_${team}${wearSuffix}`;
    const cached = this.recipeCache.get(key);
    if (cached) return cached;

    const p = (async () => {
      const primary = `${DATA_ROOT}/recipes/${kit.id}/${weaponKey}_${team}${wearSuffix}.json`;
      let recipe = await this.fetchRecipe(primary);
      // Team fallback: only `red` is emitted when hasTeamTextures is false, and
      // blu falls back to red.
      if (!recipe && team === 'blu') {
        const fallback = `${DATA_ROOT}/recipes/${kit.id}/${weaponKey}_red${wearSuffix}.json`;
        recipe = await this.fetchRecipe(fallback);
      }
      return recipe;
    })();
    this.recipeCache.set(key, p);
    return p;
  }
}

class MockDataSource implements DataSource {
  readonly kind = 'mock' as const;
  readonly manifest = mockManifest;
  private textures = mockTextures();

  resolveTexture: TextureResolver = (ref) => {
    if (ref.startsWith('data:')) return ref;
    const url = this.textures[ref];
    if (!url) throw new Error(`mock texture not found: ${ref}`);
    return url;
  };

  getModelUrl(): string | null {
    return null; // always placeholder mesh in mock mode
  }

  async getRecipe(kit: PaintkitEntry, weaponKey: string, team: Team): Promise<RecipeNode | null> {
    const effectiveTeam: Team = kit.hasTeamTextures ? team : 'red';
    return mockRecipe(kit.id, weaponKey, effectiveTeam);
  }
}

// Chooses the data source. ?data=mock (or ?mock=1) forces mock; ?data=real forces
// real; otherwise it tries real and automatically falls back to mock on a failed
// manifest fetch.
export async function loadDataSource(): Promise<DataSource> {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('data') ?? (params.get('mock') === '1' ? 'mock' : null);

  if (mode === 'mock') return new MockDataSource();

  try {
    const res = await fetch(`${DATA_ROOT}/manifest.json`);
    if (!res.ok) throw new Error(`manifest ${res.status}`);
    const manifest = (await res.json()) as Manifest;
    if (!manifest.paintkits?.length) throw new Error('empty manifest');
    return new RealDataSource(manifest);
  } catch (err) {
    if (mode === 'real') throw err;
    // Automatic fallback for local dev before the pipeline has produced data.
    console.info('[warpaint-viewer] no /data/manifest.json; using mock data.', err);
    return new MockDataSource();
  }
}
