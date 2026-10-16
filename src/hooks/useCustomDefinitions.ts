import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Manifest, OperationTemplateData, PaintkitEntry, Team } from '../data/types';
import type { RecipeNode } from '../compositor/types';
import type { SourceDiagnostic } from '../source/contracts';
import type { SourceTextureProvider } from '../source/provider';
import { sourceTextureCandidates } from '../source/paths';
import {
  CUSTOM_KIT_COLLECTION,
  PACKAGE_PROTO_DEFS_PATH,
  customKitDefindex,
  customKitId,
} from '../protodefs/types';
import type {
  CustomDefinitionKitRow,
  ProtoDefKitBundle,
  ProtoDefKitMessages,
  CustomDefinitionsState,
  ProtoDefIndex,
  ProtoDefJsonFragment,
  ProtoDefKit,
  ProtoDefKitWeaponSlot,
  ProtoDefOpenOptions,
  ProtoDefRecipeWithProvenance,
  ProtoDefSource,
} from '../protodefs/types';
import { classifyProtoDefFragment } from '../protodefs/jsonFragments';
import {
  buildCopiedWarPaint,
  buildTemplateWarPaint,
  definitionSetName,
  generatedPaintDefindex,
  nextWarPaintIds,
  operationDefindexesIn,
  renameGeneratedPaint,
  withoutGeneratedPaint,
} from '../protodefs/templatePaint';
import { loadOperationTemplates } from '../data/loader';
import { appErrorDiagnostic, ERROR_CODES } from '../errors';
import { topLevelMessages } from '../editor/kitBundle';
import { applyImplicitStickerSpecs } from '../protodefs/implicitStickerSpecs';
import { partitionResolvableKits } from '../protodefs/validation';
import {
  deleteCustomSourceFiles,
  readCustomSourceFiles,
  writeCustomSourceFiles,
} from '../editor/draftStorage';

// A stock container is under 10 MB. The cap only exists so a mis-picked file
// cannot be read into memory in its entirety before it is rejected.
const MAX_DEFINITION_BYTES = 64 * 1024 * 1024;
// Community packs ship their definitions as two JSON fragments beside the
// textures. Both bounds only exist so scanning a large archive for them cannot
// turn into reading the whole thing.
const MAX_FRAGMENT_BYTES = 8 * 1024 * 1024;
const MAX_FRAGMENT_ENTRIES = 24;

export interface CustomDefinitions {
  /** Selecting a kit is the app's business, so the view supplies onSelectKit. */
  state: Omit<CustomDefinitionsState, 'onSelectKit'>;
  /** Loaded definitions, shaped for the catalog alongside the built-in kits. */
  catalogKits: PaintkitEntry[];
  /** Thumbnail URLs by catalog id, resolved through the mounted package. */
  icons: Record<number, string>;
  getRecipe: (kitId: number, weaponKey: string, team: Team, wearIndex: number) => Promise<RecipeNode | null>;
  /** Resolve the selected imported recipe while retaining editable field sources. */
  getRecipeWithProvenance: (
    kitId: number,
    weaponKey: string,
    team: Team,
    wearIndex: number,
  ) => Promise<ProtoDefRecipeWithProvenance | null>;
  /** An imported kit's definition and operation, for the export builder. Null for a per-wear paint. */
  exportKit: (kitId: number) => Promise<ProtoDefKitMessages | null>;
  /** An imported kit's definition, operations, and item definitions, for the editor and JSON export. */
  exportKitBundle: (kitId: number) => Promise<ProtoDefKitBundle | null>;
  /** An imported kit's weapon slots, resolved to weapon key and authored path. */
  exportKitWeaponSlots: (kitId: number) => Promise<ProtoDefKitWeaponSlot[] | null>;
  /** Replace one imported kit with an in-memory JSON-backed editor preview. */
  previewKitBundle: (kitId: number, bundle: ProtoDefKitBundle) => Promise<void>;
  /** Return recipe/export resolution to the originally imported container. */
  clearPreviewKit: () => void;
  /** Bumped whenever the active editor preview changes or is cleared. */
  editGeneration: number;
  /** Catalog id to select after an import, changing only when a new one lands. */
  suggestedKitId: number | undefined;
  /** Bumped by every successful open, so repeat imports are distinguishable. */
  generation: number;
}

interface UseCustomDefinitionsOptions {
  manifest: Manifest | null;
  getAssetUrl: (rel: string) => string | null;
  provider: SourceTextureProvider;
  packageGeneration: number;
}

interface LoadedFile {
  name: string;
  index: ProtoDefIndex;
  source: ProtoDefSource;
  /** The JSON fragments this set was opened from; undefined for a whole container. */
  fragments?: ProtoDefJsonFragment[];
}

interface EditedKit {
  kitId: number;
  source: ProtoDefSource;
  bundle: ProtoDefKitBundle;
}

interface FragmentOpenOptions {
  preferredDefindex?: number;
  /** False leaves the current selection alone (delete), instead of suggesting a kit. */
  suggest?: boolean;
}

function diagnostic(level: SourceDiagnostic['level'], message: string, detail?: string): SourceDiagnostic {
  return { id: `defs:${level}:${message}:${detail ?? ''}`, level, message, detail };
}

function errorDiagnostic(cause: unknown): SourceDiagnostic {
  return appErrorDiagnostic(cause, {
    code: ERROR_CODES.definitionImportFailed,
    message: 'The definitions could not be imported.',
    idPrefix: 'defs:import',
  });
}

function toCatalogKit(kit: ProtoDefKit): PaintkitEntry {
  return {
    id: customKitId(kit.defindex),
    name: kit.name,
    collection: CUSTOM_KIT_COLLECTION,
    hasTeamTextures: kit.hasTeamTextures,
    weapons: kit.weapons,
    perWear: kit.perWear,
    ...(kit.materialOverrides ? { materialOverrides: kit.materialOverrides } : {}),
  };
}

/**
 * Owns one imported proto_defs container: the definitions it contains, which of
 * them are in the catalog, and the recipes resolved out of it. Imported source
 * files are retained locally so a reload can rebuild the same container.
 */
export function useCustomDefinitions({
  manifest,
  getAssetUrl,
  provider,
  packageGeneration,
}: UseCustomDefinitionsOptions): CustomDefinitions {
  const [status, setStatus] = useState<CustomDefinitionsState['status']>('empty');
  const [loaded, setLoaded] = useState<LoadedFile | null>(null);
  const [fileName, setFileName] = useState<string | undefined>();
  const [diagnostics, setDiagnostics] = useState<SourceDiagnostic[]>([]);
  const [loadedDefindexes, setLoadedDefindexes] = useState<number[]>([]);
  const [quarantinedDefindexes, setQuarantinedDefindexes] = useState<number[]>([]);
  const [icons, setIcons] = useState<Record<number, string>>({});
  const [suggestedKitId, setSuggestedKitId] = useState<number | undefined>();
  const [generation, setGeneration] = useState(0);
  const [editGeneration, setEditGeneration] = useState(0);
  // Imports are cancelled by a newer import or a removal, exactly like the
  // Source package's transactional mount.
  const importOperationRef = useRef(0);
  const loadedRef = useRef<LoadedFile | null>(null);
  const editedRef = useRef<EditedKit | null>(null);
  const editOperationRef = useRef(0);
  const weaponsByItemDefRef = useRef<Promise<Record<string, string>> | null>(null);
  const baseDefsRef = useRef<Promise<Uint8Array> | null>(null);
  const recipeCacheRef = useRef(new Map<string, Promise<RecipeNode | null>>());

  const textureKeys = manifest?.textures;

  const release = useCallback(() => {
    editOperationRef.current += 1;
    editedRef.current?.source.dispose();
    editedRef.current = null;
    loadedRef.current?.source.dispose();
    loadedRef.current = null;
    recipeCacheRef.current.clear();
  }, []);

  useEffect(() => release, [release]);

  // The implicit sticker spec and the thumbnails both depend on what the
  // mounted package answers for a path, so a mount or removal invalidates them.
  useEffect(() => { recipeCacheRef.current.clear(); }, [packageGeneration]);

  const packageHas = useCallback((ref: string): boolean => {
    const pkg = provider.package;
    if (!pkg) return false;
    try {
      return sourceTextureCandidates(ref).some((candidate) => pkg.has(candidate));
    } catch {
      return false;
    }
  }, [provider]);

  const hasTexture = useCallback(
    (ref: string): boolean => Boolean(textureKeys?.[ref]) || packageHas(ref),
    [textureKeys, packageHas],
  );

  const loadWeaponsByItemDef = useCallback((): Promise<Record<string, string>> => {
    const cached = weaponsByItemDefRef.current;
    if (cached) return cached;
    const url = getAssetUrl('item-defs.json');
    const pending = (async () => {
      if (!url) throw new Error('This data source has no item definition map.');
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Could not load the item definition map (${response.status}).`);
      return (await response.json()) as Record<string, string>;
    })();
    weaponsByItemDefRef.current = pending;
    // A failed fetch must not poison every later import attempt.
    pending.catch(() => { weaponsByItemDefRef.current = null; });
    return pending;
  }, [getAssetUrl]);

  // Community JSON fragments reference stock operations and item definition
  // templates by index, so they only resolve on top of the base game's
  // definitions. That blob is a fraction of a full container and is fetched
  // once, the first time someone imports fragments.
  const loadBaseDefs = useCallback((): Promise<Uint8Array> => {
    const cached = baseDefsRef.current;
    if (cached) return cached;
    const url = getAssetUrl('protodefs-base.bin');
    const pending = (async () => {
      if (!url) throw new Error('This data source has no base war paint definitions.');
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Could not load the base war paint definitions (${response.status}).`);
      return new Uint8Array(await response.arrayBuffer());
    })();
    baseDefsRef.current = pending;
    pending.catch(() => { baseDefsRef.current = null; });
    return pending;
  }, [getAssetUrl]);

  const openWith = useCallback(async (
    name: string,
    run: (source: ProtoDefSource, options: ProtoDefOpenOptions) => Promise<ProtoDefIndex>,
    extras: FragmentOpenOptions & { fragments?: ProtoDefJsonFragment[] } = {},
  ): Promise<boolean> => {
    const operation = ++importOperationRef.current;
    setStatus('importing');
    setFileName(name);
    setDiagnostics([]);
    try {
      const [{ createProtoDefSource }, weaponsByItemDef] = await Promise.all([
        import('../protodefs/client'),
        loadWeaponsByItemDef(),
      ]);
      const source = createProtoDefSource();
      const index = await run(source, {
        weaponsByItemDef,
        builtInIds: manifest?.paintkits.map((kit) => kit.id) ?? [],
      });
      if (operation !== importOperationRef.current) { source.dispose(); return false; }

      const candidates = index.kits.filter((kit) => kit.isNew && kit.weapons.length > 0);
      const { loadable: newKits, quarantined } = await partitionResolvableKits(source, candidates);
      if (operation !== importOperationRef.current) { source.dispose(); return false; }

      release();
      loadedRef.current = { name, index, source, fragments: extras.fragments };
      setLoaded(loadedRef.current);

      setLoadedDefindexes(newKits.map((kit) => kit.defindex));
      setQuarantinedDefindexes(quarantined.map((kit) => kit.defindex));
      setStatus('loaded');
      setGeneration((current) => current + 1);
      const suggested = extras.suggest === false
        ? undefined
        : newKits.find((kit) => kit.defindex === extras.preferredDefindex) ?? newKits[0];
      setSuggestedKitId(suggested ? customKitId(suggested.defindex) : undefined);

      const notes: SourceDiagnostic[] = [];
      const unsupported = index.kits.filter((kit) => kit.weapons.length === 0).length;
      if (index.kits.length === 0) {
        notes.push(diagnostic('error', 'This file contains no war paint definitions.', name));
      } else if (newKits.length === 0 && unsupported === 0 && quarantined.length === 0) {
        notes.push(diagnostic(
          'warning',
          'Every definition in this file matches a built-in war paint index, so none were added automatically. Load one below to use the imported version.',
        ));
      }
      if (unsupported > 0) {
        notes.push(diagnostic(
          'warning',
          `${unsupported.toLocaleString()} ${unsupported === 1 ? 'definition uses' : 'definitions use'} a weapon this viewer has no model for.`,
        ));
      }
      if (quarantined.length > 0) {
        notes.push(diagnostic(
          'warning',
          `${quarantined.length.toLocaleString()} ${quarantined.length === 1 ? 'definition could' : 'definitions could'} not produce a paint recipe and ${quarantined.length === 1 ? 'was' : 'were'} not loaded.`,
          'Use Remove to discard the saved source files, or Replace to import corrected files.',
        ));
      }
      const teamButtonsHidden = index.kits.filter((kit) => kit.teamButtonsHidden);
      for (const kit of teamButtonsHidden) {
        notes.push(diagnostic(
          'info',
          `${kit.name} changes per team, but has_team_textures is off, so the in-game inspect panel will not show its team buttons.`,
          'Set has_team_textures to true to show them. Matches still use the RED and BLU textures either way.',
        ));
      }
      if (!provider.package) {
        notes.push(diagnostic(
          'info',
          'Mount a Source package on the Package tab to supply the textures these definitions ask for.',
        ));
      }
      setDiagnostics(notes);
      return true;
    } catch (cause) {
      if (operation !== importOperationRef.current) return false;
      setStatus(loadedRef.current ? 'loaded' : 'empty');
      setFileName(loadedRef.current?.name);
      setDiagnostics([errorDiagnostic(cause)]);
      return false;
    }
  }, [loadWeaponsByItemDef, manifest, provider, release]);

  const openContainer = useCallback((name: string, bytes: Uint8Array) => openWith(name, (source, options) => {
    if (bytes.byteLength > MAX_DEFINITION_BYTES) {
      throw new Error('Definition files must be 64 MB or smaller.');
    }
    return source.open(bytes, options);
  }), [openWith]);

  const openFragments = useCallback((
    name: string,
    fragments: ProtoDefJsonFragment[],
    options: FragmentOpenOptions = {},
  ) => openWith(
    name,
    async (source, openOptions) => source.openJsonFragments(await loadBaseDefs(), fragments, openOptions),
    { fragments, ...options },
  ), [openWith, loadBaseDefs]);

  // Reopens a JSON set and saves its files. The set keeps its name whatever
  // generated paints it holds (see definitionSetName), so drafts stay valid.
  const reopenFragments = useCallback(async (
    fragments: ProtoDefJsonFragment[],
    options: FragmentOpenOptions = {},
  ): Promise<boolean> => {
    const opened = await openFragments(definitionSetName(fragments.map((fragment) => fragment.name)), fragments, options);
    if (!opened) return false;
    try {
      await writeCustomSourceFiles('definitions', fragments.map((fragment) => (
        new File([fragment.text], fragment.name, { type: 'application/json' })
      )));
    } catch {
      setDiagnostics((entries) => [
        ...entries,
        diagnostic(
          'warning',
          'The war paint is loaded, but the definitions could not be saved locally.',
          'Keep the original definition files before reloading or closing this page.',
        ),
      ]);
    }
    return true;
  }, [openFragments]);

  // Shared by every way of adding a paint. The new paint joins the loaded JSON
  // set instead of replacing it. Existing fragments come first, so the placeholder
  // ids of paints already loaded are assigned the same way, and their draft keys
  // stay valid.
  const addWarPaint = useCallback(async (
    buildPaint: (ids: { defindex: number; operationDefindex: number }, templates: OperationTemplateData) => ProtoDefJsonFragment[],
  ): Promise<boolean> => {
    const current = loadedRef.current;
    try {
      if (current && !current.fragments) {
        throw new Error('Clear the imported proto_defs.vpd to create a new war paint.');
      }
      const templates = await loadOperationTemplates();
      const existing = current?.fragments ?? [];
      const ids = nextWarPaintIds({
        paintDefindexes: [
          ...(manifest?.paintkits.map((kit) => kit.id) ?? []),
          ...(current?.index.kits.map((kit) => kit.defindex) ?? []),
        ],
        operationDefindexes: [
          ...Object.keys(templates.usage).map(Number),
          ...templates.templates.map((entry) => entry.defindex),
          ...operationDefindexesIn(existing),
        ],
      });
      const fragments = [...existing, ...buildPaint(ids, templates)];

      return await reopenFragments(fragments, { preferredDefindex: ids.defindex });
    } catch (cause) {
      setDiagnostics([diagnostic(
        'error',
        'The new war paint could not be created.',
        cause instanceof Error ? cause.message : undefined,
      )]);
      return false;
    }
  }, [manifest, reopenFragments]);

  const createWarPaint = useCallback((templateDefindex: number, name: string): Promise<boolean> => (
    addWarPaint((ids, templates) => {
      const template = templates.templates.find((entry) => entry.defindex === templateDefindex);
      if (!template) throw new Error('That operation template is not in this build.');
      return buildTemplateWarPaint({
        template,
        defindex: ids.defindex,
        operationDefindex: ids.operationDefindex,
        name,
        isShipped: (ref) => Boolean(manifest?.textures?.[ref]),
      });
    })
  ), [addWarPaint, manifest]);

  const createWarPaintCopy = useCallback((messages: ProtoDefKitMessages, name: string): Promise<boolean> => (
    addWarPaint((ids) => buildCopiedWarPaint({
      messages,
      defindex: ids.defindex,
      operationDefindex: ids.operationDefindex,
      name,
    }))
  ), [addWarPaint]);

  const clearPreviewKit = useCallback(() => {
    editOperationRef.current += 1;
    const edited = editedRef.current;
    if (!edited) return;
    edited.source.dispose();
    editedRef.current = null;
    recipeCacheRef.current.clear();
    setEditGeneration((current) => current + 1);
  }, []);

  // Overlays every operation and item definition of the bundle on the stock base, so a
  // per-wear paint's edited operation resolves for the weapon and wear that reads it.
  const previewKitBundle = useCallback(async (
    kitId: number,
    bundle: ProtoDefKitBundle,
  ): Promise<void> => {
    if (!loadedRef.current) throw new Error('Import definitions before editing them.');
    const defindex = customKitDefindex(kitId);
    if (!loadedRef.current.index.kits.some((kit) => kit.defindex === defindex)) {
      throw new Error('The selected paint is not part of the imported definitions.');
    }
    const operation = ++editOperationRef.current;
    const [{ createProtoDefSource }, { serializeProtoDefKitBundlePreview }, baseBytes, weaponsByItemDef] = await Promise.all([
      import('../protodefs/client'),
      import('../editor/export/jsonExport'),
      loadBaseDefs(),
      loadWeaponsByItemDef(),
    ]);
    const source = createProtoDefSource();
    try {
      const fragments = serializeProtoDefKitBundlePreview(bundle).fragments;
      const index = await source.openJsonFragments(baseBytes, fragments, {
        weaponsByItemDef,
        builtInIds: manifest?.paintkits.map((kit) => kit.id) ?? [],
        computeTeamFlags: false,
      });
      if (!index.kits.some((kit) => kit.defindex === defindex)) {
        throw new Error('The edited fragments no longer contain the selected paint.');
      }
      if (operation !== editOperationRef.current) {
        source.dispose();
        return;
      }
      editedRef.current?.source.dispose();
      // The bundle is the editor's frozen snapshot, so it is kept by reference.
      editedRef.current = { kitId, source, bundle };
      recipeCacheRef.current.clear();
      setEditGeneration((current) => current + 1);
    } catch (cause) {
      source.dispose();
      throw cause;
    }
  }, [loadBaseDefs, loadWeaponsByItemDef, manifest]);

  const importFiles = useCallback((files: File[], persist: boolean) => {
    const container = files.find((entry) => entry.name.toLowerCase().endsWith('.vpd'));
    const jsonFiles = files.filter((entry) => entry.name.toLowerCase().endsWith('.json'));
    if (!container && jsonFiles.length === 0) {
      setDiagnostics([diagnostic('error', 'Select a proto_defs .vpd file, or the .json files a custom war paint ships.')]);
      return;
    }
    void (async () => {
      try {
        let opened = false;
        let sourceFiles: File[];
        if (container) {
          sourceFiles = [container];
          opened = await openContainer(container.name, new Uint8Array(await container.arrayBuffer()));
        } else {
          sourceFiles = jsonFiles;
          const oversized = jsonFiles.find((entry) => entry.size > MAX_FRAGMENT_BYTES);
          if (oversized) throw new Error(`${oversized.name} is too large to be a war paint definition.`);
          const fragments = await Promise.all(
            jsonFiles.map(async (entry) => ({ name: entry.name, text: await entry.text() })),
          );
          opened = await openFragments(definitionSetName(jsonFiles.map((entry) => entry.name)), fragments);
        }
        if (!opened || !persist) return;
        try {
          await writeCustomSourceFiles('definitions', sourceFiles);
        } catch {
          setDiagnostics((current) => [
            ...current,
            diagnostic(
              'warning',
              'The definitions are loaded, but their source files could not be saved locally.',
              'Keep the original definition files before reloading or closing this page.',
            ),
          ]);
        }
      } catch (cause) {
        setDiagnostics([errorDiagnostic(cause)]);
      }
    })();
  }, [openContainer, openFragments]);

  const onImport = useCallback((files: File[]) => importFiles(files, true), [importFiles]);

  useEffect(() => {
    if (!manifest || !getAssetUrl('item-defs.json')) return;
    let cancelled = false;
    void readCustomSourceFiles('definitions').then((files) => {
      if (!cancelled && files?.length) importFiles(files, false);
    }).catch(() => {
      if (cancelled) return;
      setDiagnostics((current) => [
        ...current,
        diagnostic(
          'warning',
          'The locally saved definition files could not be restored.',
          'Import the original definition files again.',
        ),
      ]);
    });
    return () => { cancelled = true; };
  }, [getAssetUrl, importFiles, manifest]);

  const onRemove = useCallback(() => {
    importOperationRef.current += 1;
    release();
    setLoaded(null);
    setStatus('empty');
    setFileName(undefined);
    setDiagnostics([]);
    setLoadedDefindexes([]);
    setQuarantinedDefindexes([]);
    setIcons({});
    setSuggestedKitId(undefined);
    void deleteCustomSourceFiles('definitions').catch(() => {
      setDiagnostics([
        diagnostic(
          'warning',
          'The saved definition files could not be removed from local storage.',
        ),
      ]);
    });
  }, [release]);

  // An edited copy of the paint would still be exported with its old fragments,
  // so the preview is dropped whenever that paint's files change.
  const dropPreviewOf = useCallback((defindex: number) => {
    if (editedRef.current?.kitId === customKitId(defindex)) clearPreviewKit();
  }, [clearPreviewKit]);

  const onDeleteWarPaint = useCallback((defindex: number) => {
    const fragments = loadedRef.current?.fragments;
    if (!fragments) return;
    const remaining = withoutGeneratedPaint(fragments, defindex);
    if (remaining.length === 0) {
      onRemove();
      return;
    }
    dropPreviewOf(defindex);
    void reopenFragments(remaining, { suggest: false });
  }, [dropPreviewOf, onRemove, reopenFragments]);

  const onRenameWarPaint = useCallback((defindex: number, name: string) => {
    const fragments = loadedRef.current?.fragments;
    const trimmed = name.trim();
    if (!fragments || !trimmed) return;
    let renamed: ProtoDefJsonFragment[];
    try {
      renamed = renameGeneratedPaint(fragments, defindex, trimmed);
    } catch (cause) {
      setDiagnostics([diagnostic(
        'error',
        'The war paint could not be renamed.',
        cause instanceof Error ? cause.message : undefined,
      )]);
      return;
    }
    dropPreviewOf(defindex);
    void reopenFragments(renamed, { preferredDefindex: defindex });
  }, [dropPreviewOf, reopenFragments]);

  const onToggleKit = useCallback((defindex: number) => {
    if (quarantinedDefindexes.includes(defindex)) return;
    setLoadedDefindexes((current) => current.includes(defindex)
      ? current.filter((entry) => entry !== defindex)
      : [...current, defindex]);
  }, [quarantinedDefindexes]);

  // A war paint ships its definitions inside the same archive as its textures,
  // either as a whole modded container or (far more often) as the two JSON
  // fragments its author wrote. Find whichever is there so the pack can be
  // imported in one go rather than unzipped by hand.
  const pkg = provider.package;
  const [packageFragments, setPackageFragments] = useState<ProtoDefJsonFragment[]>([]);
  useEffect(() => {
    setPackageFragments([]);
    if (!pkg || pkg.has(PACKAGE_PROTO_DEFS_PATH)) return;
    const entries = [...pkg.entries.values()]
      .filter((entry) => entry.path.endsWith('.json') && entry.size <= MAX_FRAGMENT_BYTES)
      .slice(0, MAX_FRAGMENT_ENTRIES);
    if (entries.length === 0) return;
    let cancelled = false;
    void (async () => {
      const found: ProtoDefJsonFragment[] = [];
      for (const entry of entries) {
        if (cancelled) return;
        try {
          const text = new TextDecoder().decode(await pkg.read(entry.path));
          if (classifyProtoDefFragment(text)) found.push({ name: entry.path, text });
        } catch {
          // An unreadable entry simply is not a candidate.
        }
      }
      if (!cancelled && found.length) setPackageFragments(found);
    })();
    return () => { cancelled = true; };
  }, [pkg]);

  const packageCandidate = useMemo(() => {
    if (!pkg) return undefined;
    if (pkg.has(PACKAGE_PROTO_DEFS_PATH)) {
      return {
        path: PACKAGE_PROTO_DEFS_PATH,
        onLoad: () => {
          void (async () => {
            try {
              await openContainer(`${pkg.name}: ${PACKAGE_PROTO_DEFS_PATH}`, await pkg.read(PACKAGE_PROTO_DEFS_PATH));
            } catch (cause) {
              setDiagnostics([errorDiagnostic(cause)]);
            }
          })();
        },
      };
    }
    if (packageFragments.length === 0) return undefined;
    return {
      path: packageFragments.map((fragment) => fragment.name).join(', '),
      onLoad: () => { void openFragments(definitionSetName(packageFragments.map((fragment) => fragment.name)), packageFragments); },
    };
  }, [pkg, packageFragments, openContainer, openFragments]);

  const loadedSet = useMemo(() => new Set(loadedDefindexes), [loadedDefindexes]);
  const quarantinedSet = useMemo(() => new Set(quarantinedDefindexes), [quarantinedDefindexes]);

  const kitRows = useMemo<CustomDefinitionKitRow[]>(() => {
    const generated = new Set((loaded?.fragments ?? []).map((fragment) => generatedPaintDefindex(fragment.name)));
    return (loaded?.index.kits ?? []).map((kit) => ({
      id: customKitId(kit.defindex),
      defindex: kit.defindex,
      name: kit.name,
      weapons: kit.weapons,
      isNew: kit.isNew,
      loaded: loadedSet.has(kit.defindex),
      unsupported: kit.weapons.length === 0,
      quarantined: quarantinedSet.has(kit.defindex),
      generated: generated.has(kit.defindex),
    }));
  }, [loaded, loadedSet, quarantinedSet]);

  const stockKitNames = useMemo<Record<number, string>>(
    () => Object.fromEntries((manifest?.paintkits ?? []).map((kit) => [kit.id, kit.name])),
    [manifest],
  );

  const catalogKits = useMemo<PaintkitEntry[]>(
    () => (loaded?.index.kits ?? [])
      .filter((kit) => loadedSet.has(kit.defindex) && kit.weapons.length > 0)
      .map(toCatalogKit),
    [loaded, loadedSet],
  );

  // Thumbnails come from the kit's own pattern texture, but only when that
  // texture actually resolves; a broken image says less than no image.
  useEffect(() => {
    const kits = (loaded?.index.kits ?? []).filter((kit) => kit.iconRef && loadedSet.has(kit.defindex));
    if (kits.length === 0) return;
    let cancelled = false;
    void Promise.all(kits.map(async (kit) => {
      const ref = kit.iconRef as string;
      if (!hasTexture(ref)) return null;
      try {
        return [customKitId(kit.defindex), await provider.resolvePreview(ref)] as const;
      } catch {
        return null;
      }
    })).then((entries) => {
      if (cancelled) return;
      const resolved = entries.filter((entry): entry is readonly [number, string] => entry !== null);
      if (resolved.length) setIcons((current) => ({ ...current, ...Object.fromEntries(resolved) }));
    });
    return () => { cancelled = true; };
  }, [loaded, loadedSet, hasTexture, provider, packageGeneration]);

  const getRecipe = useCallback((
    kitId: number,
    weaponKey: string,
    team: Team,
    wearIndex: number,
  ): Promise<RecipeNode | null> => {
    const edited = editedRef.current;
    const source = edited?.kitId === kitId ? edited.source : loadedRef.current?.source;
    if (!source) return Promise.resolve(null);
    const packageGenerationAtStart = packageGeneration;
    // A package mount can add an implicit sticker spec to an otherwise
    // unchanged definition. Include its generation in the cache identity so
    // a render in the same React turn cannot reuse the recipe resolved before
    // the package was mounted.
    const key = `${packageGeneration}|${kitId}|${weaponKey}|${team}|${wearIndex}`;
    const cached = recipeCacheRef.current.get(key);
    if (cached) return cached;
    const pending = source
      .resolveRecipe(customKitDefindex(kitId), weaponKey, team, wearIndex)
      .then((resolved) => {
        if (!resolved || packageGenerationAtStart !== provider.generation) return null;
        applyImplicitStickerSpecs(resolved.tree, hasTexture);
        return resolved.tree;
      })
      .catch(() => null);
    recipeCacheRef.current.set(key, pending);
    return pending;
  }, [hasTexture, packageGeneration, provider]);

  const getRecipeWithProvenance = useCallback((
    kitId: number,
    weaponKey: string,
    team: Team,
    wearIndex: number,
  ): Promise<ProtoDefRecipeWithProvenance | null> => {
    const edited = editedRef.current;
    const source = edited?.kitId === kitId ? edited.source : loadedRef.current?.source;
    if (!source) return Promise.resolve(null);
    const packageGenerationAtStart = packageGeneration;
    return source.resolveRecipeWithProvenance(
      customKitDefindex(kitId),
      weaponKey,
      team,
      wearIndex,
    ).then((resolved) => {
      if (packageGenerationAtStart !== provider.generation) return null;
      if (resolved) applyImplicitStickerSpecs(resolved.tree, hasTexture);
      return resolved;
    }).catch(() => null);
  }, [hasTexture, packageGeneration, provider]);

  // The export builder needs an imported kit's own definition and operation
  // messages so it can write them into a proto_defs container the game loads.
  // Routed through the hook rather than by handing out the source, so the
  // loaded container stays owned in one place.
  const exportKit = useCallback(
    (kitId: number): Promise<ProtoDefKitMessages | null> => (
      editedRef.current?.kitId === kitId
        ? Promise.resolve(structuredClone(topLevelMessages(editedRef.current.bundle)))
        : loadedRef.current?.source.exportKit(customKitDefindex(kitId)) ?? Promise.resolve(null)
    ),
    [],
  );

  const exportKitBundle = useCallback(
    (kitId: number): Promise<ProtoDefKitBundle | null> => (
      editedRef.current?.kitId === kitId
        ? Promise.resolve(structuredClone(editedRef.current.bundle))
        : loadedRef.current?.source.exportKitBundle(customKitDefindex(kitId)) ?? Promise.resolve(null)
    ),
    [],
  );

  const exportKitWeaponSlots = useCallback(
    (kitId: number): Promise<ProtoDefKitWeaponSlot[] | null> => (
      editedRef.current?.kitId === kitId
        ? editedRef.current.source.exportKitWeaponSlots(customKitDefindex(kitId))
        : loadedRef.current?.source.exportKitWeaponSlots(customKitDefindex(kitId)) ?? Promise.resolve(null)
    ),
    [],
  );

  const state = useMemo<CustomDefinitions['state']>(() => ({
    status,
    fileName,
    kits: kitRows,
    diagnostics,
    packageCandidate,
    onImport,
    canAddWarPaint: !loaded || loaded.fragments !== undefined,
    onCreateWarPaint: createWarPaint,
    onCreateWarPaintCopy: createWarPaintCopy,
    onDeleteWarPaint,
    onRenameWarPaint,
    onToggleKit,
    stockKitNames,
    onRemove,
  }), [
    status,
    fileName,
    kitRows,
    diagnostics,
    packageCandidate,
    onImport,
    loaded,
    createWarPaint,
    createWarPaintCopy,
    onDeleteWarPaint,
    onRenameWarPaint,
    onToggleKit,
    stockKitNames,
    onRemove,
  ]);

  return useMemo(
    () => ({
      state,
      catalogKits,
      icons,
      getRecipe,
      getRecipeWithProvenance,
      exportKit,
      exportKitBundle,
      exportKitWeaponSlots,
      previewKitBundle,
      clearPreviewKit,
      suggestedKitId,
      generation,
      editGeneration,
    }),
    [
      state,
      catalogKits,
      icons,
      getRecipe,
      getRecipeWithProvenance,
      exportKit,
      exportKitBundle,
      exportKitWeaponSlots,
      previewKitBundle,
      clearPreviewKit,
      suggestedKitId,
      generation,
      editGeneration,
    ],
  );
}
