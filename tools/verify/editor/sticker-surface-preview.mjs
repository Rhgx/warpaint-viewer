// Sticker 2D surface source contract check.
//
//   node tools/verify/editor/sticker-surface-preview.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILD_DIR = path.join(ROOT, 'staging', 'sticker-surface-preview-verify');

function bundleModule(entry, output) {
  fs.rmSync(output, { recursive: true, force: true });
  const viteEntry = fileURLToPath(import.meta.resolve('vite'));
  const distIndex = viteEntry.lastIndexOf(`${path.sep}dist${path.sep}`);
  const viteBin = path.join(viteEntry.slice(0, distIndex), 'bin', 'vite.js');
  if (distIndex < 0 || !fs.existsSync(viteBin)) throw new Error(`could not locate vite's bin from ${viteEntry}`);
  const result = spawnSync(
    process.execPath,
    [viteBin, 'build', '--ssr', entry, '--outDir', output, '--logLevel', 'warn'],
    { cwd: ROOT, stdio: 'inherit', shell: false },
  );
  if (result.status !== 0) throw new Error(`Vite could not bundle ${entry}.`);
  return pathToFileURL(path.join(output, `${path.basename(entry, '.ts')}.js`)).href;
}

try {
  const { preStickerSurface, recipeWithoutStickerOccurrence, resolvedGroupStickerContext } = await import(bundleModule('src/editor/stickerSurface.ts', path.join(BUILD_DIR, 'surface')));
  const { visibleStickerEditorMap } = await import(bundleModule('src/viewer/stickerEditorMap.ts', path.join(BUILD_DIR, 'map')));
  const nested = {
    type: 'combine_multiply',
    nodes: [
      { type: 'texture_lookup', texture: 'patterns/colour' },
      { type: 'select', groups: 'patterns/groups', select: [1] },
    ],
  };
  const stage = { nodes: [nested] };
  assert.equal(preStickerSurface(stage), nested, 'the complete nested pre-sticker tree is preserved');
  assert.equal(preStickerSurface({ nodes: [] }), null, 'a missing surface is not replaced with an invented preview');

  const firstSticker = {
    type: 'apply_sticker', stickers: [{ base: 'stickers/first' }],
    destTl: [0.1, 0.1], destTr: [0.2, 0.1], destBl: [0.1, 0.2], nodes: [{ type: 'texture_lookup', texture: 'base/first' }],
  };
  const secondSticker = {
    type: 'apply_sticker', stickers: [{ base: 'stickers/second' }],
    destTl: [0.6, 0.6], destTr: [0.7, 0.6], destBl: [0.6, 0.7], nodes: [{ type: 'texture_lookup', texture: 'base/second' }],
  };
  const completeRecipe = { type: 'combine_add', nodes: [firstSticker, secondSticker] };
  const withoutSecond = recipeWithoutStickerOccurrence(completeRecipe, 1);
  assert.ok(withoutSecond, 'a known sticker occurrence can be removed');
  assert.equal(withoutSecond.nodes[0], firstSticker, 'other sticker stages stay in the full recipe');
  assert.equal(withoutSecond.nodes[1], secondSticker.nodes[0], 'only the selected sticker is replaced by its base');
  assert.equal(recipeWithoutStickerOccurrence(completeRecipe, 2), null, 'a missing occurrence never returns a misleading base');

  const transform = {
    black: 0, white: 1, gamma: 1, rotationDeg: 0,
    translateU: 0, translateV: 0, scale: 1, flipU: false, flipV: false,
  };
  const rawSelector = { type: 'select', groups: 'groups', select: [16] };
  const siblingGroup = {
    type: 'apply_sticker', base: 'masks/sibling', destTl: [0, 0], destTr: [0.2, 0], destBl: [0, 0.2],
    black: 0, white: 1, gamma: 1, nodes: [rawSelector],
  };
  const movingGroup = {
    type: 'apply_sticker', base: 'masks/full-source', destTl: [0.2, 0.2], destTr: [0.4, 0.2], destBl: [0.2, 0.4],
    black: 0, white: 1, gamma: 1, nodes: [siblingGroup],
  };
  const groupRoot = {
    type: 'combine_lerp', ...transform,
    nodes: [
      { type: 'texture_lookup', texture: 'paint/base', ...transform },
      { type: 'texture_lookup', texture: 'paint/layer', ...transform },
      movingGroup,
    ],
  };
  const groupContext = resolvedGroupStickerContext(groupRoot, movingGroup);
  assert.ok(groupContext, 'a sticker in a lerp selector has a position-independent preview context');
  assert.equal(groupContext.base.nodes[2], siblingGroup, 'only the moving group is removed from the full base');
  assert.equal(groupContext.selectorBase, siblingGroup, 'other group stickers remain in the selector baseline');
  assert.match(groupContext.endpointZero.nodes[2].texture, /^data:image\/svg\+xml/, 'the zero endpoint replaces the complete selector');
  assert.match(groupContext.endpointOne.nodes[2].texture, /^data:image\/svg\+xml/, 'the one endpoint replaces the complete selector');
  const ordinarySticker = { ...movingGroup, base: 'stickers/logo', nodes: [groupRoot] };
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
    /recipeWithoutStickerOccurrence\(stickerRecipe\?\.tree \?\? null, selectedStickerTarget\.occurrence\)/,
    'the temporary base removes exactly the selected depth-first occurrence',
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
    /composeGroupStickerArtworkDataUrl\(\{[\s\S]*?selectorBase: selectorBase\.texture,[\s\S]*?endpointZero: endpointZero\.texture,[\s\S]*?endpointOne: endpointOne\.texture/,
    'the picker thumbnail is isolated from the same selector baseline and endpoints as the live previews',
  );
  assert.match(
    appSource,
    /selectorBaseSrc: preparedGroupStickerResources\.selectorBaseUrl,[\s\S]*?endpointZeroSrc: preparedGroupStickerResources\.endpointZeroUrl,[\s\S]*?endpointOneSrc: preparedGroupStickerResources\.endpointOneUrl/,
    'the UV editor receives the same selector baseline and endpoints as the weapon preview',
  );
  const placementEditorSource = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'workbench', 'StickerPlacementEditor.tsx'), 'utf8');
  assert.match(
    placementEditorSource,
    /<GroupStickerUvPreview sources=\{groupPreview\} quad=\{quadValue\}/,
    'group stickers use a live UV renderer instead of their opening-position thumbnail',
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
} finally {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
}

console.log('[verify] sticker surface preview source passed');
