// Container decoding: defType message mapping, the cached schema root and raw block decode.
import { Root } from 'protobufjs/light';
import type { INamespace, Type } from 'protobufjs/light';

import { parseContainer } from './container';
import type { ItemDefinitionMsg, OperationMsg, PaintkitDefinitionMsg } from './messages';
import schemaJson from './schema.generated.json';

// Container defType values (tools/lib/proto.mjs DEF_TYPE / MSG_FOR_DEFTYPE).

const DEF_TYPE = {
  PAINTKIT_OPERATION: 7,
  PAINTKIT_ITEM_DEFINITION: 8,
  PAINTKIT_DEFINITION: 9,
} as const;

const MSG_FOR_DEFTYPE: Record<number, string> = {
  6: 'CMsgPaintKit_Variables',
  7: 'CMsgPaintKit_Operation',
  8: 'CMsgPaintKit_ItemDefinition',
  9: 'CMsgPaintKit_Definition',
};

// toObject() runs with arrays: false, so a repeated field with one entry decodes to the
// bare value. Many<T> models that, and many() restores an array.
const TO_OBJECT_OPTIONS = {
  longs: Number, enums: Number, bytes: String, defaults: false, arrays: false, objects: false,
};

let cachedRoot: Root | null = null;

function loadRoot(): Root {
  if (cachedRoot) return cachedRoot;
  cachedRoot = Root.fromJSON(schemaJson as unknown as INamespace);
  return cachedRoot;
}

function decodeType<T>(root: Root, byType: Record<number, { buffer: Uint8Array }[]>, defType: number): T[] {
  const typeName = MSG_FOR_DEFTYPE[defType];
  if (!typeName) throw new Error(`No message mapping for defType ${defType}`);
  const Msg: Type = root.lookupType(typeName);
  const list = byType[defType] ?? [];
  const out: T[] = [];
  for (const { buffer } of list) {
    const decoded = Msg.decode(buffer);
    out.push(Msg.toObject(decoded, TO_OBJECT_OPTIONS) as T);
  }
  return out;
}

// Raw decoded blocks, before definitions are resolved into kits. Shared by the .vpd path
// (every defType) and the JSON path (defTypes 7 and 8 from the base, 9 from fragments).
export interface RawDecoded {
  operations: OperationMsg[];
  itemDefs: ItemDefinitionMsg[];
  defs: PaintkitDefinitionMsg[];
  countsByType: Record<number, number>;
}

export function decodeBaseContainer(bytes: Uint8Array): RawDecoded {
  const root = loadRoot();
  const { byType } = parseContainer(bytes);

  const countsByType: Record<number, number> = {};
  for (const [defType, list] of Object.entries(byType)) countsByType[Number(defType)] = list.length;

  return {
    operations: decodeType<OperationMsg>(root, byType, DEF_TYPE.PAINTKIT_OPERATION),
    itemDefs: decodeType<ItemDefinitionMsg>(root, byType, DEF_TYPE.PAINTKIT_ITEM_DEFINITION),
    defs: decodeType<PaintkitDefinitionMsg>(root, byType, DEF_TYPE.PAINTKIT_DEFINITION),
    countsByType,
  };
}
