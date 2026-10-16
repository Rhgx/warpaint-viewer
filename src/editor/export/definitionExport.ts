import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import type { ProtoDefKitBundle } from '../../protodefs/types';
import { sanitizePackName } from '../../export/plan';
import { loadSnapshotContainer } from '../../export/snapshot';
import { spliceProtoDefBundle } from '../../export/protoWrite';
import { PACK_PROTO_DEFS_PATH } from '../../export/definitions';
import { serializeProtoDefKitBundle } from './jsonExport';

export type EditorDownloadFormat = 'zip' | 'json' | 'vpd';

export interface DefinitionExportResult {
  blob: Blob;
  fileName: string;
}

function safeName(name: string | undefined): string {
  return sanitizePackName(name || 'warpaint');
}

async function editedContainer(
  bundle: ProtoDefKitBundle,
  targetDefindex: number,
  overwrite: boolean,
): Promise<Uint8Array> {
  return spliceProtoDefBundle({
    baseBytes: await loadSnapshotContainer(),
    bundle,
    mode: overwrite ? 'overwrite' : 'append',
    targetDefindex: overwrite ? targetDefindex : undefined,
  }).bytes;
}

export async function exportEditorDefinition(
  bundle: ProtoDefKitBundle,
  format: EditorDownloadFormat,
  targetDefindex: number,
  name?: string,
  overwrite = true,
): Promise<DefinitionExportResult> {
  const stem = safeName(name);
  if (format === 'vpd') {
    const bytes = await editedContainer(bundle, targetDefindex, overwrite);
    const buffer = new Uint8Array(bytes).buffer;
    return {
      blob: new Blob([buffer], { type: 'application/octet-stream' }),
      fileName: `${stem}-edited.vpd`,
    };
  }

  const writer = new ZipWriter(new BlobWriter('application/zip'));
  try {
    if (format === 'zip') {
      await writer.add(PACK_PROTO_DEFS_PATH, new Uint8ArrayReader(await editedContainer(bundle, targetDefindex, overwrite)));
    } else {
      for (const fragment of serializeProtoDefKitBundle(bundle, { name }).fragments) {
        await writer.add(fragment.name, new TextReader(fragment.text));
      }
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
