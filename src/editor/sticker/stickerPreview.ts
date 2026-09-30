import type { ComposeResult } from '../../compositor/compositor';
import type { StickerTransformTool } from '../../ui/editor/StickerPlacementEditor';
import type { Viewer } from '../../viewer/Viewer';
import type { StickerPlacementQuad } from './viewerStickerPlacement';

interface StickerPreviewOptions {
  /** Set for a group sticker: its mask and cached selector endpoints move as uniforms. */
  groupResources: {
    maskUrl: string;
    selectorBase: ComposeResult;
    endpointZero: ComposeResult;
    endpointOne: ComposeResult;
    levels: readonly [number, number, number];
  } | null;
  textureUrl: string;
  specularUrl: string | null;
  tool: StickerTransformTool;
}

/** Draws the live sticker decal on the model: a group sticker from its cached resources, an ordinary one from its texture. */
export function showStickerPreview(
  viewer: Viewer | null | undefined,
  quad: StickerPlacementQuad,
  { groupResources, textureUrl, specularUrl, tool }: StickerPreviewOptions,
) {
  if (groupResources) {
    viewer?.setGroupStickerPreview(groupResources.maskUrl, {
      selectorBase: groupResources.selectorBase.texture,
      endpointZero: groupResources.endpointZero.texture,
      endpointOne: groupResources.endpointOne.texture,
      levels: groupResources.levels,
    }, quad, { tool });
    return;
  }
  viewer?.setStickerPreview(textureUrl, quad, { tool, specularUrl });
}
