import type { ItemDefinitionMsg, OperationMsg } from './messages';

/** Lookup tables shared by recipe and slot resolution. */
export interface ResolveCtx {
  opByIdx: Map<number, OperationMsg>;
  itemDefByIdx: Map<number, ItemDefinitionMsg>;
}

export function buildResolveCtx(operations: OperationMsg[], itemDefs: ItemDefinitionMsg[]): ResolveCtx {
  const opByIdx = new Map<number, OperationMsg>();
  for (const operation of operations) opByIdx.set(operation.header.defindex, operation);
  const itemDefByIdx = new Map<number, ItemDefinitionMsg>();
  for (const item of itemDefs) itemDefByIdx.set(item.header.defindex, item);
  return { opByIdx, itemDefByIdx };
}
