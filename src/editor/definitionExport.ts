import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import type { ProtoDefKitMessages } from '../protodefs/types';
import { sanitizePackName } from '../export/plan';
import { loadSnapshotContainer } from '../export/snapshot';
import { spliceProtoDefs } from '../export/protoWrite';
import { PACK_PROTO_DEFS_PATH } from '../export/definitions';
import { serializeProtoDefKitMessages } from './jsonExport';

export type EditorDownloadFormat = 'zip' | 'json' | 'vpd';

export interface DefinitionExportResult {
  blob: Blob;
  fileName: string;
}

function safeName(name: string | undefined): string {
  return sanitizePackName(name || 'warpaint');
}

async function editedContainer(
  kit: ProtoDefKitMessages,
  targetDefindex: number,
  overwrite: boolean,
): Promise<Uint8Array> {
  return spliceProtoDefs({
    baseBytes: await loadSnapshotContainer(),
    operation: kit.operation,
    definition: kit.definition,
    mode: overwrite ? 'overwrite' : 'append',
    targetDefindex: overwrite ? targetDefindex : undefined,
  }).bytes;
}

export async function exportEditorDefinition(
  kit: ProtoDefKitMessages,
  format: EditorDownloadFormat,
  targetDefindex: number,
  name?: string,
  overwrite = true,
): Promise<DefinitionExportResult> {
  const stem = safeName(name);
  if (format === 'vpd') {
    const bytes = await editedContainer(kit, targetDefindex, overwrite);
    const buffer = new Uint8Array(bytes).buffer;
    return {
      blob: new Blob([buffer], { type: 'application/octet-stream' }),
      fileName: `${stem}-edited.vpd`,
    };
  }

  const writer = new ZipWriter(new BlobWriter('application/zip'));
  try {
    if (format === 'zip') {
      await writer.add(PACK_PROTO_DEFS_PATH, new Uint8ArrayReader(await editedContainer(kit, targetDefindex, overwrite)));
    } else {
      const serialized = serializeProtoDefKitMessages(kit, { name });
      await writer.add(serialized.operation.name, new TextReader(serialized.operation.text));
      await writer.add(serialized.definition.name, new TextReader(serialized.definition.text));
    }
    return {
      blob: await writer.close(),
      fileName: `${stem}-edited-${format}.zip`,
    };
  } catch (cause) {
    await writer.close().catch(() => undefined);
    throw cause;
  }
}
