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
  EditedKit,
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
import { loadBaseProtoDefs, loadItemDefinitionMap, loadOperationTemplates } from '../data/loader';
import { openKitPreviewSource } from './kitPreview';
import { appErrorDiagnostic, ERROR_CODES } from '../errors';
import { WORKSHOP_ENABLED } from '../device';
import { topLevelMessages } from '../editor/kitBundle';
import { applyImplicitStickerSpecs } from '../protodefs/implicitStickerSpecs';
import { partitionResolvableKits } from '../protodefs/validation';
import {
  deleteCustomSourceFiles,
  readCustomSourceFiles,
  writeCustomSourceFiles,
} from '../editor/draftStorage';

// Stock containers are under 10 MB; this only stops a mis-picked file being read whole.
const MAX_DEFINITION_BYTES = 64 * 1024 * 1024;
// Community packs ship two JSON fragments beside the textures; these bounds stop
// a scan from reading a whole archive.
const MAX_FRAGMENT_BYTES = 8 * 1024 * 1024;
const MAX_FRAGMENT_ENTRIES = 24;
const NO_FRAGMENTS: ProtoDefJsonFragment[] = [];

interface CustomDefinitions {
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
  /** Off loads nothing and never touches the saved definition files. */
  enabled?: boolean;
}

interface LoadedFile {
  name: string;
  index: ProtoDefIndex;
  source: ProtoDefSource;
  /** The JSON fragments this set was opened from; undefined for a whole container. */
  fragments?: ProtoDefJsonFragment[];
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

/** Owns one imported proto_defs container and its catalog kits; source files persist for reloads. */
export function useCustomDefinitions({
  manifest,
  getAssetUrl,
  provider,
  packageGeneration,
  enabled = WORKSHOP_ENABLED,
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
  // A newer import or a removal cancels an import in flight.
  const importOperationRef = useRef(0);
  const loadedRef = useRef<LoadedFile | null>(null);
  const editedRef = useRef<EditedKit | null>(null);
  const editOperationRef = useRef(0);
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

  // Implicit sticker specs and thumbnails depend on the mounted package; mounts invalidate them.
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

  const loadWeaponsByItemDef = useCallback(
    (): Promise<Record<string, string>> => loadItemDefinitionMap(getAssetUrl('item-defs.json')),
    [getAssetUrl],
  );

  // JSON fragments reference base-game operations by index, so they resolve only on
  // top of the base defs, fetched once on the first fragment import.
  const loadBaseDefs = useCallback(
    (): Promise<Uint8Array> => loadBaseProtoDefs(getAssetUrl('protodefs-base.bin')),
    [getAssetUrl],
  );

  const openWith = useCallback(async (
    name: string,
    run: (source: ProtoDefSource, options: ProtoDefOpenOptions) => Promise<ProtoDefIndex>,
    extras: FragmentOpenOptions & { fragments?: ProtoDefJsonFragment[] } = {},
  ): Promise<boolean> => {
    // Every load (import, restore, create, rename, delete) opens here, and a
    // failed open never reaches the saved-file writes that follow it.
    if (!enabled) return false;
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
          'Mount an archive to supply the textures these definitions ask for.',
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
  }, [enabled, loadWeaponsByItemDef, manifest, provider, release]);

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

  // Reopens a JSON set and saves its files. The set name stays stable so drafts remain valid.
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

  // Shared by every way of adding a paint. The paint joins the loaded JSON set; existing
  // fragments come first, so already-loaded placeholder ids and their draft keys stay the same.
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
    const { source, index } = await openKitPreviewSource(
      bundle,
      loadBaseDefs(),
      loadWeaponsByItemDef(),
      manifest?.paintkits.map((kit) => kit.id) ?? [],
    );
    try {
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
    if (!enabled || !manifest || !getAssetUrl('item-defs.json')) return;
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
  }, [enabled, getAssetUrl, importFiles, manifest]);

  const onRemove = useCallback(() => {
    if (!enabled) return;
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
  }, [enabled, release]);

  // An edited copy would export its old fragments, so drop the preview when those files change.
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

  // A war paint's definitions ship inside its texture archive, as a whole container or,
  // more often, as JSON fragments. Find whichever is present so the pack imports in one go.
  const pkg = provider.package;
  const [foundFragments, setFoundFragments] = useState<{ pkg: typeof pkg; fragments: ProtoDefJsonFragment[] }>({ pkg: null, fragments: [] });
  // Fragments read from an earlier package never count for the current one.
  const packageFragments = foundFragments.pkg === pkg ? foundFragments.fragments : NO_FRAGMENTS;
  useEffect(() => {
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
      if (!cancelled && found.length) setFoundFragments({ pkg, fragments: found });
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

  // Thumbnails come from the kit's pattern texture, shown only when it resolves.
  useEffect(() => {
    const kits = (loaded?.index.kits ?? []).flatMap((kit) => (kit.iconRef && loadedSet.has(kit.defindex)
      ? [{ defindex: kit.defindex, iconRef: kit.iconRef }]
      : []));
    if (kits.length === 0) return;
    let cancelled = false;
    void Promise.all(kits.map(async ({ defindex, iconRef }) => {
      if (!hasTexture(iconRef)) return null;
      try {
        return [customKitId(defindex), await provider.resolvePreview(iconRef)] as const;
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
    // A package mount can add an implicit sticker spec, so the generation keys the cache.
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

  // The export builder reads a kit's messages through here, so the loaded container has one owner.
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
