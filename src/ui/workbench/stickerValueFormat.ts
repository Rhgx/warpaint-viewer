/** Preserve authored UV precision while removing floating-point noise. */
export function formatStickerValue(value: number): string {
  const roundedValue = Number(value.toFixed(6));
  return Object.is(roundedValue, -0) ? '0' : String(roundedValue);
}
