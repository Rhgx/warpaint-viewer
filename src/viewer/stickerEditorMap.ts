/**
 * Select the material texture visible while editing a sticker. The last full
 * compositor result is always retained, but a temporary stripped recipe takes
 * precedence until the editor explicitly releases it.
 */
export function visibleStickerEditorMap<Texture>(
  composedMap: Texture | null,
  editorBaseMap: Texture | null,
): Texture | null {
  return editorBaseMap ?? composedMap;
}
