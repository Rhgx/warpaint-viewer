import type { RecipeNode } from '../compositor/types';
import type { SeedRangeValue } from '../ui/workbench/SeedRangeField';
import type { TextureTransformFields } from '../ui/workbench/TextureTransformPanel';
import type { TextureTransformRangeField, TextureTransformTarget } from './mutations';
import { protoTextureReference } from './stickerTargets';
import type { TextureTransformRangeFieldState, TextureTransformTargetInfo } from './transformTargets';

export const TRANSFORM_LIVE_PREVIEW_MAX_SIZE = 256;

const TRANSFORM_FIELD_DEFAULTS: TextureTransformFields = {
  rotation: { mode: 'fixed', min: 0, max: 0 },
  scale: { mode: 'fixed', min: 1, max: 1 },
  offsetU: { mode: 'fixed', min: 0, max: 0 },
  offsetV: { mode: 'fixed', min: 0, max: 0 },
};

export const TRANSFORM_FIELD_TO_PROTO: Record<keyof TextureTransformFields, TextureTransformRangeField> = {
  rotation: 'rotation',
  scale: 'scale_uv',
  offsetU: 'translate_u',
  offsetV: 'translate_v',
};

function transformRangeFieldValue(
  state: TextureTransformRangeFieldState | undefined,
  fallback: SeedRangeValue,
): SeedRangeValue {
  return state ? { mode: state.mode, min: state.min, max: state.max } : fallback;
}

/** The four range fields of a discovered layer, or the defaults where the layer is unknown. */
export function transformFieldsFromInfo(info?: TextureTransformTargetInfo | null): TextureTransformFields {
  return {
    rotation: transformRangeFieldValue(info?.rotation, TRANSFORM_FIELD_DEFAULTS.rotation),
    scale: transformRangeFieldValue(info?.scaleUv, TRANSFORM_FIELD_DEFAULTS.scale),
    offsetU: transformRangeFieldValue(info?.translateU, TRANSFORM_FIELD_DEFAULTS.offsetU),
    offsetV: transformRangeFieldValue(info?.translateV, TRANSFORM_FIELD_DEFAULTS.offsetV),
  };
}

export function transformRangeStatesEqual(
  left: Pick<TextureTransformRangeFieldState, 'mode' | 'min' | 'max'>,
  right: Pick<TextureTransformRangeFieldState, 'mode' | 'min' | 'max'>,
): boolean {
  return left.mode === right.mode && left.min === right.min && left.max === right.max;
}

/** True when any range field leaves its default or either flip is on. */
export function transformInfoHasEdits(info: TextureTransformTargetInfo): boolean {
  return !transformRangeStatesEqual(info.rotation, TRANSFORM_FIELD_DEFAULTS.rotation)
    || !transformRangeStatesEqual(info.scaleUv, TRANSFORM_FIELD_DEFAULTS.scale)
    || !transformRangeStatesEqual(info.translateU, TRANSFORM_FIELD_DEFAULTS.offsetU)
    || !transformRangeStatesEqual(info.translateV, TRANSFORM_FIELD_DEFAULTS.offsetV)
    || info.flipU.allowed
    || info.flipV.allowed;
}

export function transformInfosEqual(left: TextureTransformTargetInfo, right: TextureTransformTargetInfo): boolean {
  return transformRangeStatesEqual(left.rotation, right.rotation)
    && transformRangeStatesEqual(left.scaleUv, right.scaleUv)
    && transformRangeStatesEqual(left.translateU, right.translateU)
    && transformRangeStatesEqual(left.translateV, right.translateV)
    && left.flipU.allowed === right.flipU.allowed
    && left.flipV.allowed === right.flipV.allowed;
}

/** Scope 'all' always writes the shared header default; 'weapon' keeps whatever weapon-local source discovery found. */
export function transformTargetForScope(target: TextureTransformTarget, scope: 'all' | 'weapon'): TextureTransformTarget {
  return scope === 'all' ? { stagePath: target.stagePath } : target;
}

const TRANSFORM_FIELD_TO_RECIPE: Record<keyof TextureTransformFields, 'rotation' | 'scaleUV' | 'translateU' | 'translateV'> = {
  rotation: 'rotation',
  scale: 'scaleUV',
  offsetU: 'translateU',
  offsetV: 'translateV',
};

export function previewTextureTransformRange(
  node: RecipeNode,
  target: RecipeNode | null,
  matchingTextureRef: string | null,
  field: keyof TextureTransformFields,
  value: SeedRangeValue,
): RecipeNode {
  const matchesTexture = node.type === 'texture_lookup' && matchingTextureRef !== null
    && protoTextureReference(node.texture) === protoTextureReference(matchingTextureRef);
  if (node.type === 'texture_lookup' && (node === target || matchesTexture)) {
    return { ...node, [TRANSFORM_FIELD_TO_RECIPE[field]]: [value.min, value.max] };
  }
  if (!('nodes' in node)) return node;
  const nodes = node.nodes.map((child) => previewTextureTransformRange(
    child,
    target,
    matchingTextureRef,
    field,
    value,
  ));
  return nodes.every((child, index) => child === node.nodes[index]) ? node : { ...node, nodes };
}
