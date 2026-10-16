import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import { sanitizePackName } from '../../export/plan';
import { spliceProtoDefBundle } from '../../export/protoWrite';
import { classifyProtoDefFragment, normalizeProtoDefFragments } from '../../protodefs/jsonFragments';
import type { ProtoDefFragmentKind } from '../../protodefs/jsonFragments';
import type { ProtoDefJsonFragment, ProtoDefKitBundle } from '../../protodefs/types';
import { PACKAGE_PROTO_DEFS_PATH } from '../../protodefs/types';
import type { SourcePackage } from '../../source/contracts';
import { serializeProtoDefKitBundle } from './jsonExport';

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

/** One message of the bundle, as the JSON fragment file that carries it. */
interface KitFragment {
  kind: ProtoDefFragmentKind;
  defindex: number;
  name: string;
  text: string;
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

function kitFragments(bundle: ProtoDefKitBundle, requestedName?: string): KitFragment[] {
  const serialized = serializeProtoDefKitBundle(bundle, { name: requestedName }).fragments;
  const messages: { kind: ProtoDefFragmentKind; value: Record<string, unknown> }[] = [
    ...bundle.operations.map((value) => ({ kind: 'operation' as const, value })),
    ...bundle.itemDefinitions.map((value) => ({ kind: 'itemDefinition' as const, value })),
    { kind: 'definition', value: bundle.definition },
  ];
  // serializeProtoDefKitBundle emits exactly one fragment per message, in this order.
  return messages.map(({ kind, value }, index) => ({
    kind,
    defindex: defindex(value),
    name: serialized[index].name,
    text: serialized[index].text,
  }));
}

/** For each fragment, the package paths already holding a JSON file of the same kind and defindex. */
async function findJsonFragmentPaths(
  pkg: SourcePackage,
  fragments: readonly KitFragment[],
): Promise<string[][]> {
  const found: ProtoDefJsonFragment[] = [];
  for (const entry of pkg.entries.values()) {
    if (found.length >= MAX_FRAGMENT_ENTRIES) break;
    if (!entry.path.endsWith('.json') || entry.size > MAX_FRAGMENT_BYTES) continue;
    try {
      const text = new TextDecoder().decode(await pkg.read(entry.path));
      if (classifyProtoDefFragment(text)) found.push({ name: entry.path, text });
    } catch {
      // Unreadable or unrelated JSON is copied unchanged below.
    }
  }
  if (found.length === 0) return fragments.map(() => []);

  const normalized = normalizeProtoDefFragments(found);
  return fragments.map((fragment) => normalized
    .filter((entry) => entry.kind === fragment.kind && defindex(entry.value) === fragment.defindex)
    .map((entry) => entry.name));
}

/**
 * Rebuilds the mounted package as one ZIP while replacing only the selected
 * kit's edited definitions. Mounted entries are read lazily and added one at a
 * time, so exporting does not retain a second expanded copy of the package.
 */
export async function exportEditedPackage(
  bundle: ProtoDefKitBundle,
  options: ExportEditedPackageOptions = {},
): Promise<EditedPackageExport> {
  const pkg = options.package ?? null;
  const fragments = kitFragments(bundle, options.name);
  const replacements = new Map<string, Uint8Array | string>();
  const added = new Map<string, string>();

  if (pkg?.has(PACKAGE_PROTO_DEFS_PATH)) {
    const baseBytes = await pkg.read(PACKAGE_PROTO_DEFS_PATH);
    let result;
    try {
      result = spliceProtoDefBundle({
        baseBytes,
        bundle,
        mode: 'overwrite',
        targetDefindex: defindex(bundle.definition),
      });
    } catch {
      // A separately imported definition may be edited while another package
      // supplies the assets. In that case append it instead of modifying an
      // unrelated kit in the mounted container.
      result = spliceProtoDefBundle({ baseBytes, bundle, mode: 'append' });
    }
    replacements.set(PACKAGE_PROTO_DEFS_PATH, result.bytes);
  } else if (pkg) {
    const paths = await findJsonFragmentPaths(pkg, fragments);
    fragments.forEach((fragment, index) => {
      for (const path of paths[index]) replacements.set(path, fragment.text);
      if (paths[index].length === 0) added.set(`definitions/${fragment.name}`, fragment.text);
    });
  } else {
    for (const fragment of fragments) added.set(`definitions/${fragment.name}`, fragment.text);
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
