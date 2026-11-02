// Provenance for one editor selection. A result only answers the selection it was requested for.

export type ProvenanceStatus = 'pending' | 'ready' | 'unavailable';

/**
 * Identifies one provenance request. Imported kits include the source generation, so a
 * re-import with the same kit id cannot reuse provenance from the replaced definitions.
 */
export function provenanceRecipeKey(selection: {
  readonly kitId: number;
  readonly sourceGeneration: number | 'stock';
  readonly weaponKey: string;
  readonly team: string;
  readonly wearIndex: number;
}): string {
  return [selection.kitId, selection.sourceGeneration, selection.weaponKey, selection.team, selection.wearIndex].join('|');
}

/** 'pending' until the request for this key settles; 'unavailable' when it settled without a recipe. */
export function provenanceStatus<Recipe>(
  loaded: { readonly key: string; readonly recipe: Recipe | null } | null,
  key: string,
): ProvenanceStatus {
  if (!key || loaded?.key !== key) return 'pending';
  return loaded.recipe ? 'ready' : 'unavailable';
}
