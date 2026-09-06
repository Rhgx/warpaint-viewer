/**
 * Fetches the game-data snapshots the definition builder splices into.
 *
 * These are big (a 9.4 MB container, plus a 140 KB localization file per
 * language) and only the export builder ever wants them, so nothing is
 * requested until someone actually builds a pack. Both are byte-for-byte copies
 * of the files a TF2 install has, emitted by tools/extract/warpaints.mjs and stamped in
 * the manifest with the build they came from.
 *
 * Anyone on a newer TF2 build can hand over their own files instead, which is
 * the escape hatch for the one real hazard here: a pack built from a stale
 * snapshot shadows the player's newer copy and hides anything Valve added since.
 */

const DATA_ROOT = `${import.meta.env.BASE_URL}data`;

const SNAPSHOT_CONTAINER_URL = `${DATA_ROOT}/protodefs-full.bin`;

function snapshotLocalizationUrl(language: string): string {
  return `${DATA_ROOT}/protodefs-loc/${language}.txt`;
}

async function fetchBytes(url: string, description: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`The ${description} could not be loaded (${response.status}). Supply your own file instead.`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

let containerPromise: Promise<Uint8Array> | null = null;

/** The shipped proto_defs container, fetched once per session. */
export function loadSnapshotContainer(): Promise<Uint8Array> {
  if (!containerPromise) {
    containerPromise = fetchBytes(SNAPSHOT_CONTAINER_URL, 'base war paint definitions').catch((cause: unknown) => {
      containerPromise = null;
      throw cause;
    });
  }
  return containerPromise;
}

const localizationCache = new Map<string, Promise<Uint8Array>>();

function loadSnapshotLocalization(language: string): Promise<Uint8Array> {
  const cached = localizationCache.get(language);
  if (cached) return cached;
  const promise = fetchBytes(snapshotLocalizationUrl(language), `${language} name list`).catch((cause: unknown) => {
    localizationCache.delete(language);
    throw cause;
  });
  localizationCache.set(language, promise);
  return promise;
}

/**
 * Every language TF2 ships a paint-name file for. A pack that only carries
 * english leaves the paint unnamed for anyone running the game in another
 * language, and the files are small enough that carrying all of them is
 * cheaper than explaining the choice.
 */
const SNAPSHOT_LANGUAGES = [
  'brazilian', 'bulgarian', 'czech', 'danish', 'dutch', 'english', 'finnish', 'french',
  'german', 'greek', 'hungarian', 'italian', 'korean', 'koreana', 'latam', 'norwegian',
  'polish', 'portuguese', 'romanian', 'russian', 'schinese', 'spanish', 'swedish',
  'tchinese', 'thai', 'turkish', 'ukrainian',
] as const;

export async function loadSnapshotLocalizations(
  languages: readonly string[] = SNAPSHOT_LANGUAGES,
): Promise<Map<string, Uint8Array>> {
  const loaded = new Map<string, Uint8Array>();
  const results = await Promise.allSettled(
    languages.map(async (language) => [language, await loadSnapshotLocalization(language)] as const),
  );
  for (const result of results) {
    if (result.status === 'fulfilled') loaded.set(result.value[0], result.value[1]);
  }
  return loaded;
}
