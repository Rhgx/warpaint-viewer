// Recipe resolution: turns decoded stage messages into RecipeNode trees.
import type { RecipeNode } from '../compositor/types';
import { selectHasActiveGroup } from '../compositor/resolve';
import {
  applyVarDefOverrides, applyVarFieldOverrides, buildVarDict,
  parseInverseRange, parseRange, parseRangeDiv255, parseVec2, texturePublicPath,
  stickerWeightFromString, varFieldValue, type VarEntry,
} from './values';
import {
  many, type CombineStageMsg, type ItemDefinitionMsg, type ItemMsg, type Many, type OperationMsg,
  type OperationNodeMsg, type OperationStageMsg, type PaintkitDefinitionMsg, type VarDefMsg, type VarFieldMsg,
} from './messages';
import type { ResolveCtx } from './resolve';

const DEFAULTS = {
  adjustBlack: [0, 0] as [number, number],
  adjustOffset: [1, 1] as [number, number],
  adjustGamma: [1, 1] as [number, number],
  rotation: [0, 0] as [number, number],
  translateU: [0, 0] as [number, number],
  translateV: [0, 0] as [number, number],
  scaleUV: [1, 1] as [number, number],
};

function resolveTextureRef(
  stage: { texture?: VarFieldMsg; texture_red?: VarFieldMsg; texture_blue?: VarFieldMsg },
  dict: Map<string, VarEntry>,
  team: 'red' | 'blu',
): string | null {
  const chosen = team === 'blu' ? (stage.texture_blue ?? stage.texture) : (stage.texture_red ?? stage.texture);
  return texturePublicPath(varFieldValue(chosen, dict));
}

function commonTransforms(
  stage: {
    adjust_black?: VarFieldMsg; adjust_offset?: VarFieldMsg; adjust_gamma?: VarFieldMsg;
    rotation?: VarFieldMsg; translate_u?: VarFieldMsg; translate_v?: VarFieldMsg;
    scale_uv?: VarFieldMsg; flip_u?: VarFieldMsg; flip_v?: VarFieldMsg;
  },
  dict: Map<string, VarEntry>,
) {
  const flipRange = (field: VarFieldMsg | undefined): [number, number] => {
    const range = parseRange(varFieldValue(field, dict), [0, 0]);
    return range && range.every(Number.isFinite) ? range : [0, 0];
  };
  return {
    adjustBlack: parseRangeDiv255(varFieldValue(stage.adjust_black, dict), DEFAULTS.adjustBlack),
    adjustOffset: parseRangeDiv255(varFieldValue(stage.adjust_offset, dict), DEFAULTS.adjustOffset),
    adjustGamma: parseInverseRange(varFieldValue(stage.adjust_gamma, dict), DEFAULTS.adjustGamma),
    rotation: parseRange(varFieldValue(stage.rotation, dict), DEFAULTS.rotation) as [number, number],
    translateU: parseRange(varFieldValue(stage.translate_u, dict), DEFAULTS.translateU) as [number, number],
    translateV: parseRange(varFieldValue(stage.translate_v, dict), DEFAULTS.translateV) as [number, number],
    scaleUV: parseRange(varFieldValue(stage.scale_uv, dict), DEFAULTS.scaleUV) as [number, number],
    flipU: flipRange(stage.flip_u),
    flipV: flipRange(stage.flip_v),
  };
}

function resolveNodes(
  nodeList: Many<OperationNodeMsg>,
  ctx: ResolveCtx,
  dict: Map<string, VarEntry>,
  team: 'red' | 'blu',
  textureRefs: Set<string>,
): RecipeNode[] {
  const out: RecipeNode[] = [];
  for (const node of many(nodeList)) {
    if (node.operation_template) {
      const ref = ctx.opByIdx.get(node.operation_template.defindex);
      if (ref) {
        const inlined = resolveNodes(ref.operation_node, ctx, dict, team, textureRefs);
        if (inlined.length === 1) out.push(inlined[0]);
        else out.push({ type: 'combine_multiply', rootCopy: true, nodes: inlined });
      }
      continue;
    }
    if (node.stage) {
      const resolved = resolveStage(node.stage, ctx, dict, team, textureRefs);
      if (resolved) out.push(resolved);
    }
  }
  return out;
}

function resolveStage(
  stage: OperationStageMsg,
  ctx: ResolveCtx,
  dict: Map<string, VarEntry>,
  team: 'red' | 'blu',
  textureRefs: Set<string>,
): RecipeNode | null {
  if (stage.texture_lookup) {
    const s = stage.texture_lookup;
    const tex = resolveTextureRef(s, dict, team);
    if (tex) textureRefs.add(tex);
    return { type: 'texture_lookup', texture: tex ?? '', ...commonTransforms(s, dict) };
  }

  if (stage.combine_multiply || stage.combine_add || stage.combine_lerp) {
    const key = stage.combine_multiply ? 'combine_multiply' : stage.combine_add ? 'combine_add' : 'combine_lerp';
    const s = (stage.combine_multiply ?? stage.combine_add ?? stage.combine_lerp) as CombineStageMsg;
    return {
      type: key,
      ...commonTransforms(s, dict),
      nodes: resolveNodes(s.operation_node, ctx, dict, team, textureRefs),
    };
  }

  if (stage.select) {
    const s = stage.select;
    const groupsVal = varFieldValue(s.groups, dict);
    const groups = texturePublicPath(groupsVal);
    const select: Array<number | string> = [];
    for (const sel of many(s.select)) {
      const v = varFieldValue(sel, dict);
      const num = Number(v);
      select.push(Number.isFinite(num) ? num : (v as string));
    }
    // Zero is padding, not a group: an all-zero selector is a constant black mask and never
    // samples its groups texture. Loading a template path it does not use would fail the recipe.
    if (groups && selectHasActiveGroup(select)) textureRefs.add(groups);
    return { type: 'select', groups: groups ?? '', select };
  }

  if (stage.apply_sticker) {
    const s = stage.apply_sticker;
    const stickers = [];
    for (const st of many(s.sticker)) {
      const base = texturePublicPath(varFieldValue(st.base, dict));
      if (base) textureRefs.add(base);
      const entry: { base: string; weight: number; spec?: string } = {
        base: base ?? '',
        weight: stickerWeightFromString(varFieldValue(st.weight, dict)),
      };
      const specVal = varFieldValue(st.spec, dict);
      if (specVal) {
        const spec = texturePublicPath(specVal);
        if (spec) { entry.spec = spec; textureRefs.add(spec); }
      }
      stickers.push(entry);
    }
    return {
      type: 'apply_sticker',
      stickers,
      destTl: parseVec2(varFieldValue(s.dest_tl, dict), [0, 0]),
      destTr: parseVec2(varFieldValue(s.dest_tr, dict), [0, 0]),
      destBl: parseVec2(varFieldValue(s.dest_bl, dict), [0, 0]),
      adjustBlack: parseRangeDiv255(varFieldValue(s.adjust_black, dict), DEFAULTS.adjustBlack),
      adjustOffset: parseRangeDiv255(varFieldValue(s.adjust_offset, dict), DEFAULTS.adjustOffset),
      adjustGamma: parseInverseRange(varFieldValue(s.adjust_gamma, dict), DEFAULTS.adjustGamma),
      nodes: resolveNodes(s.operation_node, ctx, dict, team, textureRefs),
    };
  }

  return null;
}

// Mirrors tools/lib/resolve.mjs resolveRecipe, including its override order.
export function resolveOne(
  paintkitDef: PaintkitDefinitionMsg,
  slotItem: ItemMsg,
  itemDef: ItemDefinitionMsg,
  wearIdx: number,
  team: 'red' | 'blu',
  ctx: ResolveCtx,
): { tree: RecipeNode; textureRefs: Set<string> } | null {
  let operationMsg: OperationMsg | null = null;
  let baseHeaderVars: Many<VarDefMsg> = paintkitDef.header.variables;
  if (paintkitDef.operation_template) {
    operationMsg = ctx.opByIdx.get(paintkitDef.operation_template.defindex) ?? null;
  }
  const defs = many(itemDef.definition);
  const clampedIdx = Math.max(0, Math.min(wearIdx, defs.length - 1));
  const perWearDef = defs[clampedIdx];
  if (perWearDef && perWearDef.operation_template) {
    const override = ctx.opByIdx.get(perWearDef.operation_template.defindex);
    if (override) {
      operationMsg = override;
      baseHeaderVars = override.header.variables;
    }
  }
  if (!operationMsg) return null;

  const dict = buildVarDict(baseHeaderVars);
  // Override order matches the SDK: item slot data vars, then item def header vars, then per-wear def vars.
  applyVarFieldOverrides(dict, slotItem.data?.variable);
  applyVarDefOverrides(dict, itemDef.header?.variables);
  if (perWearDef) applyVarFieldOverrides(dict, perWearDef.variable);

  const textureRefs = new Set<string>();
  const nodes = resolveNodes(operationMsg.operation_node, ctx, dict, team, textureRefs);
  // A single root node is the tree; several are wrapped in a passthrough combine.
  let tree: RecipeNode;
  if (nodes.length === 1) tree = nodes[0];
  else tree = { type: 'combine_multiply', rootCopy: true, nodes };
  return { tree, textureRefs };
}
