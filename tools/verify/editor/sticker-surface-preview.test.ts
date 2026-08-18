// Sticker 2D surface source contract check.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import {
  preStickerSurface,
  recipeWithoutStickerOccurrence,
  recipeWithoutStickerOccurrences,
  resolvedGroupStickerContext,
} from '../../../src/editor/stickerSurface';
import { visibleStickerEditorMap } from '../../../src/viewer/stickerEditorMap';
import type { CombineNode, ApplyStickerNode } from '../../../src/compositor/types';
import type { ResolvedCombine, ResolvedNode, ResolvedSelect, ResolvedSticker } from '../../../src/compositor/resolve';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function resolvedCombineAt(nodes: readonly ResolvedNode[], index: number): ResolvedCombine {
  const node = nodes[index];
  if (!node || (node.type !== 'combine_add' && node.type !== 'combine_lerp' && node.type !== 'combine_multiply')) {
    throw new Error(`expected combine node at ${index}`);
  }
  return node;
}

function resolvedTextureAt(nodes: readonly ResolvedNode[], index: number): string {
  const node = nodes[index];
  if (!node || node.type !== 'texture_lookup') throw new Error(`expected texture node at ${index}`);
  return node.texture;
}

test('sticker surface preview source contract', () => {
  const nested: CombineNode = {
    type: 'combine_multiply',
    nodes: [
      { type: 'texture_lookup', texture: 'patterns/colour' },
      { type: 'select', groups: 'patterns/groups', select: [1] },
    ],
  };
  const stage: Pick<ApplyStickerNode, 'nodes'> = { nodes: [nested] };
  assert.equal(preStickerSurface(stage), nested, 'the complete nested pre-sticker tree is preserved');
  assert.equal(preStickerSurface({ nodes: [] }), null, 'a missing surface is not replaced with an invented preview');

  const firstSticker: ApplyStickerNode = {
    type: 'apply_sticker', stickers: [{ base: 'stickers/first' }],
    destTl: [0.1, 0.1], destTr: [0.2, 0.1], destBl: [0.1, 0.2], nodes: [{ type: 'texture_lookup', texture: 'base/first' }],
  };
  const secondSticker: ApplyStickerNode = {
    type: 'apply_sticker', stickers: [{ base: 'stickers/second' }],
    destTl: [0.6, 0.6], destTr: [0.7, 0.6], destBl: [0.6, 0.7], nodes: [{ type: 'texture_lookup', texture: 'base/second' }],
  };
  const completeRecipe: CombineNode = { type: 'combine_add', nodes: [firstSticker, secondSticker] };
  const withoutSecond = recipeWithoutStickerOccurrence(completeRecipe, 1);
  assert.ok(withoutSecond, 'a known sticker occurrence can be removed');
  if (withoutSecond.type !== 'combine_add') throw new Error('expected combine recipe');
  assert.equal(withoutSecond.nodes[0], firstSticker, 'other sticker stages stay in the full recipe');
  assert.equal(withoutSecond.nodes[1], secondSticker.nodes[0], 'only the selected sticker is replaced by its base');
  assert.equal(recipeWithoutStickerOccurrence(completeRecipe, 2), null, 'a missing occurrence never returns a misleading base');
  const withoutLogicalSticker = recipeWithoutStickerOccurrences(completeRecipe, [0, 1]);
  assert.ok(withoutLogicalSticker);
  if (withoutLogicalSticker.type !== 'combine_add') throw new Error('expected combine recipe');
  assert.equal(withoutLogicalSticker.nodes[0], firstSticker.nodes[0], 'the first wear-branch copy is removed');
  assert.equal(withoutLogicalSticker.nodes[1], secondSticker.nodes[0], 'the second wear-branch copy is removed');

  const transform = {
    black: 0, white: 1, gamma: 1, rotationDeg: 0,
    translateU: 0, translateV: 0, scale: 1, flipU: false, flipV: false,
  };
  const rawSelector: ResolvedSelect = { type: 'select', groups: 'groups', select: [16] };
  const siblingGroup: ResolvedSticker = {
    type: 'apply_sticker', base: 'masks/sibling', destTl: [0, 0], destTr: [0.2, 0], destBl: [0, 0.2],
    black: 0, white: 1, gamma: 1, nodes: [rawSelector],
  };
  const movingGroup: ResolvedSticker = {
    type: 'apply_sticker', base: 'masks/full-source', destTl: [0.2, 0.2], destTr: [0.4, 0.2], destBl: [0.2, 0.4],
    black: 0, white: 1, gamma: 1, nodes: [siblingGroup],
  };
  const groupRoot: ResolvedCombine = {
    type: 'combine_lerp', ...transform,
    nodes: [
      { type: 'texture_lookup', texture: 'paint/base', ...transform },
      { type: 'texture_lookup', texture: 'paint/layer', ...transform },
      movingGroup,
    ],
  };
  const groupContext = resolvedGroupStickerContext(groupRoot, movingGroup);
  assert.ok(groupContext, 'a sticker in a lerp selector has a position-independent preview context');
  if (!groupContext || groupContext.base.type !== 'combine_lerp' || groupContext.endpointZero.type !== 'combine_lerp' || groupContext.endpointOne.type !== 'combine_lerp') throw new Error('expected group context');
  assert.equal(groupContext.base.nodes[2], siblingGroup, 'only the moving group is removed from the full base');
  assert.equal(groupContext.selectorBase, siblingGroup, 'other group stickers remain in the selector baseline');
  assert.match(resolvedTextureAt(groupContext.endpointZero.nodes, 2), /^data:image\/svg\+xml/, 'the zero endpoint replaces the complete selector');
  assert.match(resolvedTextureAt(groupContext.endpointOne.nodes, 2), /^data:image\/svg\+xml/, 'the one endpoint replaces the complete selector');
  const siblingGroupWear: ResolvedSticker = { ...siblingGroup, nodes: [rawSelector] };
  const movingGroupWear: ResolvedSticker = { ...movingGroup, nodes: [siblingGroupWear] };
  const groupRootWear: ResolvedCombine = { ...groupRoot, nodes: [...groupRoot.nodes.slice(0, 2), movingGroupWear] };
  const wearRoot: ResolvedCombine = { type: 'combine_add', ...transform, nodes: [groupRoot, groupRootWear] };
  const logicalGroupContext = resolvedGroupStickerContext(wearRoot, [movingGroup, movingGroupWear]);
  assert.ok(logicalGroupContext);
  if (!logicalGroupContext || logicalGroupContext.base.type !== 'combine_add' || logicalGroupContext.endpointZero.type !== 'combine_add') throw new Error('expected logical group context');
  assert.equal(resolvedCombineAt(logicalGroupContext.base.nodes, 0).nodes[2], siblingGroup, 'the first group-sticker wear copy is removed');
  assert.equal(resolvedCombineAt(logicalGroupContext.base.nodes, 1).nodes[2], siblingGroupWear, 'the second group-sticker wear copy is removed');
  assert.match(resolvedTextureAt(resolvedCombineAt(logicalGroupContext.endpointZero.nodes, 0).nodes, 2), /^data:image\/svg\+xml/, 'the first wear selector reaches zero');
  assert.match(resolvedTextureAt(resolvedCombineAt(logicalGroupContext.endpointZero.nodes, 1).nodes, 2), /^data:image\/svg\+xml/, 'the second wear selector reaches zero');
  const ordinarySticker: ResolvedSticker = { ...movingGroup, base: 'stickers/logo', nodes: [groupRoot] };
  assert.equal(
    resolvedGroupStickerContext(ordinarySticker, ordinarySticker),
    null,
    'an ordinary sticker outside a selector is not misclassified as a group sticker',
  );

  const fullMap = { name: 'newly composed full map' };
  const editorBase = { name: 'selected sticker removed' };
  assert.equal(visibleStickerEditorMap(fullMap, editorBase), editorBase, 'the live editor base wins over a late normal compose');
  assert.equal(visibleStickerEditorMap(fullMap, null), fullMap, 'clearing the editor base restores the newest normal compose');

  const appSource = fs.readFileSync(path.join(ROOT, 'src', 'App.tsx'), 'utf8');
  assert.match(
    appSource,
    /recipeWithoutStickerOccurrences\(stickerRecipe\?\.tree \?\? null, selectedStickerTarget\.occurrences\)/,
    'the temporary base removes every wear-branch occurrence of the selected logical sticker',
  );
  const effectStart = appSource.indexOf('// Every sticker uses a retained base with its stage removed plus a lightweight');
  const currentEffect = appSource.indexOf('\n  useEffect(() => {', effectStart);
  const effectEnd = appSource.indexOf('\n  useEffect(() => {', currentEffect + 1);
  assert.ok(effectStart >= 0 && effectEnd > effectStart, 'the retained sticker editor base has a dedicated compose effect');
  const previewEffect = appSource.slice(effectStart, effectEnd);
  const dependencyBlock = previewEffect.slice(previewEffect.lastIndexOf('}, ['), previewEffect.lastIndexOf(']);'));
  assert.doesNotMatch(dependencyBlock, /stickerDraftQuad/, 'a draft does not regenerate the composed pre-sticker surface');
  assert.match(appSource, /setStickerEditorBaseMap\(surface\.texture\)/, 'the 3D editor uses its retained composed surface');
  assert.match(
    appSource,
    /resolvedGroupStickerContext/,
    'group stickers derive their reusable source before the authored destination is applied',
  );
  assert.match(appSource, /setGroupStickerPreview/, 'group movement uses the retained selector endpoint shader');
  assert.match(
    appSource,
    /setStickerPreview\(effectiveStickerTextureUrl, quad, \{[\s\S]*?specularUrl: stickerSpecularUrl/,
    'ordinary live sticker movement supplies its resolved specular texture',
  );
  const viewerSource = fs.readFileSync(path.join(ROOT, 'src', 'viewer', 'Viewer.ts'), 'utf8');
  assert.match(
    viewerSource,
    /uTf2StickerSpecMap\.value = specular \?\? texture/,
    'the live sticker specular is bound into the weapon material without another composition',
  );
  assert.doesNotMatch(
    viewerSource,
    /this\.rebuildStickerPreviewMeshes\(\);[\s\S]{0,160}uTf2StickerPreview\.value = 1/,
    'ordinary stickers do not rebuild a separate unlit weapon overlay',
  );
  const vertexLitSource = fs.readFileSync(path.join(ROOT, 'src', 'viewer', 'shaders', 'vertexlit.ts'), 'utf8');
  assert.match(
    vertexLitSource,
    /sampledDiffuseColor\.a = mix\( sampledDiffuseColor\.a, stickerSpec, alpha \)/,
    'the live specular mask enters base alpha before TF2 phong lighting',
  );
  const compositorSource = fs.readFileSync(path.join(ROOT, 'src', 'compositor', 'compositor.ts'), 'utf8');
  const stickerCase = compositorSource.slice(
    compositorSource.indexOf("case 'apply_sticker': {"),
    compositorSource.indexOf("case 'select':", compositorSource.indexOf("case 'apply_sticker': {") + 1),
  );
  assert.match(stickerCase, /u\.uSrgb2\.value = 0/, 'final sticker specular maps are sampled as linear material data');
  assert.match(
    appSource,
    /composeGroupStickerArtworkDataUrl\(\{[\s\S]*?selectorBase: selectorBase\.texture,[\s\S]*?endpointZero: endpointZero\.texture,[\s\S]*?endpointOne: endpointOne\.texture/,
    'the picker thumbnail is isolated from the same selector baseline and endpoints as the live previews',
  );
  assert.match(
    appSource,
    /selectorBaseSrc: activeGroupStickerResources\.selectorBaseUrl,[\s\S]*?endpointZeroSrc: activeGroupStickerResources\.endpointZeroUrl,[\s\S]*?endpointOneSrc: activeGroupStickerResources\.endpointOneUrl/,
    'the UV editor receives the same selector baseline and endpoints as the weapon preview',
  );
  const placementEditorSource = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'workbench', 'StickerPlacementEditor.tsx'), 'utf8');
  assert.match(
    placementEditorSource,
    /<GroupStickerUvPreview sources=\{groupPreview\} quad=\{quadValue\}/,
    'group stickers use a live UV renderer instead of their opening-position thumbnail',
  );
  assert.match(
    placementEditorSource,
    /selectionTargets\.map\(\(target, index\) =>[\s\S]*?target\.id !== activeSelectionId && target\.artworkSrc[\s\S]*?sticker-placement-editor-passive-item/,
    'deselected stickers remain visible on the UV surface',
  );
  assert.match(
    appSource,
    /artworkSrc: groupStickerArtwork\[target\.id\]\?\.url[\s\S]*?\?\? stickerTargetArtwork\[target\.id\]/,
    'selection targets carry both composed group artwork and ordinary sticker artwork',
  );
  assert.match(
    appSource,
    /renderStickerArtwork: !selectedStickerUsesComposedArtwork/,
    'the isolated group thumbnail is not rendered as a frozen UV sticker',
  );
  const groupUvSource = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'workbench', 'GroupStickerUvPreview.tsx'), 'utf8');
  assert.match(groupUvSource, /destinationUv = uDestTl/, 'the UV renderer samples endpoints at the current destination');
  assert.match(groupUvSource, /useLayoutEffect\(\(\) => \{\s*runtimeRef\.current\?\.draw\(quad\)/, 'destination changes redraw the retained UV renderer immediately');
  assert.doesNotMatch(groupUvSource, /toDataURL|drawImage/, 'live group movement does not create another PNG screenshot');
  assert.doesNotMatch(
    appSource,
    /groupStickerPreviewTextureReferences|prepareOpaqueTexturePreview/,
    'the editor never substitutes an arbitrary layer source for composed group artwork',
  );
  assert.doesNotMatch(appSource, /prepareIsolatedComposedStickerArtwork/, 'group movement no longer depends on a baked destination crop');
  assert.match(
    appSource,
    /suspended: stickerPlacementActive && selectedStickerUsesComposedArtwork/,
    'the normal compositor is suspended while the group-sticker surface owns the same full recipe',
  );
  assert.doesNotMatch(previewEffect, /composePreviewDataUrl/, 'one retained compositor result drives both 2D and 3D editor views');
  assert.match(
    appSource,
    /const undoEditorSynced = useCallback\(\(\) => \{\s*discardStickerDraft\(\);\s*undoEditor\(\);/,
    'undo discards the transient sticker draft before restoring authored coordinates',
  );
  assert.match(
    appSource,
    /const resetEditorSynced = useCallback\(\(\) => \{\s*discardStickerDraft\(\);\s*resetEditor\(\);/,
    'revert discards the transient sticker draft before restoring the baseline',
  );
  assert.match(
    appSource,
    /const draft = stickerDraftRef\.current;\s*if \(draft && authoredStickerQuad && stickerQuadsEqual\(draft, authoredStickerQuad\)\) \{\s*discardStickerDraft\(\);\s*\}/,
    'a settled local sticker draft remains visible until authored state catches up',
  );
});
