import type { HeaderMsg, ItemDefinitionMsg, OperationMsg } from './messages';

/** Lookup tables shared by recipe and slot resolution. */
export interface ResolveCtx {
  opByIdx: Map<number, OperationMsg>;
  itemDefByIdx: Map<number, ItemDefinitionMsg>;
  varByIdx: Map<number, { header: HeaderMsg }>;
}

export function buildResolveCtx(
  operations: OperationMsg[],
  itemDefs: ItemDefinitionMsg[],
  variables: { header: HeaderMsg }[],
): ResolveCtx {
  const opByIdx = new Map<number, OperationMsg>();
  for (const operation of operations) opByIdx.set(operation.header.defindex, operation);
  const itemDefByIdx = new Map<number, ItemDefinitionMsg>();
  for (const item of itemDefs) itemDefByIdx.set(item.header.defindex, item);
  const varByIdx = new Map<number, { header: HeaderMsg }>();
  for (const variable of variables) varByIdx.set(variable.header.defindex, variable);
  return { opByIdx, itemDefByIdx, varByIdx };
}
