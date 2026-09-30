import type { OperationMsg, OperationNodeMsg, VarDefMsg } from '../../protodefs/messages';
import type { OperationGraphParameterAddress } from './editing';
import type { OperationGraph, OperationGraphNode } from './types';

export function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isOperationNodeMessage(value: unknown): value is OperationNodeMsg {
  if (!isRecordValue(value)) return false;
  return (!('stage' in value) || isRecordValue(value.stage))
    && (!('operation_template' in value) || isRecordValue(value.operation_template));
}

function isOperationNodeCollection(value: unknown): value is OperationMsg['operation_node'] {
  if (value === undefined || isOperationNodeMessage(value)) return true;
  return Array.isArray(value) && value.every(isOperationNodeMessage);
}

/** Narrow the decoder's intentionally open operation record at the graph boundary. */
export function operationMessageForGraph(value: Record<string, unknown>): OperationMsg | null {
  const header = value.header;
  if (!isRecordValue(header) || typeof header.defindex !== 'number') return null;
  if (!isOperationNodeCollection(value.operation_node)) return null;
  const variables = varDefList(header.variables);
  return {
    header: {
      defindex: header.defindex,
      // Carried through so a binding onto an operation-scope variable can be
      // resolved, and edited, without leaving the graph.
      ...(variables.length > 0 ? { variables: Array.isArray(header.variables) ? variables : variables[0] } : {}),
    },
    ...(value.operation_node !== undefined ? { operation_node: value.operation_node } : {}),
  };
}

/** Declared variables from a message header, whatever Many<T> shape they use. */
export function varDefList(value: unknown): VarDefMsg[] {
  const list = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return list.filter((entry): entry is VarDefMsg => (
    isRecordValue(entry) && typeof entry.name === 'string' && entry.name.length > 0
  ));
}

const GRAPH_TEXTURE_EXTENSION = /\.(vtf|vmt|tga|psd|png|webp)$/i;

/**
 * The compositor addresses textures without the `materials/` prefix or an
 * extension, so both the shipped catalogue and an imported package have to be
 * folded back to that form before either can be offered as a choice.
 */
export function graphTextureRef(path: string): string | null {
  const trimmed = path.trim().replaceAll('\\', '/').replace(/^\/+/, '').toLowerCase();
  const withoutRoot = trimmed.replace(/^materials\//, '').replace(/^textures\//, '');
  const withoutExtension = withoutRoot.replace(GRAPH_TEXTURE_EXTENSION, '');
  return withoutExtension || null;
}

/** Every texture ref an operation graph already names, in authored order. */
export function operationGraphTextureRefs(graph: OperationGraph | null): string[] {
  if (!graph) return [];
  const refs: string[] = [];
  for (const node of graph.nodes) {
    const stage = node.raw?.stage;
    if (!stage) continue;
    const fields = [
      stage.texture_lookup?.texture,
      stage.texture_lookup?.texture_red,
      stage.texture_lookup?.texture_blue,
      stage.select?.groups,
    ];
    for (const field of fields) {
      if (field?.variable !== undefined || field?.string === undefined) continue;
      const ref = graphTextureRef(field.string);
      if (ref) refs.push(ref);
    }
  }
  return refs;
}

/** The variable a node's scalar parameter is bound to, if it is bound at all. */
export function boundOperationGraphVariable(
  graph: OperationGraph,
  nodeId: string,
  address: OperationGraphParameterAddress,
): string | undefined {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  const stage = node?.raw?.stage;
  if (!stage) return undefined;
  const container = stage.texture_lookup
    ?? stage.select
    ?? stage.combine_add
    ?? stage.combine_multiply
    ?? stage.combine_lerp
    ?? stage.apply_sticker;
  if (!isRecordValue(container)) return undefined;
  const field = container[address.field];
  return isRecordValue(field) && typeof field.variable === 'string' ? field.variable : undefined;
}

export function graphNodeOperationPath(node: OperationGraphNode): readonly string[] {
  return ['operation', ...node.sourcePath.map((segment) => String(segment))];
}
