/**
 * Picks the texture shown while editing a sticker: the editor's stripped recipe
 * when it has one, otherwise the composed map.
 */
export function visibleStickerEditorMap<Texture>(
  composedMap: Texture | null,
  editorBaseMap: Texture | null,
): Texture | null {
  return editorBaseMap ?? composedMap;
}
