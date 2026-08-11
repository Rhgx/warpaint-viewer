import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import { sanitizePackName } from '../export/plan';
import { spliceProtoDefs } from '../export/protoWrite';
import { classifyProtoDefFragment, normalizeProtoDefFragments } from '../protodefs/jsonFragments';
import type { ProtoDefJsonFragment, ProtoDefKitMessages } from '../protodefs/types';
import { PACKAGE_PROTO_DEFS_PATH } from '../protodefs/types';
import type { SourcePackage } from '../source/contracts';
import { serializeProtoDefKitMessages } from './jsonExport';

const MAX_FRAGMENT_ENTRIES = 128;
const MAX_FRAGMENT_BYTES = 8 * 1024 * 1024;

export interface EditedPackageExport {
  blob: Blob;
  fileName: string;
  replacedPaths: readonly string[];
  addedPaths: readonly string[];
}

export interface ExportEditedPackageOptions {
  package?: SourcePackage | null;
  name?: string;
}

function defindex(value: Record<string, unknown>): number {
  const header = value.header as Record<string, unknown> | undefined;
  const index = header?.defindex;
  if (typeof index !== 'number' || !Number.isSafeInteger(index)) {
    throw new Error('The edited definition has no valid numeric definition index.');
  }
  return index;
}

function downloadName(pkg: SourcePackage | null | undefined, requestedName?: string): string {
  const source = pkg?.name.replace(/\.(?:zip|vpk)$/i, '') || requestedName || 'warpaint';
  return `${sanitizePackName(source)}-edited.zip`;
}

async function findJsonFragmentPaths(
  pkg: SourcePackage,
  operationDefindex: number,
  definitionDefindex: number,
): Promise<{ operation: string[]; definition: string[] }> {
  const fragments: ProtoDefJsonFragment[] = [];
  for (const entry of pkg.entries.values()) {
    if (fragments.length >= MAX_FRAGMENT_ENTRIES) break;
    if (!entry.path.endsWith('.json') || entry.size > MAX_FRAGMENT_BYTES) continue;
    try {
      const text = new TextDecoder().decode(await pkg.read(entry.path));
      if (classifyProtoDefFragment(text)) fragments.push({ name: entry.path, text });
    } catch {
      // Unreadable or unrelated JSON is copied unchanged below.
    }
  }
  if (fragments.length === 0) return { operation: [], definition: [] };

  const normalized = normalizeProtoDefFragments(fragments);
  return {
    operation: normalized
      .filter((fragment) => fragment.kind === 'operation' && defindex(fragment.value) === operationDefindex)
      .map((fragment) => fragment.name),
    definition: normalized
      .filter((fragment) => fragment.kind === 'definition' && defindex(fragment.value) === definitionDefindex)
      .map((fragment) => fragment.name),
  };
}

/**
 * Rebuilds the mounted package as one ZIP while replacing only the selected
 * kit's edited definitions. Mounted entries are read lazily and added one at a
 * time, so exporting does not retain a second expanded copy of the package.
 */
export async function exportEditedPackage(
  kit: ProtoDefKitMessages,
  options: ExportEditedPackageOptions = {},
): Promise<EditedPackageExport> {
  const pkg = options.package ?? null;
  const serialized = serializeProtoDefKitMessages(kit, { name: options.name });
  const operationDefindex = defindex(kit.operation);
  const definitionDefindex = defindex(kit.definition);
  const replacements = new Map<string, Uint8Array | string>();
  const added = new Map<string, string>();

  if (pkg?.has(PACKAGE_PROTO_DEFS_PATH)) {
    const baseBytes = await pkg.read(PACKAGE_PROTO_DEFS_PATH);
    let result;
    try {
      result = spliceProtoDefs({
        baseBytes,
        operation: kit.operation,
        definition: kit.definition,
        mode: 'overwrite',
        targetDefindex: definitionDefindex,
      });
    } catch {
      // A separately imported definition may be edited while another package
      // supplies the assets. In that case append it instead of modifying an
      // unrelated kit in the mounted container.
      result = spliceProtoDefs({
        baseBytes,
        operation: kit.operation,
        definition: kit.definition,
        mode: 'append',
      });
    }
    replacements.set(PACKAGE_PROTO_DEFS_PATH, result.bytes);
  } else if (pkg) {
    const paths = await findJsonFragmentPaths(pkg, operationDefindex, definitionDefindex);
    for (const path of paths.operation) replacements.set(path, serialized.operation.text);
    for (const path of paths.definition) replacements.set(path, serialized.definition.text);
    if (paths.operation.length === 0) added.set(`definitions/${serialized.operation.name}`, serialized.operation.text);
    if (paths.definition.length === 0) added.set(`definitions/${serialized.definition.name}`, serialized.definition.text);
  } else {
    added.set(`definitions/${serialized.operation.name}`, serialized.operation.text);
    added.set(`definitions/${serialized.definition.name}`, serialized.definition.text);
  }

  const writer = new ZipWriter(new BlobWriter('application/zip'));
  try {
    if (pkg) {
      for (const entry of [...pkg.entries.values()].sort((left, right) => left.path.localeCompare(right.path))) {
        const replacement = replacements.get(entry.path);
        if (typeof replacement === 'string') await writer.add(entry.path, new TextReader(replacement));
        else await writer.add(entry.path, new Uint8ArrayReader(replacement ?? await pkg.read(entry.path)));
      }
    }
    for (const [path, text] of added) await writer.add(path, new TextReader(text));
    return {
      blob: await writer.close(),
      fileName: downloadName(pkg, options.name),
      replacedPaths: [...replacements.keys()],
      addedPaths: [...added.keys()],
    };
  } catch (cause) {
    await writer.close().catch(() => undefined);
    throw cause;
  }
}
