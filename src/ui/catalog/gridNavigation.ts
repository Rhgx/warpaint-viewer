/** Computes the next kit id for vertical arrow navigation across grouped grids. */
export function stepGridVertical(
  groups: readonly (readonly [string, readonly { id: number }[]])[],
  selectedId: number | null,
  columns: number,
  direction: 'up' | 'down',
): number | null {
  const cols = Math.max(1, columns);
  if (groups.length === 0) return null;
  if (selectedId === null) {
    return groups[0]?.[1][0]?.id ?? null;
  }

  let groupIndex = -1;
  let itemIndex = -1;
  for (let g = 0; g < groups.length; g += 1) {
    const idx = groups[g][1].findIndex((kit) => kit.id === selectedId);
    if (idx >= 0) {
      groupIndex = g;
      itemIndex = idx;
      break;
    }
  }
  if (groupIndex < 0) return groups[0]?.[1][0]?.id ?? null;

  const kits = groups[groupIndex][1];
  const col = itemIndex % cols;
  const row = Math.floor(itemIndex / cols);
  const lastRow = Math.floor((kits.length - 1) / cols);

  if (direction === 'down') {
    if (itemIndex + cols < kits.length) return kits[itemIndex + cols].id;
    if (row < lastRow) return kits[kits.length - 1].id;
    if (groupIndex + 1 < groups.length) {
      const nextKits = groups[groupIndex + 1][1];
      return nextKits[Math.min(col, nextKits.length - 1)]?.id ?? selectedId;
    }
    return selectedId;
  }

  if (itemIndex - cols >= 0) return kits[itemIndex - cols].id;
  if (groupIndex > 0) {
    const prevKits = groups[groupIndex - 1][1];
    const prevLastRowStart = Math.floor((prevKits.length - 1) / cols) * cols;
    return prevKits[Math.min(prevLastRowStart + col, prevKits.length - 1)]?.id ?? selectedId;
  }
  return selectedId;
}
