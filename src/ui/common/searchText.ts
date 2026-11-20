/**
 * Normalizes user-facing item names and search queries so punctuation and
 * accents never block a match ("high rollers" -> "High Roller's",
 * "uber" -> "Übersaw", "claidheamh mor" -> "Claidheamh Mòr").
 */
function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function matchesSearch(text: string, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return true;
  if (text.toLowerCase().includes(trimmed)) return true;
  const normalizedQuery = normalizeSearchText(trimmed);
  if (!normalizedQuery) return false;
  return normalizeSearchText(text).includes(normalizedQuery);
}
