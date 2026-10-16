import type { OperationTemplateData, PaintkitEntry } from '../../data/types';
import { isCustomKitId } from '../../protodefs/types';

// Stock paints that use an operation whose name matches the query. An exact
// name match wins over substring matches, so "ao" finds only an operation
// named "ao" and not every name containing it. Imported kits never match: their
// ids are offset, and their usage must not be read from stock defindexes.
export function operationFilterKits(
  paintkits: readonly PaintkitEntry[],
  data: OperationTemplateData,
  query: string,
): PaintkitEntry[] {
  const text = query.trim().toLowerCase();
  if (!text) return [];
  const operations = Object.entries(data.names).map(([id, name]) => ({ id, name: name.toLowerCase() }));
  const exact = operations.filter((operation) => operation.name === text);
  const matches = exact.length > 0 ? exact : operations.filter((operation) => operation.name.includes(text));
  const users = new Set(matches.flatMap((operation) => data.usage[operation.id] ?? []));
  return paintkits.filter((kit) => !isCustomKitId(kit.id) && users.has(kit.id));
}
