/** Preserve authored UV precision while removing floating-point noise. */
export function formatStickerValue(value: number): string {
  return String(Number(value.toFixed(6)));
}
