import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { Eye, Palette, SlidersHorizontal } from 'lucide-react';
import './ui/catalog/WarpaintList.css';
import './ui/stage/StageToolbar.css';
import './ui/stage/Inspector.css';
import './styles/stage.css';
import './styles/layout.css';
import type { StickerGizmoDrag, Viewer } from './viewer/Viewer';
import { isStockMaterialCubemap, stockMaterialCubemapUrls } from './viewer/env';
import type { Compositor, ComposeResult } from './compositor/compositor';
import type { PaintkitEntry } from './data/types';
import type { RecipeNode } from './compositor/types';
import { resolveRecipe as resolveSeededRecipe } from './compositor/resolve';
import type { ResolvedNode, ResolvedSticker } from './compositor/resolve';
import { WarpaintList } from './ui/catalog/WarpaintList';
import { Inspector } from './ui/stage/Inspector';
import type { ControlsState } from './viewer/controls';
import { StageToolbar } from './ui/stage/StageToolbar';
import { LightingPanel } from './ui/stage/LightingPanel';
import { deleteLightFromRig, duplicateLightInRig } from './ui/stage/lightingRig';
import { PanelEdgeToggle } from './ui/common/PanelEdgeToggle';
import { DefinitionsPrompt } from './ui/workbench/DefinitionsPrompt';
import type { WarpaintAssetOverrides, WearRecipe, WorkbenchTab } from './workbench/types';
import { revokeAssetOverrideCache } from './workbench/assetUrls';
import { BootLoader } from './ui/boot/BootLoader';
import { DEFAULT_VIEWER_FOV, TF2_ITEM_PANEL_FOV, VIEW_ANGLES, weaponIconView } from './viewer/presets';
import { LEGACY_PAINTKIT_ICON_LIGHTING_ID, PAINTKIT_ICON_LIGHTING_ID } from './viewer/lighting';
import {
  loadCustomLighting,
  saveCustomLighting,
} from './viewer/controls';
import { CUSTOM_LIGHTING_ID, MAX_CUSTOM_LIGHTS, type CustomLightingRig } from './viewer/customLighting';
import { useBootData, randomSeed } from './hooks/useBootData';
import { applyTextureOverrides, useComposedPaint } from './hooks/useComposedPaint';
import { useSourcePackage } from './hooks/useSourcePackage';
import { useCustomDefinitions } from './hooks/useCustomDefinitions';
import { useStockDefinitions } from './hooks/useStockDefinitions';
import { useScreenshotActions } from './hooks/useScreenshotActions';
import { useCustomWarpaintIcons } from './hooks/useCustomWarpaintIcons';
import { isSupportedTexturePath, sourceTextureIdentity } from './source/paths';
import { indexPackageMaterialPaths, packageHasMaterialOverride } from './source/vmt';
import { collectTextureRefs, exportPathFor, resolvePackageTextures } from './export/plan';
import { customKitDefindex, isCustomKitId } from './protodefs/types';
import type { CustomDefinitionsState, ProtoDefKitWeaponSlot, ProtoDefRecipeWithProvenance } from './protodefs/types';
import type { OperationMsg, OperationNodeMsg, VarDefMsg } from './protodefs/messages';
import { useProtoDefEditorSession } from './editor/useProtoDefEditorSession';
import { SnapshotHistory } from './editor/history';
import { discoverGroupSelectTargets, discoverGroupTextureTarget } from './editor/groupTargets';
import {
  discoverBaseTextureTransformTarget,
  discoverTextureTransformTargets,
  type TextureTransformRangeFieldState,
} from './editor/transformTargets';
import {
  collectResolvedLayerIsolationNodes,
  preferredLayerOccurrenceIndex,
} from './editor/transformIsolation';
import { discoverWeaponMaterialTargets } from './editor/materialTargets';
import type { TextureTransformRangeField, TextureTransformTarget } from './editor/mutations';
import type { TextureTransformFields, TextureTransformPanelProps } from './ui/workbench/TextureTransformPanel';
import type { SeedRangeValue } from './ui/workbench/SeedRangeField';
import type { SeedRangeDivergence } from './ui/workbench/SeedRangeField';
import type { MaterialOverridesPanelProps, MaterialWeaponRow } from './ui/workbench/MaterialOverridesPanel';
import {
  groupBucketsInImage,
  groupByteToCompositorBucket,
  rawGroupIdForBucket,
  sampleGroupAtUv,
  type RgbaImageDataLike,
} from './editor/groupSampling';
import { loadRgbaImageData, loadRgbaThumbnail, rgbaThumbnailDataUrl } from './editor/imageData';
import {
  compatibleGroupTextures,
  formatGroupNameForDisplay,
  loadGroupNameReference,
  lookupGroupNameForBucket,
  normalizeGroupTextureReference,
  preferredAlbedoGroupIds,
} from './editor/groupNames';
import { chooseEditorLayerColors, EDITOR_LAYER_MAP_COLORS, linearLayerColorToCss } from './editor/layerMap';
import { discoverStickerPlacementTargets } from './editor/stickerTargets';
import {
  DEFAULT_STICKER_PLACEMENT,
  constrainStickerPlacementToTexture,
  fitStickerPlacement,
  snapStickerRotationToCardinal,
  stickerPlacementFromQuad,
  applyStickerPlacementToQuad,
  stickerPlacementToQuad,
  type StickerPlacement,
} from './editor/stickerGeometry';
import {
  mapResolvedTextureReferences,
  recipeWithoutStickerOccurrences,
  resolvedGroupStickerContext,
} from './editor/stickerSurface';
import {
  matchResolvedStickerArtworkGroups,
  prepareStickerArtwork,
  stickerArtworkNeedsComposedPreview,
} from './editor/stickerArtwork';
import { constrainStickerQuadToTexture, type StickerPlacementQuad } from './editor/viewerStickerPlacement';
import type { StickerTransformTool } from './ui/workbench/StickerPlacementEditor';
import {
  collectPackageStickerSpecularOverrides,
  collectSlots,
  stickerSpecularRef,
} from './workbench/assetSlots';
import type { EditorDownloadFormat } from './editor/definitionExport';
import {
  connectOperationGraph,
  deleteOperationGraphSubtree,
  disconnectOperationGraph,
  duplicateOperationGraphSubtree,
  operationGraphChildren,
  operationToGraph,
  composeOperationGraphNode,
  exportOperationGraphPng,
  exportOperationGraphVtf,
  operationGraphPreviewObjectUrl,
  reconnectOperationGraph,
  reorderOperationGraphInputs,
  createOperationGraphNode,
  setOperationGraphParameter,
  summarizeOperationGraphDiagnostics,
  validateOperationGraph,
  type OperationGraph,
  type OperationGraphDiagnostic,
  type OperationGraphEditResult,
  type OperationGraphNode,
  type OperationGraphParameterAddress,
  type OperationGraphParameterValue,
} from './editor/graph';
import type {
  OperationGraphEditorChange,
  OperationGraphExportFormat,
} from './ui/workbench/OperationGraphEditor';
import type { GraphComboboxOption, GraphVariableOption } from './ui/workbench/operationGraphFieldValues';

// Selftest page is code-split: it never loads in normal use.
const SelfTestPage = lazy(() => import('./dev/selftest').then((m) => ({ default: m.SelfTestPage })));
// The custom-file UI includes texture decoders and a large interactive editor.
// It is not needed to view a paint, so mount it only after the drawer opens.
const CustomWarpaintWorkbench = lazy(() => import('./ui/workbench/CustomWarpaintWorkbench').then((m) => ({ default: m.CustomWarpaintWorkbench })));

const SEED_HISTORY_CAP = 20;

const EMPTY_OVERRIDES: WarpaintAssetOverrides = { revision: 0, assets: {} };

const TRANSFORM_LIVE_PREVIEW_MAX_SIZE = 256;

const TRANSFORM_FIELD_DEFAULTS: TextureTransformFields = {
  rotation: { mode: 'fixed', min: 0, max: 0 },
  scale: { mode: 'fixed', min: 1, max: 1 },
  offsetU: { mode: 'fixed', min: 0, max: 0 },
  offsetV: { mode: 'fixed', min: 0, max: 0 },
};

const TRANSFORM_FIELD_TO_PROTO: Record<keyof TextureTransformFields, TextureTransformRangeField> = {
  rotation: 'rotation',
  scale: 'scale_uv',
  offsetU: 'translate_u',
  offsetV: 'translate_v',
};

function transformRangeFieldValue(
  state: TextureTransformRangeFieldState | undefined,
  fallback: SeedRangeValue,
): SeedRangeValue {
  return state ? { mode: state.mode, min: state.min, max: state.max } : fallback;
}

function transformRangeStatesEqual(
  left: TextureTransformRangeFieldState,
  right: TextureTransformRangeFieldState,
): boolean {
  return left.mode === right.mode && left.min === right.min && left.max === right.max;
}

/** Scope 'all' always writes the shared header default; 'weapon' keeps whatever weapon-local source discovery found. */
function transformTargetForScope(target: TextureTransformTarget, scope: 'all' | 'weapon'): TextureTransformTarget {
  return scope === 'all' ? { stagePath: target.stagePath } : target;
}

const TRANSFORM_FIELD_TO_RECIPE: Record<keyof TextureTransformFields, 'rotation' | 'scaleUV' | 'translateU' | 'translateV'> = {
  rotation: 'rotation',
  scale: 'scaleUV',
  offsetU: 'translateU',
  offsetV: 'translateV',
};

function previewTextureTransformRange(
  node: RecipeNode,
  target: RecipeNode | null,
  matchingTextureRef: string | null,
  field: keyof TextureTransformFields,
  value: SeedRangeValue,
): RecipeNode {
  const matchesTexture = node.type === 'texture_lookup' && matchingTextureRef !== null
    && protoTextureReference(node.texture) === protoTextureReference(matchingTextureRef);
  if (node.type === 'texture_lookup' && (node === target || matchesTexture)) {
    return { ...node, [TRANSFORM_FIELD_TO_RECIPE[field]]: [value.min, value.max] };
  }
  if (!('nodes' in node)) return node;
  const nodes = node.nodes.map((child) => previewTextureTransformRange(
    child,
    target,
    matchingTextureRef,
    field,
    value,
  ));
  return nodes.every((child, index) => child === node.nodes[index]) ? node : { ...node, nodes };
}

/** Preset material paths follow models/paintkits/<preset>/<weapon-key>. */
function materialPresetPath(presetId: string, weaponKey: string): string {
  const presetDirectory = presetId === 'macaw-metallic' ? 'macaw' : presetId;
  return `models/paintkits/${presetDirectory}/${weaponKey}`;
}

type MobilePanel = 'none' | 'catalog' | 'controls';

interface ResolvedGroupSelect {
  groups: string;
  select: number[];
  textureRef?: string;
}

function resolvedTextureReferences(node: RecipeNode): string[] {
  if (node.type === 'texture_lookup') return [node.texture];
  return 'nodes' in node ? node.nodes.flatMap(resolvedTextureReferences) : [];
}

function collectResolvedGroupSelects(node: RecipeNode, output: ResolvedGroupSelect[] = []): ResolvedGroupSelect[] {
  if (node.type === 'select') output.push({ groups: node.groups, select: node.select.map(Number) });
  if ('nodes' in node) node.nodes.forEach((child, index) => {
    if (child.type !== 'select') {
      collectResolvedGroupSelects(child, output);
      return;
    }
    const refs = index > 0 ? resolvedTextureReferences(node.nodes[index - 1]) : [];
    output.push({
      groups: child.groups,
      select: child.select.map(Number),
      ...(refs.length > 0 ? { textureRef: refs.at(-1) } : {}),
    });
  });
  return output;
}

/**
 * Same traversal as collectResolvedGroupSelects(), but returns the RecipeNode
 * of each select's preceding texture_lookup sibling instead of the select's
 * own data. Position-aligned with collectResolvedGroupSelects()'s output (and
 * therefore with groupDiscovery.targets / transformDiscovery.targets), so a
 * layer index picked from one array names the same layer in every other.
 */
function collectRecipeLayerNodes(node: RecipeNode, output: (RecipeNode | undefined)[] = []): (RecipeNode | undefined)[] {
  if (node.type === 'select') output.push(undefined);
  if ('nodes' in node) node.nodes.forEach((child, index) => {
    if (child.type !== 'select') {
      collectRecipeLayerNodes(child, output);
      return;
    }
    const preceding = index > 0 ? node.nodes[index - 1] : undefined;
    output.push(preceding?.type === 'texture_lookup' ? preceding : undefined);
  });
  return output;
}

function findRecipeTextureNode(node: RecipeNode, textureRef: string): RecipeNode | null {
  let result: RecipeNode | null = node.type === 'texture_lookup'
    && protoTextureReference(node.texture) === protoTextureReference(textureRef)
    ? node
    : null;
  if ('nodes' in node) {
    for (const child of node.nodes) result = findRecipeTextureNode(child, textureRef) ?? result;
  }
  return result;
}

function collectResolvedLayerTextureNodes(
  node: ResolvedNode,
  output: (Extract<ResolvedNode, { type: 'texture_lookup' | 'combine_multiply' | 'combine_add' | 'combine_lerp' }> | undefined)[] = [],
): (Extract<ResolvedNode, { type: 'texture_lookup' | 'combine_multiply' | 'combine_add' | 'combine_lerp' }> | undefined)[] {
  if (node.type === 'select') output.push(undefined);
  if ('nodes' in node) node.nodes.forEach((child, index) => {
    if (child.type !== 'select') {
      collectResolvedLayerTextureNodes(child, output);
      return;
    }
    const preceding = index > 0 ? node.nodes[index - 1] : undefined;
    output.push(preceding && (
      preceding.type === 'texture_lookup'
      || preceding.type === 'combine_multiply'
      || preceding.type === 'combine_add'
      || preceding.type === 'combine_lerp'
    ) ? preceding : undefined);
  });
  return output;
}

function collectAppliedStickers(node: ResolvedNode, output: ResolvedSticker[] = []): ResolvedSticker[] {
  if (node.type === 'apply_sticker') output.push(node);
  if ('nodes' in node) for (const child of node.nodes) collectAppliedStickers(child, output);
  return output;
}

function stickerQuadsEqual(first: StickerPlacementQuad, second: StickerPlacementQuad): boolean {
  return (['tl', 'tr', 'bl'] as const).every((corner) => (
    Math.abs(first[corner][0] - second[corner][0]) < 1e-9
    && Math.abs(first[corner][1] - second[corner][1]) < 1e-9
  ));
}

/**
 * Source texture names are inconsistent and sometimes actively misleading, so
 * only genuinely descriptive ones become labels. Everything else falls back to
 * a plain ordinal rather than telling the user about `displaynull`.
 */
const UNINFORMATIVE_STICKER_TOKENS = new Set([
  'sticker', 'stickers', 'group', 'groupsticker', 'decal', 'display', 'displaynull',
  'texture', 'tex', 'img', 'image', 'square', 'squares', 'rect', 'box', 'blank',
  'null', 'none', 'empty', 'default', 'placeholder', 'black', 'white', 'grey', 'gray',
]);

function stickerTargetLabel(baseRef: string | undefined, index: number): string {
  const ordinal = `Sticker ${index + 1}`;
  const source = baseRef?.split(/[\\/]/).pop()?.replace(/\.[a-z0-9]+$/i, '') ?? '';
  if (!source) return ordinal;
  const words: string[] = [];
  // `tf2logo` is one token but two words; keep the brand readable and intact.
  for (const raw of source.replace(/tf2/gi, ' TF2 ').split(/[_\-\s]+/)) {
    if (raw === 'TF2') {
      words.push('TF2');
      continue;
    }
    // Trailing digits are a variant counter, not part of the name.
    const [, stem, digits] = /^(.*?)(\d*)$/.exec(raw) ?? [];
    const token = (stem || raw).toLowerCase();
    if (!token || UNINFORMATIVE_STICKER_TOKENS.has(token)) continue;
    const cased = token[0].toUpperCase() + token.slice(1);
    words.push(digits ? `${cased} ${Number(digits)}` : cased);
  }
  if (words.length === 0) return ordinal;
  const name = words.join(' ');
  return name.length > 24 ? `${name.slice(0, 23)}…` : name;
}

function isStickerArtworkReference(reference: string): boolean {
  const lower = reference.toLowerCase();
  if (!lower.includes('sticker') && !lower.includes('/stickers/')) return false;
  const stem = lower.replace(/\.(?:webp|vtf|png|tga|jpg|jpeg)$/, '');
  return !stem.endsWith('_s') && !stem.endsWith('_n');
}

function protoTextureReference(reference: string): string {
  return sourceTextureIdentity(reference).replace(/^materials\//, '');
}

function textureChoiceLabel(reference: string): string {
  const name = reference.split('/').at(-1) ?? reference;
  return name.replace(/\.[^.]+$/, '').replaceAll('_', ' ');
}

function shortcutTargetsEditableContent(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : document.activeElement;
  return element instanceof Element && Boolean(element.closest(
    'input, textarea, select, [contenteditable], [role="textbox"]',
  ));
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
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
function operationMessageForGraph(value: Record<string, unknown>): OperationMsg | null {
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
function varDefList(value: unknown): VarDefMsg[] {
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
function graphTextureRef(path: string): string | null {
  const trimmed = path.trim().replaceAll('\\', '/').replace(/^\/+/, '').toLowerCase();
  const withoutRoot = trimmed.replace(/^materials\//, '').replace(/^textures\//, '');
  const withoutExtension = withoutRoot.replace(GRAPH_TEXTURE_EXTENSION, '');
  return withoutExtension || null;
}

/** Every texture ref an operation graph already names, in authored order. */
function operationGraphTextureRefs(graph: OperationGraph | null): string[] {
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
function boundOperationGraphVariable(
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

function graphNodeOperationPath(node: OperationGraphNode): readonly string[] {
  return ['operation', ...node.sourcePath.map((segment) => String(segment))];
}

function downloadBytes(bytes: Uint8Array, fileName: string, mimeType: string): void {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const url = URL.createObjectURL(new Blob([copy], { type: mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default function App() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('selftest') === '1') {
    return (
      <Suspense fallback={<div className="loading">Loading selftest...</div>}>
        <SelfTestPage />
      </Suspense>
    );
  }
  return <MainApp />;
}

function MainApp() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const compositorRef = useRef<Compositor | null>(null);
  const seedHistoryRef = useRef<string[]>([]);

  const [engineReady, setEngineReady] = useState(false);
  const [environmentReady, setEnvironmentReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKitId, setSelectedKitId] = useState<number | null>(null);
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [workbenchMounted, setWorkbenchMounted] = useState(false);
  const [workbenchExpanded, setWorkbenchExpanded] = useState(false);
  // 0 keeps the CSS default drawer height; anything else is a user drag.
  const [workbenchHeight, setWorkbenchHeight] = useState(0);
  // The drawer is keyed to remount per paint/weapon, so its tab lives out here.
  const [workbenchTab, setWorkbenchTab] = useState<WorkbenchTab>('files');
  const [groupNameReferenceGeneration, setGroupNameReferenceGeneration] = useState(0);
  const [editorRequestedKitId, setEditorRequestedKitId] = useState<number | null>(null);
  const [editorRecipes, setEditorRecipes] = useState<WearRecipe[]>([]);
  const [editorLoading, setEditorLoading] = useState(false);
  const editorRecipesRef = useRef<WearRecipe[]>([]);
  const editorRecipeScopeRef = useRef('');
  const editorRecipeVariantRef = useRef('');
  const editorRecipeCompleteRef = useRef(false);
  const [visibleCatalogKitIds, setVisibleCatalogKitIds] = useState<readonly number[]>([]);
  const [assetOverrideCache, setAssetOverrideCache] = useState<Record<string, WarpaintAssetOverrides>>({});
  const [catalogVisible, setCatalogVisible] = useState(true);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [hintDismissed, setHintDismissed] = useState(false);
  const [cameraMode, setCameraMode] = useState<'inspect' | 'advanced'>('inspect');
  const [lightingPanelOpen, setLightingPanelOpen] = useState(false);
  const [selectedLightId, setSelectedLightId] = useState<string | null>(null);
  const selectedLightIdRef = useRef(selectedLightId);
  selectedLightIdRef.current = selectedLightId;
  const [viewAngleId, setViewAngleId] = useState('default');
  const viewAngleIdRef = useRef(viewAngleId);
  viewAngleIdRef.current = viewAngleId;
  const [loadedAssetKey, setLoadedAssetKey] = useState('');
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('none');
  const [state, setState] = useState<ControlsState>(() => ({
    weaponKey: '',
    wearIndex: 0,
    team: 'red',
    seed: randomSeed(),
    preset: 'inspect',
    sheen: 'none',
    unusual: 'none',
    fov: DEFAULT_VIEWER_FOV,
    projection: 'perspective',
    screenshotScale: 2,
    customLighting: loadCustomLighting(),
  }));
  const customLightingRef = useRef(state.customLighting);
  customLightingRef.current = state.customLighting;
  const lightingHistoryRef = useRef(new SnapshotHistory<CustomLightingRig>());
  const lightingPreviewBaselineRef = useRef<CustomLightingRig | null>(null);
  const [lightingHistoryRevision, setLightingHistoryRevision] = useState(0);

  const customLightingEqual = useCallback((left: CustomLightingRig, right: CustomLightingRig) => (
    JSON.stringify(left) === JSON.stringify(right)
  ), []);

  const applyCustomLighting = useCallback((customLighting: CustomLightingRig) => {
    const current = customLightingRef.current;
    const baseline = lightingPreviewBaselineRef.current;
    lightingPreviewBaselineRef.current = null;
    if (customLightingEqual(current, customLighting)) {
      if (baseline && !customLightingEqual(baseline, current)) {
        lightingHistoryRef.current.record(baseline);
        setLightingHistoryRevision((revision) => revision + 1);
      }
      return;
    }
    lightingHistoryRef.current.record(baseline ?? current);
    customLightingRef.current = customLighting;
    setState((value) => ({ ...value, customLighting }));
    setLightingHistoryRevision((revision) => revision + 1);
  }, [customLightingEqual]);

  const previewCustomLighting = useCallback((customLighting: CustomLightingRig) => {
    const current = customLightingRef.current;
    if (customLightingEqual(current, customLighting)) return;
    lightingPreviewBaselineRef.current ??= current;
    customLightingRef.current = customLighting;
    setState((value) => ({ ...value, customLighting }));
  }, [customLightingEqual]);

  const undoLighting = useCallback(() => {
    lightingPreviewBaselineRef.current = null;
    const previous = lightingHistoryRef.current.undo(customLightingRef.current);
    if (!previous) return;
    customLightingRef.current = previous;
    setState((value) => ({ ...value, customLighting: previous }));
    setLightingHistoryRevision((revision) => revision + 1);
  }, []);

  const redoLighting = useCallback(() => {
    lightingPreviewBaselineRef.current = null;
    const next = lightingHistoryRef.current.redo(customLightingRef.current);
    if (!next) return;
    customLightingRef.current = next;
    setState((value) => ({ ...value, customLighting: next }));
    setLightingHistoryRevision((revision) => revision + 1);
  }, []);

  const deleteSelectedLight = useCallback(() => {
    const id = selectedLightIdRef.current;
    if (!id) return;
    const result = deleteLightFromRig(customLightingRef.current, id);
    if (!result) return;
    applyCustomLighting(result.rig);
    setSelectedLightId(result.selectedLightId);
  }, [applyCustomLighting]);

  const duplicateSelectedLight = useCallback(() => {
    const id = selectedLightIdRef.current;
    if (!id) return;
    const result = duplicateLightInRig(customLightingRef.current, id);
    if (!result) return;
    applyCustomLighting(result.rig);
    setSelectedLightId(result.selectedLightId);
  }, [applyCustomLighting]);

  const toggleSelectedLight = useCallback(() => {
    const id = selectedLightIdRef.current;
    if (!id) return;
    const rig = customLightingRef.current;
    if (!rig.lights.some((light) => light.id === id)) return;
    applyCustomLighting({
      ...rig,
      lights: rig.lights.map((light) => light.id === id ? { ...light, enabled: !light.enabled } : light),
    });
  }, [applyCustomLighting]);

  const lightingCanUndo = lightingHistoryRef.current.canUndo;
  const lightingCanRedo = lightingHistoryRef.current.canRedo;
  void lightingHistoryRevision;

  useEffect(() => {
    if (!lightingPanelOpen || state.preset !== CUSTOM_LIGHTING_ID) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (shortcutTargetsEditableContent(event.target)) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const key = event.key.toLowerCase();
      const command = event.ctrlKey || event.metaKey;
      if ((key === 'delete' || key === 'backspace') && !command && !event.altKey && !event.shiftKey) {
        if (!selectedLightIdRef.current) return;
        event.preventDefault();
        deleteSelectedLight();
      } else if (key === 'd' && command && !event.altKey && !event.shiftKey) {
        if (!selectedLightIdRef.current || customLightingRef.current.lights.length >= MAX_CUSTOM_LIGHTS) return;
        event.preventDefault();
        duplicateSelectedLight();
      } else if (key === 'h' && !command && !event.altKey && !event.shiftKey) {
        if (!selectedLightIdRef.current) return;
        event.preventDefault();
        toggleSelectedLight();
      } else if (key === 'z' && command && !event.shiftKey && lightingHistoryRef.current.canUndo) {
        event.preventDefault();
        undoLighting();
      } else if (command && (key === 'y' || (key === 'z' && event.shiftKey)) && lightingHistoryRef.current.canRedo) {
        event.preventDefault();
        redoLighting();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deleteSelectedLight, duplicateSelectedLight, lightingPanelOpen, redoLighting, state.preset, toggleSelectedLight, undoLighting]);

  const { data, boot, advanceBoot } = useBootData({ state, setState, selectedKitId, setSelectedKitId, setError });

  const reportVisibleCatalogKitIds = useCallback((ids: readonly number[]) => {
    setVisibleCatalogKitIds((current) => (
      current.length === ids.length && current.every((id, index) => id === ids[index])
        ? current
        : [...ids]
    ));
  }, []);

  useEffect(() => {
    if (!workbenchOpen || workbenchTab !== 'editor' || groupNameReferenceGeneration > 0) return;
    let cancelled = false;
    void loadGroupNameReference().then(() => {
      if (!cancelled) setGroupNameReferenceGeneration((generation) => generation + 1);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [groupNameReferenceGeneration, workbenchOpen, workbenchTab]);

  const clearAssetOverrideCache = useCallback(() => {
    setAssetOverrideCache((cache) => {
      revokeAssetOverrideCache(cache);
      return {};
    });
  }, []);

  const { provider: sourceProvider, sourcePackage, packageGeneration, suggestedPaintkitId, removePackage } = useSourcePackage(
    data?.resolveTexture ?? ((ref) => ref),
    clearAssetOverrideCache,
    (ref) => !!data?.manifest.textures?.[ref] || isStockMaterialCubemap(ref),
  );
  const getAssetUrl = useCallback((rel: string) => data?.getAssetUrl(rel) ?? null, [data]);
  const definitions = useCustomDefinitions({
    manifest: data?.manifest ?? null,
    getAssetUrl,
    provider: sourceProvider,
    packageGeneration,
  });
  const stockDefinitions = useStockDefinitions(data?.manifest ?? null, getAssetUrl);
  const {
    editGeneration: stockEditGeneration,
    exportKit: exportStockKit,
    exportKitWeaponSlots: exportStockKitWeaponSlots,
    getRecipe: getStockRecipe,
    getRecipeWithProvenance: getStockRecipeWithProvenance,
    previewKitMessages: previewStockKitMessages,
    clearPreviewKit: clearStockPreviewKit,
  } = stockDefinitions;
  const {
    exportKit: exportImportedKit,
    exportKitWeaponSlots: exportImportedKitWeaponSlots,
    getRecipeWithProvenance: getImportedRecipeWithProvenance,
    previewKitMessages: previewImportedKitMessages,
    clearPreviewKit: clearImportedPreviewKit,
  } = definitions;
  useEffect(() => {
    if (workbenchOpen && workbenchTab === 'editor' && selectedKitId !== null) {
      setEditorRequestedKitId(selectedKitId);
    }
  }, [selectedKitId, workbenchOpen, workbenchTab]);
  const editableKitId = selectedKitId === editorRequestedKitId ? selectedKitId : null;
  const loadEditorKit = useCallback((kitId: number) => (
    isCustomKitId(kitId) ? exportImportedKit(kitId) : exportStockKit(kitId)
  ), [exportImportedKit, exportStockKit]);
  const loadEditorKitWeaponSlots = useCallback((kitId: number) => (
    isCustomKitId(kitId) ? exportImportedKitWeaponSlots(kitId) : exportStockKitWeaponSlots(kitId)
  ), [exportImportedKitWeaponSlots, exportStockKitWeaponSlots]);
  const editorSession = useProtoDefEditorSession({ kitId: editableKitId, loadKit: loadEditorKit });
  const {
    status: editorStatus,
    original: editorOriginal,
    current: editorCurrent,
    dirty: editorDirty,
    canUndo: editorCanUndo,
    canRedo: editorCanRedo,
    error: editorSessionError,
    assignSelectGroups: assignSessionGroups,
    clearSelectGroups: clearSessionGroups,
    setGroupTexture: setSessionGroupTexture,
    setStickerDestQuad: setSessionStickerQuad,
    addSticker: addSessionSticker,
    removeSticker: removeSessionSticker,
    moveSticker: moveSessionSticker,
    beginTransformGesture: beginSessionTransformGesture,
    endTransformGesture: endSessionTransformGesture,
    setTransformRange: setSessionTransformRange,
    pushTransformRangeToAll: pushSessionTransformRangeToAll,
    setTransformFlip: setSessionTransformFlip,
    setWeaponMaterial: setSessionWeaponMaterial,
    setWeaponMaterials: setSessionWeaponMaterials,
    undo: undoEditor,
    redo: redoEditor,
    reset: resetEditor,
    reload: reloadEditor,
    getCurrentMessages: getEditorMessages,
    replaceOperationGraph,
    setDefinitionVariable,
    revision: editorRevision,
  } = editorSession;
  const committedOperationGraph = useMemo<OperationGraph | null>(() => {
    if (!editorCurrent) return null;
    const operation = operationMessageForGraph(editorCurrent.operation);
    if (!operation) return null;
    try {
      return operationToGraph(operation);
    } catch {
      return null;
    }
  }, [editorCurrent]);
  const [operationGraphDraft, setOperationGraphDraft] = useState<{
    readonly revision: number;
    readonly graph: OperationGraph;
    readonly diagnostics: readonly OperationGraphDiagnostic[];
  } | null>(null);
  const [operationGraphEditError, setOperationGraphEditError] = useState<string | null>(null);
  const [selectedOperationGraphNodeId, setSelectedOperationGraphNodeId] = useState<string | null>(null);
  const [operationGraphPreviewUrls, setOperationGraphPreviewUrls] = useState<Record<string, string>>({});
  const operationGraphPreviewUrlLeasesRef = useRef(new Map<string, { url: string; dispose: () => void }>());
  const operationGraph = operationGraphDraft?.revision === editorRevision
    ? operationGraphDraft.graph
    : committedOperationGraph;
  /**
   * Texture choices for the graph's on-node pickers: what this graph already
   * uses, what the imported package carries, then everything the viewer ships.
   * Ordering matters more than completeness here, because the first group is
   * almost always the one someone is reaching for.
   */
  /**
   * Bindable variables, nearest scope first. A paint kit declares the ones an
   * operation's stages actually bind to, while an operation only declares its
   * own when it overrides a wear level, so both have to be offered.
   */
  const operationGraphVariables = useMemo<GraphVariableOption[]>(() => {
    const options: GraphVariableOption[] = [];
    const seen = new Set<string>();
    const push = (variable: VarDefMsg, scope: string, editable: boolean): void => {
      if (seen.has(variable.name)) return;
      seen.add(variable.name);
      options.push({
        name: variable.name,
        scope,
        editable,
        ...(variable.value !== undefined ? { value: variable.value } : {}),
      });
    };
    for (const variable of varDefList(operationGraph?.operationSnapshot?.header.variables)) {
      push(variable, 'This operation', true);
    }
    const definitionHeader = editorCurrent && isRecordValue(editorCurrent.definition.header)
      ? editorCurrent.definition.header
      : undefined;
    for (const variable of varDefList(definitionHeader?.variables)) push(variable, 'This paint kit', true);
    return options;
  }, [editorCurrent, operationGraph]);

  const operationGraphTextureOptions = useMemo<GraphComboboxOption[]>(() => {
    const options: GraphComboboxOption[] = [];
    const seen = new Set<string>();
    const push = (ref: string, group: string, secondary = false): void => {
      if (seen.has(ref)) return;
      seen.add(ref);
      const thumbnail = data?.manifest.textures?.[`textures/${ref}.webp`]
        ? `${import.meta.env.BASE_URL}data/thumbnails/textures/${ref}.webp`
        : undefined;
      options.push({
        value: ref,
        label: ref,
        group,
        ...(secondary ? { secondary: true } : {}),
        ...(thumbnail ? { thumbnailUrl: thumbnail } : {}),
      });
    };

    const pkg = sourceProvider.package;
    const packageRefs = new Set<string>();
    if (pkg) {
      for (const path of pkg.entries.keys()) {
        if (!isSupportedTexturePath(path)) continue;
        const ref = graphTextureRef(path);
        if (ref) packageRefs.add(ref);
      }
    }
    const exists = (ref: string): boolean => (
      packageRefs.has(ref) || data?.manifest.textures?.[`textures/${ref}.webp`] !== undefined
    );

    // What this paint already draws with, first: literal refs on its stages,
    // then the variable declarations that resolve to a real file. Templated
    // declarations such as a per-weapon albedo path name no single file, so
    // they are left out rather than offered as a dead choice.
    for (const ref of operationGraphTextureRefs(operationGraph)) push(ref, 'In this paint');
    for (const variable of operationGraphVariables) {
      const ref = variable.value ? graphTextureRef(variable.value) : null;
      if (ref && exists(ref)) push(ref, 'In this paint');
    }
    for (const ref of packageRefs) push(ref, pkg ? `From ${pkg.name}` : 'Imported package');
    for (const path of Object.keys(data?.manifest.textures ?? {})) {
      const ref = graphTextureRef(path);
      if (ref) push(ref, 'Shipped with the viewer', true);
    }
    return options;
    // packageGeneration changes whenever a different archive is mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.manifest.textures, operationGraph, operationGraphVariables, packageGeneration, sourceProvider]);
  useEffect(() => {
    setOperationGraphDraft(null);
    setOperationGraphEditError(null);
  }, [editableKitId, editorRevision]);

  useEffect(() => {
    setSelectedOperationGraphNodeId(null);
  }, [editableKitId]);

  useEffect(() => {
    if (!operationGraphEditError) return;
    const timeout = window.setTimeout(() => setOperationGraphEditError(null), 6000);
    return () => window.clearTimeout(timeout);
  }, [operationGraphEditError]);

  const applyOperationGraphEdit = useCallback(<T,>(
    edit: (graph: OperationGraph) => OperationGraphEditResult<T>,
    onSuccess?: (value: T) => void,
  ): void => {
    if (!operationGraph) return;
    const result = edit(operationGraph);
    if (!result.ok) {
      const validation = validateOperationGraph(result.graph);
      setOperationGraphDraft({ revision: editorRevision, graph: result.graph, diagnostics: validation.diagnostics });
      setOperationGraphEditError(summarizeOperationGraphDiagnostics(result.diagnostics));
      return;
    }
    const validation = validateOperationGraph(result.graph);
    onSuccess?.(result.value);
    if (!validation.valid) {
      setOperationGraphDraft({ revision: editorRevision, graph: result.graph, diagnostics: validation.diagnostics });
      setOperationGraphEditError(summarizeOperationGraphDiagnostics(validation.diagnostics));
      return;
    }
    if (replaceOperationGraph(result.graph)) {
      setOperationGraphDraft(null);
      setOperationGraphEditError(null);
      return;
    }
    setOperationGraphDraft({ revision: editorRevision, graph: result.graph, diagnostics: validation.diagnostics });
    setOperationGraphEditError('The valid operation graph could not be serialized.');
  }, [editorRevision, operationGraph, replaceOperationGraph]);

  const updateOperationGraphRaw = useCallback((nodeId: string, raw: OperationNodeMsg): void => {
    if (!operationGraph) return;
    const node = operationGraph.nodes.find((candidate) => candidate.id === nodeId);
    if (!node || node.locked) return;
    const next: OperationGraph = {
      ...operationGraph,
      nodes: operationGraph.nodes.map((candidate) => (
        candidate.id === nodeId ? { ...candidate, raw: structuredClone(raw) } : candidate
      )),
    };
    const validation = validateOperationGraph(next);
    if (!validation.valid) {
      setOperationGraphDraft({ revision: editorRevision, graph: next, diagnostics: validation.diagnostics });
      setOperationGraphEditError(summarizeOperationGraphDiagnostics(validation.diagnostics));
      return;
    }
    if (replaceOperationGraph(next)) {
      setOperationGraphDraft(null);
      setOperationGraphEditError(null);
    } else {
      setOperationGraphDraft({ revision: editorRevision, graph: next, diagnostics: validation.diagnostics });
      setOperationGraphEditError('The operation graph could not be serialized.');
    }
  }, [editorRevision, operationGraph, replaceOperationGraph]);

  const updateOperationGraphParameter = useCallback((
    nodeId: string,
    address: OperationGraphParameterAddress,
    value: OperationGraphParameterValue,
  ): void => {
    // Writing a bound parameter means writing its declaration. The graph layer
    // owns operation-scope variables; paint-kit ones live a level up, so route
    // those to the definition instead of failing the whole edit.
    if (value.mode === 'literal' && value.preserveVariable !== false && operationGraph) {
      const bound = boundOperationGraphVariable(operationGraph, nodeId, address);
      const declaredInOperation = varDefList(operationGraph.operationSnapshot?.header.variables)
        .some((variable) => variable.name === bound);
      if (bound && !declaredInOperation) {
        if (!setDefinitionVariable(bound, String(value.value))) return;
        setOperationGraphEditError(null);
        return;
      }
    }
    applyOperationGraphEdit((graph) => setOperationGraphParameter(graph, { nodeId, address, value }));
  }, [applyOperationGraphEdit, operationGraph, setDefinitionVariable]);

  const handleOperationGraphChange = useCallback((change: OperationGraphEditorChange): void => {
    if (!operationGraph) return;
    switch (change.type) {
      case 'move':
      case 'arrange':
        return;
      case 'connect':
        applyOperationGraphEdit((graph) => connectOperationGraph(
          graph,
          change.connection.source,
          change.connection.target,
          change.connection.inputIndex,
        ));
        return;
      case 'reconnect':
        applyOperationGraphEdit((graph) => reconnectOperationGraph(
          graph,
          change.previous.id,
          change.connection.source,
          change.connection.target,
          change.connection.inputIndex,
        ));
        return;
      case 'disconnect':
        applyOperationGraphEdit((graph) => disconnectOperationGraph(graph, change.edge.id));
        return;
      case 'add':
        applyOperationGraphEdit(
          (graph) => createOperationGraphNode(graph, change.kind),
          (value) => setSelectedOperationGraphNodeId(value.nodeId),
        );
        return;
      case 'duplicate':
        applyOperationGraphEdit(
          (graph) => duplicateOperationGraphSubtree(graph, change.nodeId),
          (value) => setSelectedOperationGraphNodeId(value.rootId),
        );
        return;
      case 'delete':
        applyOperationGraphEdit(
          (graph) => deleteOperationGraphSubtree(graph, change.nodeId, { allowInvalid: true }),
          (value) => {
            if (value.deletedNodeIds.includes(selectedOperationGraphNodeId ?? '')) {
              setSelectedOperationGraphNodeId(null);
            }
          },
        );
        return;
      case 'reorder': {
        const order = operationGraphChildren(operationGraph, change.nodeId);
        if (change.fromIndex < 0 || change.fromIndex >= order.length
          || change.toIndex < 0 || change.toIndex >= order.length) return;
        const nextOrder = [...order];
        const [moved] = nextOrder.splice(change.fromIndex, 1);
        if (moved === undefined) return;
        nextOrder.splice(change.toIndex, 0, moved);
        applyOperationGraphEdit((graph) => reorderOperationGraphInputs(graph, change.nodeId, nextOrder));
        return;
      }
    }
  }, [applyOperationGraphEdit, operationGraph, selectedOperationGraphNodeId]);
  // The definition/operation messages the editor session holds carry no
  // items_game defindex table, so the weapon each authored slot paints (and
  // where that slot lives) is resolved separately, off the decoded source,
  // whenever the editable kit changes. See src/editor/materialTargets.ts.
  const [weaponSlots, setWeaponSlots] = useState<ProtoDefKitWeaponSlot[]>([]);
  useEffect(() => {
    if (editableKitId === null) {
      setWeaponSlots([]);
      return;
    }
    let cancelled = false;
    void loadEditorKitWeaponSlots(editableKitId).then((slots) => {
      if (!cancelled) setWeaponSlots(slots ?? []);
    });
    return () => { cancelled = true; };
  }, [editableKitId, loadEditorKitWeaponSlots]);
  const [groupImage, setGroupImage] = useState<RgbaImageDataLike | null>(null);
  const [groupImageError, setGroupImageError] = useState<string | null>(null);
  const [requestedGroupTextureRef, setRequestedGroupTextureRef] = useState<string | null>(null);
  const groupImageCacheRef = useRef(new Map<string, Promise<RgbaImageDataLike>>());
  const autoAlbedoAssignmentKeysRef = useRef(new Set<string>());
  const [editorPreviewError, setEditorPreviewError] = useState<string | null>(null);
  const [editorPackageExportError, setEditorPackageExportError] = useState<string | null>(null);
  const [editorPackageExporting, setEditorPackageExporting] = useState(false);
  const [editorPreviewPending, setEditorPreviewPending] = useState(false);
  const [editorAssignmentNotice, setEditorAssignmentNotice] = useState<string | null>(null);
  const [showLayerMap, setShowLayerMap] = useState(false);
  const [layerMapImages, setLayerMapImages] = useState<Record<string, RgbaImageDataLike>>({});
  const [layerTextureThumbnails, setLayerTextureThumbnails] = useState<Record<string, RgbaImageDataLike | null>>({});
  const [layerTexturePreviewUrls, setLayerTexturePreviewUrls] = useState<Record<string, string | null>>({});
  const layerThumbnailCacheRef = useRef(new Map<string, Promise<RgbaImageDataLike | null>>());
  const layerThumbnailGenerationRef = useRef('');
  const [activeEditorSelector, setActiveEditorSelector] = useState(0);
  const [weaponBaseLayerActive, setWeaponBaseLayerActive] = useState(false);
  const [editorTool, setEditorTool] = useState<'paint' | 'sticker'>('paint');
  // Parts/Transform sub-view of paint mode. Lives beside editorTool rather
  // than nested under it, since it only matters while editorTool === 'paint'.
  const [paintSubView, setPaintSubView] = useState<'parts' | 'transform' | 'graph'>('parts');
  const [transformScope, setTransformScope] = useState<'all' | 'weapon'>('all');
  const [transformIsolateLayer, setTransformIsolateLayer] = useState(false);
  const [transformUvSurfaceUrl, setTransformUvSurfaceUrl] = useState<string | null>(null);
  const [transformUvSurfaceLoading, setTransformUvSurfaceLoading] = useState(false);
  const transformUvSurfaceUrlRef = useRef<string | null>(null);
  const transformUvSurfaceGenerationRef = useRef(0);
  const [transformUvIsolationOverlayUrl, setTransformUvIsolationOverlayUrl] = useState<string | null>(null);
  const transformUvIsolationOverlayUrlRef = useRef<string | null>(null);
  const transformUvIsolationOverlayGenerationRef = useRef(0);
  const [transformGestureActive, setTransformGestureActive] = useState(false);
  const transformGestureActiveRef = useRef(false);
  const transformDraftRef = useRef<{ key: keyof TextureTransformFields; value: SeedRangeValue } | null>(null);
  const transformDraftCommitGenerationRef = useRef<number | null>(null);
  const [transformDraft, setTransformDraft] = useState<{ key: keyof TextureTransformFields; value: SeedRangeValue } | null>(null);
  const [transformDivergence, setTransformDivergence] = useState<Partial<Record<keyof TextureTransformFields, SeedRangeDivergence>>>({});
  const [materialPresetId, setMaterialPresetId] = useState('macaw-metallic');
  // One mode drives both UV and on-model controls. Keeping it above either
  // surface prevents a scale handle in one view from silently moving in the
  // other.
  const [stickerTransformTool, setStickerTransformTool] = useState<StickerTransformTool>('move');
  const [stickerAspectLocked, setStickerAspectLocked] = useState(true);
  const [modelPartPickingActive, setModelPartPickingActive] = useState(false);
  const [hiddenModelPartCount, setHiddenModelPartCount] = useState(0);
  const [activeStickerTarget, setActiveStickerTarget] = useState(0);
  const [pendingAddedStickerRef, setPendingAddedStickerRef] = useState<string | null>(null);
  const stickerRecipeKey = editableKitId !== null && state.weaponKey
    ? `${editableKitId}|${state.weaponKey}|${state.team}|${state.wearIndex}`
    : '';
  const [loadedStickerRecipe, setLoadedStickerRecipe] = useState<{
    readonly key: string;
    readonly recipe: ProtoDefRecipeWithProvenance | null;
  } | null>(null);
  const stickerRecipe = loadedStickerRecipe?.key === stickerRecipeKey
    ? loadedStickerRecipe.recipe
    : null;
  const [stickerTargetThumbnails, setStickerTargetThumbnails] = useState<Record<string, string>>({});
  const [stickerTargetArtwork, setStickerTargetArtwork] = useState<Record<string, string>>({});
  const [stickerSpecularUrl, setStickerSpecularUrl] = useState<string | null>(null);
  const [groupStickerArtwork, setGroupStickerArtwork] = useState<Record<string, { key: string; url: string }>>({});
  const [stickerSurfaceUrl, setStickerSurfaceUrl] = useState<string | null>(null);
  const [stickerBaseSurfaceKey, setStickerBaseSurfaceKey] = useState<string | null>(null);
  const [groupStickerResourcesKey, setGroupStickerResourcesKey] = useState<string | null>(null);
  const [stickerAspect, setStickerAspect] = useState(1);
  const [stickerSurfaceAspect, setStickerSurfaceAspect] = useState(1.6);
  const [stickerDraftQuad, setStickerDraftQuad] = useState<StickerPlacementQuad | null>(null);
  const stickerDraftRef = useRef<StickerPlacementQuad | null>(null);
  const stickerDraftRenderRafRef = useRef(0);
  const stickerBaseSurfaceResultRef = useRef<ComposeResult | null>(null);
  const groupStickerResourcesRef = useRef<{
    key: string;
    targetId: string;
    maskUrl: string;
    selectorBase: ComposeResult;
    selectorBaseUrl: string;
    endpointZero: ComposeResult;
    endpointZeroUrl: string;
    endpointOne: ComposeResult;
    endpointOneUrl: string;
    artworkUrl: string;
    levels: readonly [number, number, number];
  } | null>(null);
  const groupStickerPreparationRef = useRef<{
    targetId: string;
    context: NonNullable<ReturnType<typeof resolvedGroupStickerContext>>;
  } | null>(null);
  const stickerArtworkCacheRef = useRef(new Map<string, { url: string; dispose(): void }>());
  const stickerGestureRef = useRef<{
    pointerId: number;
    base: StickerPlacementQuad;
    latest: StickerPlacementQuad;
  } | null>(null);
  const stickerGizmoGestureRef = useRef<{
    pointerId: number;
    drag: StickerGizmoDrag;
    preserveAspect: boolean;
    base: StickerPlacementQuad;
    latest: StickerPlacementQuad;
  } | null>(null);
  const modelPartPointerRef = useRef<{
    pointerId: number;
    captureTarget: HTMLDivElement;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);
  const updateStickerDraft = useCallback((quad: StickerPlacementQuad | null) => {
    stickerDraftRef.current = quad;
    if (quad === null) {
      window.cancelAnimationFrame(stickerDraftRenderRafRef.current);
      stickerDraftRenderRafRef.current = 0;
      setStickerDraftQuad(null);
      return;
    }
    if (stickerDraftRenderRafRef.current) return;
    stickerDraftRenderRafRef.current = window.requestAnimationFrame(() => {
      stickerDraftRenderRafRef.current = 0;
      setStickerDraftQuad(stickerDraftRef.current);
    });
  }, []);
  useEffect(() => () => window.cancelAnimationFrame(stickerDraftRenderRafRef.current), []);
  const discardStickerDraft = useCallback(() => {
    // Draft coordinates exist only while a direct-manipulation gesture is in
    // flight. History actions replace the authored proto snapshot, so a stale
    // draft must never continue to win over the restored destination.
    stickerGestureRef.current = null;
    stickerGizmoGestureRef.current = null;
    updateStickerDraft(null);
  }, [updateStickerDraft]);
  const undoEditorSynced = useCallback(() => {
    discardStickerDraft();
    undoEditor();
  }, [discardStickerDraft, undoEditor]);
  const redoEditorSynced = useCallback(() => {
    discardStickerDraft();
    redoEditor();
  }, [discardStickerDraft, redoEditor]);
  const resetEditorSynced = useCallback(() => {
    discardStickerDraft();
    resetEditor();
  }, [discardStickerDraft, resetEditor]);
  const [panelPreviewGroup, setPanelPreviewGroup] = useState<number | null>(null);
  const groupPointerRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [editorSelectionHeld, setEditorSelectionHeld] = useState(false);
  const editorSourceGenerationRef = useRef(definitions.generation);
  const [editorSample, setEditorSample] = useState<{
    rawRed: number;
    bucket: number;
    uv: { u: number; v: number };
    texel: { x: number; y: number };
  } | null>(null);

  useEffect(() => {
    if (!editorAssignmentNotice) return;
    const timeout = window.setTimeout(() => setEditorAssignmentNotice(null), 3000);
    return () => window.clearTimeout(timeout);
  }, [editorAssignmentNotice]);

  useEffect(() => setShowLayerMap(false), [editableKitId, state.weaponKey]);

  const groupDiscovery = useMemo(
    () => editorCurrent ? discoverGroupSelectTargets(editorCurrent, stickerRecipe?.provenance) : null,
    [editorCurrent, stickerRecipe],
  );
  // Position-aligned with groupDiscovery.targets: both walk the same operation
  // tree in the same order, so index i here describes the stage masked by
  // select stage i there (see transformTargets.ts's module comment).
  const transformDiscovery = useMemo(
    () => editorCurrent ? discoverTextureTransformTargets(editorCurrent, stickerRecipe?.provenance) : null,
    [editorCurrent, stickerRecipe],
  );
  const sharedTransformDiscovery = useMemo(
    () => editorCurrent ? discoverTextureTransformTargets(editorCurrent) : null,
    [editorCurrent],
  );
  const originalTransformDiscovery = useMemo(
    () => editorOriginal ? discoverTextureTransformTargets(editorOriginal, stickerRecipe?.provenance) : null,
    [editorOriginal, stickerRecipe],
  );
  const originalSharedTransformDiscovery = useMemo(
    () => editorOriginal ? discoverTextureTransformTargets(editorOriginal) : null,
    [editorOriginal],
  );
  const baseTextureTransform = useMemo(
    () => editorCurrent ? discoverBaseTextureTransformTarget(editorCurrent, stickerRecipe?.provenance) : null,
    [editorCurrent, stickerRecipe],
  );
  const sharedBaseTextureTransform = useMemo(
    () => editorCurrent ? discoverBaseTextureTransformTarget(editorCurrent) : null,
    [editorCurrent],
  );
  const originalBaseTextureTransform = useMemo(
    () => editorOriginal ? discoverBaseTextureTransformTarget(editorOriginal, stickerRecipe?.provenance) : null,
    [editorOriginal, stickerRecipe],
  );
  const originalSharedBaseTextureTransform = useMemo(
    () => editorOriginal ? discoverBaseTextureTransformTarget(editorOriginal) : null,
    [editorOriginal],
  );
  const editableGroupTargets = useMemo(() => (
    groupDiscovery?.targets.filter((target, index, targets) => (
      target.canToggle && targets.findIndex((candidate) => candidate.canToggle && candidate.sourceKey === target.sourceKey) === index
    )) ?? []
  ), [groupDiscovery]);
  const editorSelectors = useMemo(() => editableGroupTargets.map((target, index) => ({
    id: String(index),
    label: target.label,
  })), [editableGroupTargets]);
  const activeGroupTarget = editableGroupTargets[activeEditorSelector] ?? editableGroupTargets[0] ?? null;
  const activeGroupOperationIndex = activeGroupTarget && groupDiscovery
    ? groupDiscovery.targets.indexOf(activeGroupTarget)
    : -1;
  // TF2 templates can reuse one authored layer in an early wear branch and a
  // later colour branch. Transform editing and previews follow the final
  // occurrence that matches the finished paint; group assignment retains the
  // first authored selector target because both share the same source slots.
  const activeGroupVisualIndex = groupDiscovery
    ? preferredLayerOccurrenceIndex(groupDiscovery.targets, activeGroupTarget)
    : -1;
  const activeTransformTargetInfo = weaponBaseLayerActive
    ? (transformScope === 'all' ? sharedBaseTextureTransform : baseTextureTransform)?.transform ?? null
    : activeGroupVisualIndex >= 0
      ? (transformScope === 'all' ? sharedTransformDiscovery : transformDiscovery)?.targets[activeGroupVisualIndex] ?? null
      : null;
  const originalTransformTargetInfo = weaponBaseLayerActive
    ? (transformScope === 'all' ? originalSharedBaseTextureTransform : originalBaseTextureTransform)?.transform ?? null
    : activeGroupVisualIndex >= 0
      ? (transformScope === 'all' ? originalSharedTransformDiscovery : originalTransformDiscovery)?.targets[activeGroupVisualIndex] ?? null
      : null;
  // The RecipeNode counterpart of activeTransformTargetInfo, used to composite
  // preview tiles (which need the authored subtree, not just its field values).
  const recipeLayerNodes = useMemo(
    () => stickerRecipe ? collectRecipeLayerNodes(stickerRecipe.tree) : [],
    [stickerRecipe],
  );
  const baseRecipeLayerNode = baseTextureTransform && stickerRecipe
    ? findRecipeTextureNode(stickerRecipe.tree, baseTextureTransform.textureRef)
    : null;
  const activeTransformLayerNode = weaponBaseLayerActive
    ? baseRecipeLayerNode
    : activeGroupVisualIndex >= 0
      ? recipeLayerNodes[activeGroupVisualIndex] ?? null
      : null;
  const baseLayerTextureRef = baseRecipeLayerNode?.type === 'texture_lookup'
    ? baseRecipeLayerNode.texture
    : baseTextureTransform?.textureRef;
  const transformPreviewRecipe = useMemo(() => {
    if (!stickerRecipe || !transformDraft
      || (!activeTransformLayerNode && !(weaponBaseLayerActive && baseTextureTransform))) {
      return stickerRecipe?.tree ?? null;
    }
    return previewTextureTransformRange(
      stickerRecipe.tree,
      activeTransformLayerNode,
      weaponBaseLayerActive ? baseTextureTransform?.textureRef ?? null : null,
      transformDraft.key,
      transformDraft.value,
    );
  }, [activeTransformLayerNode, baseTextureTransform, stickerRecipe, transformDraft, weaponBaseLayerActive]);
  const resolvedGroupSelects = useMemo(() => {
    const recipe = editorRecipes.find((entry) => entry.wearIndex === state.wearIndex)?.recipe
      ?? editorRecipes[0]?.recipe;
    return recipe ? collectResolvedGroupSelects(recipe) : [];
  }, [editorRecipes, state.wearIndex]);
  const activeResolvedGroupSelect = activeGroupOperationIndex >= 0
    ? resolvedGroupSelects[activeGroupOperationIndex]
    : undefined;
  const activeGroupRef = activeResolvedGroupSelect?.groups ?? activeGroupTarget?.groupsRef;
  const resolvedGroupTextureValue = activeGroupRef ? normalizeGroupTextureReference(activeGroupRef) : undefined;
  const activeGroupTextureValue = requestedGroupTextureRef ?? resolvedGroupTextureValue;
  const displayedGroupRef = requestedGroupTextureRef ?? activeGroupRef;
  const groupTextureChoices = useMemo(
    () => {
      if (!displayedGroupRef) return [];
      const hasBuiltInNames = normalizeGroupTextureReference(displayedGroupRef).startsWith('models/items/paintkit_tool/');
      return groupNameReferenceGeneration > 0 || hasBuiltInNames
        ? compatibleGroupTextures(displayedGroupRef)
        : [];
    },
    [displayedGroupRef, groupNameReferenceGeneration],
  );
  const activeWeaponVariablePath = weaponSlots.find((slot) => slot.weaponKey === state.weaponKey)?.path;
  const groupTextureTarget = useMemo(() => discoverGroupTextureTarget(
    stickerRecipe?.provenance,
    activeGroupRef,
    activeWeaponVariablePath ? [...activeWeaponVariablePath, 'data', 'variable'] : undefined,
  ), [activeGroupRef, activeWeaponVariablePath, stickerRecipe?.provenance]);

  useEffect(() => {
    if (requestedGroupTextureRef && requestedGroupTextureRef === resolvedGroupTextureValue) {
      setRequestedGroupTextureRef(null);
    }
  }, [requestedGroupTextureRef, resolvedGroupTextureValue]);

  useEffect(() => {
    setRequestedGroupTextureRef(null);
    setGroupImage(null);
    setWeaponBaseLayerActive(false);
    groupImageCacheRef.current.clear();
    autoAlbedoAssignmentKeysRef.current.clear();
  }, [editableKitId, state.weaponKey]);
  const activeGroupBuckets = useMemo(
    () => groupImage ? groupBucketsInImage(groupImage) : [],
    [groupImage],
  );
  const groupAssignmentTargets = useMemo(() => editableGroupTargets.map((target, index) => {
    const matchingOperationIndexes = groupDiscovery?.targets.flatMap((candidate, operationIndex) => (
      candidate.sourceKey === target.sourceKey ? [operationIndex] : []
    )) ?? [];
    const resolvedMatches = matchingOperationIndexes.flatMap((operationIndex) => (
      resolvedGroupSelects[operationIndex] ? [resolvedGroupSelects[operationIndex]] : []
    ));
    const resolved = resolvedMatches.at(-1);
    const selectedGroupIds = target.hasInheritedVariableValues ? resolved?.select : target.selectedGroupIds;
    return {
      label: editorSelectors[index]?.label ?? target.label,
      groupsRef: resolved?.groups ?? target.groupsRef,
      textureRef: resolved?.textureRef ?? target.textureRef,
      selectedGroupIds: selectedGroupIds ?? [],
      target: {
        ...target.target,
        ...(target.hasInheritedVariableValues && resolved
          ? { effectiveSelectValues: resolved.select }
          : {}),
      },
      canAssign: !target.hasInheritedVariableValues || Boolean(resolved),
    };
  }), [editableGroupTargets, editorSelectors, groupDiscovery, resolvedGroupSelects]);
  // The operation can inherit its starting selector values from the selected
  // weapon or wear. Show the values the model is actually using until an edit
  // intentionally locks those slots into the draft operation.
  const explicitActiveSelectedRawGroupIds = useMemo(() => (
    activeGroupTarget?.hasInheritedVariableValues
      ? activeResolvedGroupSelect?.select
      : activeGroupTarget?.selectedGroupIds
  )?.filter((id, index, values) => id > 0 && values.indexOf(id) === index).sort((a, b) => a - b) ?? [], [
    activeGroupTarget,
    activeResolvedGroupSelect,
  ]);
  const activeSelectedRawGroupIds = useMemo(() => {
    if (!weaponBaseLayerActive) return explicitActiveSelectedRawGroupIds;
    const assigned = new Set(groupAssignmentTargets.flatMap((target) => target.selectedGroupIds));
    return activeGroupBuckets
      .map(rawGroupIdForBucket)
      .filter((groupId): groupId is number => groupId !== null && !assigned.has(groupId));
  }, [activeGroupBuckets, explicitActiveSelectedRawGroupIds, groupAssignmentTargets, weaponBaseLayerActive]);
  const activeSelectedGroupBuckets = useMemo(() => activeSelectedRawGroupIds
    .map(groupByteToCompositorBucket)
    .filter((bucket): bucket is number => bucket !== null && bucket > 0)
    .filter((bucket, index, buckets) => buckets.indexOf(bucket) === index)
    .sort((a, b) => a - b), [activeSelectedRawGroupIds]);

  useEffect(() => {
    const generation = ++transformUvIsolationOverlayGenerationRef.current;
    const clearOverlay = () => {
      const priorUrl = transformUvIsolationOverlayUrlRef.current;
      transformUvIsolationOverlayUrlRef.current = null;
      setTransformUvIsolationOverlayUrl(null);
      if (priorUrl) URL.revokeObjectURL(priorUrl);
    };
    if (!transformIsolateLayer || paintSubView !== 'transform' || !groupImage
      || activeSelectedGroupBuckets.length === 0) {
      clearOverlay();
      return;
    }

    // The UV pane is capped at 460 CSS pixels. A 512px mask preserves crisp
    // group edges at its actual display size while avoiding four times the
    // pixel work and memory of a 1024px intermediate.
    const maxDimension = 512;
    const scale = Math.min(1, maxDimension / Math.max(groupImage.width, groupImage.height));
    const width = Math.max(1, Math.round(groupImage.width * scale));
    const height = Math.max(1, Math.round(groupImage.height * scale));
    const selectedBuckets = new Set(activeSelectedGroupBuckets);
    const overlayPixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      const sourceY = Math.min(groupImage.height - 1, Math.floor(y / scale));
      for (let x = 0; x < width; x += 1) {
        const sourceX = Math.min(groupImage.width - 1, Math.floor(x / scale));
        const sourceOffset = (sourceY * groupImage.width + sourceX) * 4;
        const bucket = groupByteToCompositorBucket(Number(groupImage.data[sourceOffset]));
        if (bucket !== null && selectedBuckets.has(bucket)) continue;
        const offset = (y * width + x) * 4;
        overlayPixels[offset] = 255;
        overlayPixels[offset + 1] = 255;
        overlayPixels[offset + 2] = 255;
        overlayPixels[offset + 3] = 255;
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
      clearOverlay();
      return;
    }
    context.putImageData(new ImageData(overlayPixels, width, height), 0, 0);
    canvas.toBlob((blob) => {
      if (generation !== transformUvIsolationOverlayGenerationRef.current) return;
      if (!blob) {
        clearOverlay();
        return;
      }
      const nextUrl = URL.createObjectURL(blob);
      const priorUrl = transformUvIsolationOverlayUrlRef.current;
      transformUvIsolationOverlayUrlRef.current = nextUrl;
      setTransformUvIsolationOverlayUrl(nextUrl);
      if (priorUrl) URL.revokeObjectURL(priorUrl);
    }, 'image/png');
  }, [activeSelectedGroupBuckets, groupImage, paintSubView, transformIsolateLayer]);

  useEffect(() => () => {
    transformUvIsolationOverlayGenerationRef.current += 1;
    const priorUrl = transformUvIsolationOverlayUrlRef.current;
    transformUvIsolationOverlayUrlRef.current = null;
    if (priorUrl) URL.revokeObjectURL(priorUrl);
  }, []);
  const activeGroupLabels = useMemo(() => {
    if (!displayedGroupRef) return {};
    const labels: Record<number, string> = {};
    const hasBuiltInNames = normalizeGroupTextureReference(displayedGroupRef).startsWith('models/items/paintkit_tool/');
    for (let bucket = 1; bucket <= 16; bucket += 1) {
      const name = groupNameReferenceGeneration > 0 || hasBuiltInNames
        ? lookupGroupNameForBucket(displayedGroupRef, bucket)
        : null;
      if (name) labels[bucket] = name;
    }
    for (const bucket of activeGroupBuckets) {
      if (!labels[bucket]) labels[bucket] = 'Part';
    }
    return labels;
  }, [activeGroupBuckets, displayedGroupRef, groupNameReferenceGeneration]);
  useEffect(() => {
    if (!displayedGroupRef || !groupImage || editableKitId === null) return;
    const assignmentKey = `${editableKitId}:${state.weaponKey}:${normalizeGroupTextureReference(displayedGroupRef)}`;
    if (autoAlbedoAssignmentKeysRef.current.has(assignmentKey)) return;
    const presentRawIds = new Set(activeGroupBuckets
      .map(rawGroupIdForBucket)
      .filter((groupId): groupId is number => groupId !== null));
    const unassignedDefaults = preferredAlbedoGroupIds(displayedGroupRef).filter((groupId) => (
      presentRawIds.has(groupId)
      &&
      !groupAssignmentTargets.some((target) => target.selectedGroupIds.includes(groupId))
    ));
    if (unassignedDefaults.length === 0) return;
    const albedoTarget = groupAssignmentTargets.find((target) => (
      target.canAssign && target.label.trim().toLowerCase() === 'albedo'
    ));
    if (!albedoTarget) return;
    if (assignSessionGroups(albedoTarget, groupAssignmentTargets, unassignedDefaults)) {
      autoAlbedoAssignmentKeysRef.current.add(assignmentKey);
    }
  }, [activeGroupBuckets, assignSessionGroups, displayedGroupRef, editableKitId, groupAssignmentTargets, groupImage, state.weaponKey]);
  // The parts board needs to know which layer every assigned part belongs to,
  // not just the active one, so it can render each chip's true state (in this
  // layer / in another layer / unassigned) rather than only a binary toggle.
  const groupBucketLayerIndex = useMemo(() => {
    const map: Record<number, number> = {};
    groupAssignmentTargets.forEach((target, layerIndex) => {
      target.selectedGroupIds
        .map(groupByteToCompositorBucket)
        .filter((bucket): bucket is number => bucket !== null && bucket > 0)
        .forEach((bucket) => { map[bucket] = layerIndex; });
    });
    if (baseTextureTransform) {
      const baseLayerIndex = groupAssignmentTargets.length;
      for (const bucket of activeGroupBuckets) {
        if (map[bucket] === undefined) map[bucket] = baseLayerIndex;
      }
    }
    return map;
  }, [activeGroupBuckets, baseTextureTransform, groupAssignmentTargets]);
  const activeGroupAssignmentTarget = groupAssignmentTargets[activeEditorSelector]
    ?? groupAssignmentTargets[0]
    ?? null;
  const activeGroupEditTarget = activeGroupAssignmentTarget?.canAssign
    ? activeGroupAssignmentTarget.target
    : null;
  // Keep the focused part cue in the same stable color as this layer's
  // all-layer map entry. This remains useful even when the map itself is
  // hidden: switching layers is enough to establish the cue's color.
  const activeEditorLayerIndex = weaponBaseLayerActive
    ? groupAssignmentTargets.length
    : activeGroupAssignmentTarget === null
    ? 0
    : Math.max(0, groupAssignmentTargets.indexOf(activeGroupAssignmentTarget));

  useEffect(() => {
    if (activeEditorSelector >= editableGroupTargets.length) setActiveEditorSelector(0);
  }, [activeEditorSelector, editableGroupTargets.length]);

  const transformFieldIsDefault = (state: TextureTransformRangeFieldState, fallback: readonly [number, number]) => (
    state.mode === 'fixed' && state.min === fallback[0] && state.max === fallback[1]
  );
  // Aligned with editorSelectors/groupAssignmentTargets (one entry per visible
  // layer), unlike transformDiscovery.targets which is aligned with the raw,
  // undeduplicated groupDiscovery.targets.
  const layerHasTransformEdits = useMemo(() => {
    const layers = editableGroupTargets.map((target) => {
      const operationIndex = groupDiscovery
        ? preferredLayerOccurrenceIndex(groupDiscovery.targets, target)
        : -1;
      const info = operationIndex >= 0 ? transformDiscovery?.targets[operationIndex] : null;
      if (!info) return false;
      return !transformFieldIsDefault(info.rotation, [0, 0])
        || !transformFieldIsDefault(info.scaleUv, [1, 1])
        || !transformFieldIsDefault(info.translateU, [0, 0])
        || !transformFieldIsDefault(info.translateV, [0, 0])
        || info.flipU.allowed
        || info.flipV.allowed;
    });
    const base = baseTextureTransform?.transform;
    if (base) layers.push(
      !transformFieldIsDefault(base.rotation, [0, 0])
      || !transformFieldIsDefault(base.scaleUv, [1, 1])
      || !transformFieldIsDefault(base.translateU, [0, 0])
      || !transformFieldIsDefault(base.translateV, [0, 0])
      || base.flipU.allowed
      || base.flipV.allowed,
    );
    return layers;
  }, [baseTextureTransform, editableGroupTargets, groupDiscovery, transformDiscovery]);

  const layerTransformLocked = useMemo(() => {
    const layers = editableGroupTargets.map((target) => {
      const operationIndex = groupDiscovery
        ? preferredLayerOccurrenceIndex(groupDiscovery.targets, target)
        : -1;
      const info = operationIndex >= 0 ? transformDiscovery?.targets[operationIndex] : null;
      return target.label.trim().toLowerCase() === 'albedo'
        || !info
        || info.blockers.length > 0;
    });
    if (baseTextureTransform) layers.push(
      baseTextureTransform.transformLocked || baseTextureTransform.transform.blockers.length > 0,
    );
    return layers;
  }, [baseTextureTransform, editableGroupTargets, groupDiscovery, transformDiscovery]);

  // Open on the selected weapon whenever this layer actually resolves one of
  // its transform fields from a weapon-local source. Otherwise show the shared
  // value. The user can still change scope afterward because scope itself is
  // deliberately not a dependency of this synchronization.
  useEffect(() => {
    const weaponInfo = weaponBaseLayerActive
      ? baseTextureTransform?.transform
      : activeGroupVisualIndex >= 0 ? transformDiscovery?.targets[activeGroupVisualIndex] : null;
    const sharedInfo = weaponBaseLayerActive
      ? sharedBaseTextureTransform?.transform
      : activeGroupVisualIndex >= 0 ? sharedTransformDiscovery?.targets[activeGroupVisualIndex] : null;
    const differsFromShared = Boolean(weaponInfo && sharedInfo && (
      !transformRangeStatesEqual(weaponInfo.rotation, sharedInfo.rotation)
      || !transformRangeStatesEqual(weaponInfo.scaleUv, sharedInfo.scaleUv)
      || !transformRangeStatesEqual(weaponInfo.translateU, sharedInfo.translateU)
      || !transformRangeStatesEqual(weaponInfo.translateV, sharedInfo.translateV)
      || weaponInfo.flipU.allowed !== sharedInfo.flipU.allowed
      || weaponInfo.flipV.allowed !== sharedInfo.flipV.allowed
    ));
    setTransformScope(differsFromShared ? 'weapon' : 'all');
  }, [
    activeEditorLayerIndex,
    activeGroupVisualIndex,
    editableKitId,
    sharedTransformDiscovery,
    state.weaponKey,
    transformDiscovery,
    baseTextureTransform,
    sharedBaseTextureTransform,
    weaponBaseLayerActive,
  ]);

  // A selected imported paint can be restored before its definition source
  // finishes hydrating. Retry once that source arrives, but never discard a
  // draft if the user is already editing it.
  useEffect(() => {
    if (editorSourceGenerationRef.current === definitions.generation) return;
    if (editableKitId === null) {
      editorSourceGenerationRef.current = definitions.generation;
      return;
    }
    if (editorDirty) return;
    editorSourceGenerationRef.current = definitions.generation;
    void reloadEditor();
  }, [definitions.generation, editableKitId, editorDirty, reloadEditor]);

  // Definitions imported from a proto_defs file join the catalog under their own
  // collection. Everything downstream reads this merged list, so a custom kit is
  // an ordinary catalog entry apart from where its recipe comes from.
  const paintkits = useMemo<PaintkitEntry[]>(() => {
    if (!data) return [];
    return definitions.catalogKits.length
      ? [...data.manifest.paintkits, ...definitions.catalogKits]
      : data.manifest.paintkits;
  }, [data, definitions.catalogKits]);

  const selectedKit: PaintkitEntry | null =
    selectedKitId != null ? paintkits.find((p) => p.id === selectedKitId) ?? null : null;
  const editorDefinitionGeneration = selectedKit && !isCustomKitId(selectedKit.id)
    ? stockEditGeneration
    : definitions.editGeneration;
  useEffect(() => {
    const committedAt = transformDraftCommitGenerationRef.current;
    if (committedAt === null || editorDefinitionGeneration <= committedAt) return;
    transformDraftCommitGenerationRef.current = null;
    transformDraftRef.current = null;
    setTransformDraft(null);
  }, [editorDefinitionGeneration]);
  const selectedMaterialOverrideId = selectedKit?.materialOverrides?.[state.weaponKey] ?? '';
  const selectedAssetKey = selectedKit && state.weaponKey
    ? `${state.weaponKey}|material:${selectedMaterialOverrideId || 'stock'}|package:${packageGeneration}`
    : '';
  // Artwork refs are shared by a paintkit even when its weapon recipe changes.
  // Keep one edit set per paintkit so imported textures follow weapon changes;
  // recipe-specific refs that do not exist on the next weapon are simply unused.
  const assetOverrideScope = selectedKit ? String(selectedKit.id) : '';
  const assetOverrides = assetOverrideCache[assetOverrideScope] ?? EMPTY_OVERRIDES;

  // One entry point for a recipe, whichever catalog the kit came from.
  const { getRecipe: getImportedRecipe } = definitions;
  const resolveRecipe = useCallback(
    (kit: PaintkitEntry, weaponKey: string, team: ControlsState['team'], wearIndex: number) => (
      isCustomKitId(kit.id)
        ? getImportedRecipe(kit.id, weaponKey, team, wearIndex)
        : editorCurrent && editableKitId === kit.id
          ? getStockRecipe(kit.id, weaponKey, team, wearIndex)
          : data?.getRecipe(kit, weaponKey, team, wearIndex) ?? Promise.resolve(null)
    ),
    [data, editableKitId, editorCurrent, getImportedRecipe, getStockRecipe],
  );

  // An import can point at the kit it is meant for: a numeric ZIP wrapper is a
  // conventional paintkit index, and a proto_defs file nominates its first new
  // definition. Either way, switch only when it resolves to a catalog entry;
  // unknown ids leave the current selection alone.
  const suggestedKitId = definitions.suggestedKitId ?? suggestedPaintkitId;
  // Re-importing is a deliberate act, so the same suggestion from a later
  // import applies again; a merely re-rendered catalog does not re-apply it.
  const suggestionToken = definitions.suggestedKitId !== undefined
    ? `defs:${definitions.generation}:${definitions.suggestedKitId}`
    : `pkg:${packageGeneration}:${suggestedPaintkitId}`;
  const appliedSuggestionRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (suggestedKitId === undefined || suggestionToken === appliedSuggestionRef.current || editorDirty) return;
    const kit = paintkits.find((entry) => entry.id === suggestedKitId);
    if (!kit) return;
    appliedSuggestionRef.current = suggestionToken;
    setSelectedKitId(kit.id);
    setState((current) => ({
      ...current,
      weaponKey: kit.weapons.includes(current.weaponKey) ? current.weaponKey : (kit.weapons[0] ?? current.weaponKey),
      team: kit.hasTeamTextures || current.sheen === 'team_shine' ? current.team : 'red',
    }));
  }, [editorDirty, paintkits, suggestedKitId, suggestionToken]);
  const resolvePackageTexture = useCallback((ref: string) => sourceProvider.resolvePreview(ref), [sourceProvider]);
  const manualTextureOverrides = useMemo(
    () => Object.fromEntries(
      Object.entries(assetOverrides.assets).flatMap(([ref, asset]) => asset.output ? [[ref, asset.output]] : []),
    ),
    [assetOverrides],
  );
  const mountedSourcePackage = sourceProvider.package;
  const packageStickerSpecularOverrides = useMemo(
    () => collectPackageStickerSpecularOverrides(
      editorRecipes,
      (ref) => Boolean(sourceProvider.packagePathFor(ref)),
    ),
    // SourceTextureProvider keeps a stable identity while its mounted package
    // changes internally, so generation is the required invalidation token.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [editorRecipes, packageGeneration, sourceProvider],
  );
  const activeTextureOverrides = useMemo(() => ({
    ...packageStickerSpecularOverrides,
    ...manualTextureOverrides,
  }), [manualTextureOverrides, packageStickerSpecularOverrides]);
  const mountedMaterialPaths = useMemo(
    () => mountedSourcePackage ? indexPackageMaterialPaths(mountedSourcePackage) : null,
    [mountedSourcePackage],
  );
  const allStickerTextureChoices = useMemo(() => {
    const choices = new Map<string, { ref: string; label: string; thumbnail?: string | null }>();
    for (const reference of Object.keys(data?.manifest.textures ?? {})) {
      if (!isStickerArtworkReference(reference)) continue;
      const ref = protoTextureReference(reference);
      choices.set(ref, { ref, label: textureChoiceLabel(reference), thumbnail: data?.resolveTexture(reference) });
    }
    for (const [reference, thumbnail] of Object.entries(activeTextureOverrides)) {
      if (!isStickerArtworkReference(reference)) continue;
      const ref = protoTextureReference(reference);
      choices.set(ref, { ref, label: textureChoiceLabel(reference), thumbnail });
    }
    for (const entry of mountedSourcePackage?.entries.values() ?? []) {
      if (!isSupportedTexturePath(entry.path) || !isStickerArtworkReference(entry.path)) continue;
      const ref = protoTextureReference(entry.path);
      if (!choices.has(ref)) choices.set(ref, { ref, label: textureChoiceLabel(entry.path) });
    }
    return [...choices.values()].sort((a, b) => a.label.localeCompare(b.label) || a.ref.localeCompare(b.ref));
  }, [activeTextureOverrides, data, mountedSourcePackage]);

  useEffect(() => {
    if (editableKitId === null || !selectedKit || !state.weaponKey) {
      setLoadedStickerRecipe(null);
      return;
    }
    let cancelled = false;
    const resolver = isCustomKitId(editableKitId)
      ? getImportedRecipeWithProvenance
      : getStockRecipeWithProvenance;
    void resolver(editableKitId, state.weaponKey, state.team, state.wearIndex).then((resolved) => {
      if (!cancelled) setLoadedStickerRecipe({ key: stickerRecipeKey, recipe: resolved });
    });
    return () => { cancelled = true; };
  }, [
    definitions,
    definitions.editGeneration,
    stockEditGeneration,
    getImportedRecipeWithProvenance,
    getStockRecipeWithProvenance,
    editableKitId,
    editorCurrent,
    selectedKit,
    stickerRecipeKey,
    state.team,
    state.weaponKey,
    state.wearIndex,
  ]);

  const stickerTargets = useMemo(
    () => editorCurrent ? discoverStickerPlacementTargets(editorCurrent, stickerRecipe) : [],
    [editorCurrent, stickerRecipe],
  );

  useEffect(() => {
    const previewUrlLeases = operationGraphPreviewUrlLeasesRef.current;
    const disposePreviews = () => {
      for (const lease of previewUrlLeases.values()) lease.dispose();
      previewUrlLeases.clear();
      setOperationGraphPreviewUrls({});
    };
    disposePreviews();
    if (!operationGraph || paintSubView !== 'graph' || !stickerRecipe || !engineReady) return;
    const compositor = compositorRef.current;
    if (!compositor) return;
    let cancelled = false;
    const previewNodes = operationGraph.nodes.filter((node) => (
      node.kind !== 'output'
      && node.kind !== 'operation_template'
      && node.kind !== 'invalid'
    ));
    const render = async (): Promise<void> => {
      let completedBatch: Record<string, string> = {};
      let completedBatchSize = 0;
      const publishBatch = (): void => {
        if (completedBatchSize === 0) return;
        const published = completedBatch;
        completedBatch = {};
        completedBatchSize = 0;
        setOperationGraphPreviewUrls((current) => ({ ...current, ...published }));
      };
      for (const node of previewNodes) {
        const result = await composeOperationGraphNode(compositor, {
          graph: operationGraph,
          nodeId: node.id,
          recipeRoots: stickerRecipe.tree,
          seed: state.seed,
          dimensions: { width: 256, height: 256 },
        } as const);
        if (cancelled) {
          if (result.ok) result.render.dispose();
          return;
        }
        if (!result.ok) continue;
        try {
          const urlLease = await operationGraphPreviewObjectUrl(result.render, { maxDimension: 180 });
          if (cancelled) {
            urlLease.dispose();
            return;
          }
          previewUrlLeases.set(node.id, urlLease);
          completedBatch[node.id] = urlLease.url;
          completedBatchSize += 1;
          if (completedBatchSize >= 6) publishBatch();
        } catch {
          // Individual unsupported previews do not block the rest of the graph.
        } finally {
          result.render.dispose();
        }
      }
      if (!cancelled) publishBatch();
    };
    void render().catch(() => undefined);
    return () => {
      cancelled = true;
      disposePreviews();
    };
  }, [compositorRef, editorRevision, engineReady, operationGraph, paintSubView, state.seed, stickerRecipe]);

  const exportOperationGraphNode = useCallback(async (
    nodeId: string,
    format: OperationGraphExportFormat,
  ): Promise<void> => {
    if (!operationGraph || !stickerRecipe || !compositorRef.current) return;
    const result = await composeOperationGraphNode(compositorRef.current, {
      graph: operationGraph,
      nodeId,
      recipeRoots: stickerRecipe.tree,
      seed: state.seed,
      dimensions: { width: 1024, height: 1024 },
    });
    if (!result.ok) return;
    const render = result.render;
    try {
      const node = operationGraph.nodes.find((candidate) => candidate.id === nodeId);
      const stage = node?.raw?.stage;
      const sourceField = stage?.texture_lookup?.texture
        ?? stage?.texture_lookup?.texture_red
        ?? stage?.texture_lookup?.texture_blue
        ?? stage?.select?.groups;
      const sourceHint = sourceField?.variable ?? sourceField?.string;
      const stageIndex = operationGraph.nodes
        .filter((candidate) => candidate.kind !== 'output')
        .findIndex((candidate) => candidate.id === nodeId) + 1;
      const parts = [
        selectedKit?.name ?? 'warpaint',
        state.weaponKey.replace(/^c_/, '') || 'weapon',
        state.team,
        data?.manifest.wearNames[state.wearIndex] ?? `wear-${state.wearIndex}`,
        `stage-${String(stageIndex).padStart(2, '0')}`,
        node?.label ?? 'operation',
        sourceHint?.replaceAll('\\', '/').split('/').at(-1),
      ];
      const fileBase = parts
        .filter((part): part is string => Boolean(part))
        .map((part) => part.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
        .filter(Boolean)
        .join('_')
        .slice(0, 160) || 'warpaint_stage';
      if (format === 'png') {
        downloadBytes(await exportOperationGraphPng(render, { maxDimension: 1024 }), `${fileBase}.png`, 'image/png');
      } else {
        downloadBytes(exportOperationGraphVtf(render), `${fileBase}.vtf`, 'application/octet-stream');
      }
    } catch (cause) {
      setOperationGraphEditError(cause instanceof Error ? cause.message : 'The graph node could not be exported.');
    } finally {
      render.dispose();
    }
  }, [compositorRef, data?.manifest.wearNames, operationGraph, selectedKit?.name, state.seed, state.team, state.wearIndex, state.weaponKey, stickerRecipe]);
  const currentStickerTextureChoices = useMemo(() => {
    const choices = new Map(allStickerTextureChoices.map((choice) => [choice.ref, choice]));
    const generatedReferences = Object.keys(data?.manifest.textures ?? {});
    const generatedReferencesByProtoRef = new Map(
      generatedReferences.map((reference) => [protoTextureReference(reference), reference]),
    );
    const referenced = stickerTargets.flatMap((target) => target.stickers.flatMap((sticker) => {
      const value = sticker.base.resolvedValue ?? sticker.base.authoredValue;
      if (!value) return [];
      try {
        const ref = protoTextureReference(value);
        if (!choices.has(ref)) {
          const generated = generatedReferencesByProtoRef.get(ref);
          choices.set(ref, {
            ref,
            label: textureChoiceLabel(value),
            thumbnail: generated ? data?.resolveTexture(generated) : undefined,
          });
        }
        return [ref];
      } catch { return []; }
    }));
    return [...new Set(referenced)].flatMap((ref) => choices.get(ref) ?? []);
  }, [allStickerTextureChoices, data, stickerTargets]);
  const resolvedStickerRecipe = useMemo(
    () => transformPreviewRecipe ? resolveSeededRecipe(transformPreviewRecipe, state.seed) : null,
    [state.seed, transformPreviewRecipe],
  );
  const activeTransformIsolationNode = useMemo(() => {
    const mapReference = (reference: string) => activeTextureOverrides[reference] ?? reference;
    if (weaponBaseLayerActive) {
      if (!activeTransformLayerNode) return null;
      return mapResolvedTextureReferences(resolveSeededRecipe(activeTransformLayerNode, state.seed), mapReference);
    }
    if (!resolvedStickerRecipe || activeGroupVisualIndex < 0) return null;
    const resolved = mapResolvedTextureReferences(resolvedStickerRecipe, mapReference);
    return collectResolvedLayerIsolationNodes(resolved)[activeGroupVisualIndex] ?? null;
  }, [activeGroupVisualIndex, activeTextureOverrides, activeTransformLayerNode, resolvedStickerRecipe, state.seed, weaponBaseLayerActive]);
  const activeSeedTransform = useMemo(() => {
    if (weaponBaseLayerActive) {
      if (!activeTransformLayerNode) return null;
      const resolvedBase = resolveSeededRecipe(activeTransformLayerNode, state.seed);
      return resolvedBase.type === 'texture_lookup' ? resolvedBase : null;
    }
    if (!resolvedStickerRecipe) return null;
    if (activeGroupVisualIndex < 0) return null;
    return collectResolvedLayerTextureNodes(resolvedStickerRecipe)[activeGroupVisualIndex] ?? null;
  }, [activeGroupVisualIndex, activeTransformLayerNode, resolvedStickerRecipe, state.seed, weaponBaseLayerActive]);

  useEffect(() => {
    if (paintSubView !== 'transform' || editableKitId === null
      || (!weaponBaseLayerActive && activeGroupVisualIndex < 0) || !activeTransformTargetInfo) {
      setTransformDivergence({});
      return;
    }
    const resolver = isCustomKitId(editableKitId)
      ? getImportedRecipeWithProvenance
      : getStockRecipeWithProvenance;
    const currentValues: Record<keyof TextureTransformFields, SeedRangeValue> = {
      rotation: transformRangeFieldValue(activeTransformTargetInfo.rotation, TRANSFORM_FIELD_DEFAULTS.rotation),
      scale: transformRangeFieldValue(activeTransformTargetInfo.scaleUv, TRANSFORM_FIELD_DEFAULTS.scale),
      offsetU: transformRangeFieldValue(activeTransformTargetInfo.translateU, TRANSFORM_FIELD_DEFAULTS.offsetU),
      offsetV: transformRangeFieldValue(activeTransformTargetInfo.translateV, TRANSFORM_FIELD_DEFAULTS.offsetV),
    };
    const sameRange = (left: SeedRangeValue, right: SeedRangeValue) => (
      left.mode === right.mode && left.min === right.min && left.max === right.max
    );
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      void Promise.all([...new Set(weaponSlots.map((slot) => slot.weaponKey))].map(async (weaponKey) => {
        const recipe = await resolver(editableKitId, weaponKey, state.team, state.wearIndex);
        if (!recipe || !editorCurrent) return null;
        const info = weaponBaseLayerActive
          ? discoverBaseTextureTransformTarget(editorCurrent, recipe.provenance)?.transform
          : discoverTextureTransformTargets(editorCurrent, recipe.provenance).targets[activeGroupVisualIndex];
        if (!info) return null;
        const values: Record<keyof TextureTransformFields, SeedRangeValue> = {
          rotation: transformRangeFieldValue(info.rotation, TRANSFORM_FIELD_DEFAULTS.rotation),
          scale: transformRangeFieldValue(info.scaleUv, TRANSFORM_FIELD_DEFAULTS.scale),
          offsetU: transformRangeFieldValue(info.translateU, TRANSFORM_FIELD_DEFAULTS.offsetU),
          offsetV: transformRangeFieldValue(info.translateV, TRANSFORM_FIELD_DEFAULTS.offsetV),
        };
        return { weaponKey, values };
      })).then((rows) => {
        if (cancelled) return;
        const next: Partial<Record<keyof TextureTransformFields, SeedRangeDivergence>> = {};
        for (const key of Object.keys(currentValues) as (keyof TextureTransformFields)[]) {
          const weapons = rows.flatMap((row) => row && !sameRange(row.values[key], currentValues[key])
            ? [data?.manifest.weapons.find((weapon) => weapon.key === row.weaponKey)?.name ?? row.weaponKey]
            : []);
          if (weapons.length > 0) next[key] = { count: weapons.length, weapons };
        }
        setTransformDivergence(next);
      }).catch(() => {
        if (!cancelled) setTransformDivergence({});
      });
    }, 180);
    return () => { cancelled = true; window.clearTimeout(timeout); };
  }, [
    activeGroupVisualIndex,
    activeTransformTargetInfo,
    data,
    editableKitId,
    editorCurrent,
    getImportedRecipeWithProvenance,
    getStockRecipeWithProvenance,
    paintSubView,
    state.team,
    state.wearIndex,
    weaponSlots,
    weaponBaseLayerActive,
    definitions.editGeneration,
    stockEditGeneration,
  ]);

  const resolvedStickerStages = useMemo(
    () => resolvedStickerRecipe ? collectAppliedStickers(resolvedStickerRecipe) : [],
    [resolvedStickerRecipe],
  );
  const matchedStickerStageGroups = useMemo(() => matchResolvedStickerArtworkGroups(
    stickerTargets.map((target) => ({
      bases: target.stickers.flatMap((sticker) => [sticker.base.resolvedValue, sticker.base.authoredValue]),
      quad: target.quad,
      occurrenceCount: target.occurrences.length,
    })),
    resolvedStickerStages,
  ), [resolvedStickerStages, stickerTargets]);
  const matchedStickerStages = useMemo(
    () => matchedStickerStageGroups.map((stages) => stages[0] ?? null),
    [matchedStickerStageGroups],
  );
  const selectedStickerIndex = stickerTargets[activeStickerTarget] ? activeStickerTarget : (stickerTargets.length > 0 ? 0 : -1);
  const selectedStickerTarget = selectedStickerIndex >= 0 ? stickerTargets[selectedStickerIndex] : null;
  const composedStickerTargetIds = useMemo(() => new Set(stickerTargets.filter((target) => (
    stickerArtworkNeedsComposedPreview(target.stickers.flatMap((sticker) => [
      sticker.base.resolvedValue,
      sticker.base.authoredValue,
    ]))
  )).map((target) => target.id)), [stickerTargets]);
  const selectedStickerUsesComposedArtwork = selectedStickerTarget
    ? composedStickerTargetIds.has(selectedStickerTarget.id)
    : false;
  const selectedResolvedStickerStages = useMemo(() => {
    if (selectedStickerIndex < 0) return [];
    return matchedStickerStageGroups[selectedStickerIndex] ?? [];
  }, [matchedStickerStageGroups, selectedStickerIndex]);
  const selectedStickerSpecularRef = (() => {
    const sticker = selectedResolvedStickerStages[0];
    if (!sticker) return null;
    if (sticker.spec) return sticker.spec;
    const inferred = stickerSpecularRef(sticker.base);
    return packageStickerSpecularOverrides[inferred] || manualTextureOverrides[inferred] ? inferred : null;
  })();
  const selectedGroupStickerContext = useMemo(() => {
    if (!selectedStickerUsesComposedArtwork || selectedResolvedStickerStages.length === 0 || !resolvedStickerRecipe) return null;
    const context = resolvedGroupStickerContext(resolvedStickerRecipe, selectedResolvedStickerStages);
    if (!context) return null;
    const mapReference = (reference: string) => activeTextureOverrides[reference] ?? reference;
    return {
      ...context,
      base: mapResolvedTextureReferences(context.base, mapReference),
      selectorBase: mapResolvedTextureReferences(context.selectorBase, mapReference),
      endpointZero: mapResolvedTextureReferences(context.endpointZero, mapReference),
      endpointOne: mapResolvedTextureReferences(context.endpointOne, mapReference),
    };
  }, [activeTextureOverrides, resolvedStickerRecipe, selectedResolvedStickerStages, selectedStickerUsesComposedArtwork]);
  const authoredStickerQuad = selectedStickerTarget?.quad ?? null;
  const stickerPlacementRead = useMemo(
    () => authoredStickerQuad ? stickerPlacementFromQuad(authoredStickerQuad) : { editable: false as const },
    [authoredStickerQuad],
  );
  const stickerPlacement = stickerDraftQuad
    ? stickerPlacementFromQuad(stickerDraftQuad).placement
    : stickerPlacementRead.placement;
  const stickerTargetEditable = Boolean(selectedStickerTarget?.editable && authoredStickerQuad);
  const stickerEditorEnabled = Boolean(stickerTargetEditable && stickerPlacement);
  // Retain the complete paint recipe and remove only this exact sticker
  // occurrence. A selected stage can sit within combines or beside other
  // stickers, so composing only its immediate child would lose visible work.
  const stickerSurfaceNode = useMemo(
    () => selectedStickerTarget
      ? recipeWithoutStickerOccurrences(stickerRecipe?.tree ?? null, selectedStickerTarget.occurrences)
      : null,
    [selectedStickerTarget, stickerRecipe],
  );
  // Destination points are absent from this replacement recipe. It therefore
  // remains stable while a sticker moves, but changes for a distinct base,
  // weapon, seed, or texture override.
  const stickerSurfaceComposeKey = useMemo(() => {
    if (!stickerSurfaceNode) return null;
    return JSON.stringify({
      recipe: stickerSurfaceNode,
      seed: state.seed,
      overrides: activeTextureOverrides,
      weapon: state.weaponKey,
    });
  }, [activeTextureOverrides, state.seed, state.weaponKey, stickerSurfaceNode]);
  const groupStickerComposeKey = selectedStickerUsesComposedArtwork && selectedStickerTarget
    && selectedGroupStickerContext && stickerSurfaceComposeKey
    ? `${selectedStickerTarget.id}\0${stickerSurfaceComposeKey}\0${activeTextureOverrides[selectedGroupStickerContext.sticker.base] ?? selectedGroupStickerContext.sticker.base}\0${selectedGroupStickerContext.sticker.black}\0${selectedGroupStickerContext.sticker.white}\0${selectedGroupStickerContext.sticker.gamma}`
    : null;
  groupStickerPreparationRef.current = selectedStickerTarget && selectedGroupStickerContext
    ? { targetId: selectedStickerTarget.id, context: selectedGroupStickerContext }
    : null;
  const preparedGroupStickerArtwork = selectedStickerTarget
    ? groupStickerArtwork[selectedStickerTarget.id]
    : null;
  const stickerTextureUrl = selectedStickerTarget
    ? selectedStickerUsesComposedArtwork
      ? preparedGroupStickerArtwork?.key === groupStickerComposeKey
        ? preparedGroupStickerArtwork.url
        : null
      : stickerTargetArtwork[selectedStickerTarget.id] ?? null
    : null;
  const exactGroupStickerResources = groupStickerResourcesKey === groupStickerComposeKey
    ? groupStickerResourcesRef.current
    : null;
  // The local draft remains authoritative from pointer release until the
  // asynchronous provenance recipe exposes the committed destination. The
  // selected sticker's base and artwork are destination-independent, so keep
  // using the retained resources during that handoff instead of briefly
  // disabling the editor and flashing the preparation state.
  const destinationEditSettling = Boolean(stickerDraftQuad && selectedStickerTarget);
  const retainedGroupStickerResources = destinationEditSettling
    && groupStickerResourcesRef.current?.targetId === selectedStickerTarget?.id
    ? groupStickerResourcesRef.current
    : null;
  const activeGroupStickerResources = exactGroupStickerResources ?? retainedGroupStickerResources;
  const effectiveStickerTextureUrl = stickerTextureUrl
    ?? (selectedStickerUsesComposedArtwork ? retainedGroupStickerResources?.artworkUrl ?? null : null);

  useEffect(() => {
    setStickerSpecularUrl(null);
    if (selectedStickerUsesComposedArtwork || !selectedStickerSpecularRef) return;
    let cancelled = false;
    const override = manualTextureOverrides[selectedStickerSpecularRef];
    void (override ? Promise.resolve(override) : sourceProvider.resolvePreview(selectedStickerSpecularRef))
      .then((url) => { if (!cancelled) setStickerSpecularUrl(url); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [
    manualTextureOverrides,
    packageGeneration,
    selectedStickerSpecularRef,
    selectedStickerUsesComposedArtwork,
    sourceProvider,
  ]);
  const groupStickerUvPreview = selectedStickerUsesComposedArtwork
    && activeGroupStickerResources
    ? {
        maskSrc: activeGroupStickerResources.maskUrl,
        selectorBaseSrc: activeGroupStickerResources.selectorBaseUrl,
        endpointZeroSrc: activeGroupStickerResources.endpointZeroUrl,
        endpointOneSrc: activeGroupStickerResources.endpointOneUrl,
        levels: activeGroupStickerResources.levels,
      }
    : null;
  // A direct manipulation must always have the same stripped base in both
  // views. Until that target and the artwork are ready, show preparation - not
  // a draggable sticker whose 3D preview can disagree with the UV editor.
  const stickerEditorReady = Boolean(
    stickerEditorEnabled
    && effectiveStickerTextureUrl
    && (stickerBaseSurfaceKey === stickerSurfaceComposeKey || destinationEditSettling)
    && stickerBaseSurfaceResultRef.current
    && (!selectedStickerUsesComposedArtwork
      || groupStickerResourcesKey === groupStickerComposeKey
      || activeGroupStickerResources)
  );

  useEffect(() => {
    if (activeStickerTarget >= stickerTargets.length) setActiveStickerTarget(0);
    if (stickerTargets.length === 0 && editorTool === 'sticker') setEditorTool('paint');
  }, [activeStickerTarget, editorTool, stickerTargets.length]);

  useEffect(() => {
    if (!pendingAddedStickerRef) return;
    const addedIndex = stickerTargets.findLastIndex((target) => target.stickers.some((sticker) => (
      sticker.base.resolvedValue === pendingAddedStickerRef
      || sticker.base.authoredValue === pendingAddedStickerRef
    )));
    if (addedIndex < 0) return;
    setActiveStickerTarget(addedIndex);
    setPendingAddedStickerRef(null);
  }, [pendingAddedStickerRef, stickerTargets]);

  useEffect(() => {
    updateStickerDraft(null);
  }, [activeStickerTarget, editableKitId, state.weaponKey, updateStickerDraft]);

  useEffect(() => {
    viewerRef.current?.resetStickerGizmoAnchor();
  }, [selectedStickerTarget?.id, editableKitId, state.weaponKey]);

  useEffect(() => {
    // A completed gesture stays visually authoritative while the edited
    // proto source re-resolves. Releasing it merely because an intermediate
    // recipe still exposes the old quad causes a one-frame snap backwards.
    // History actions clear drafts explicitly through the synchronized
    // wrappers above, so retire this draft only after authored state catches up.
    if (stickerGestureRef.current || stickerGizmoGestureRef.current) return;
    const draft = stickerDraftRef.current;
    if (draft && authoredStickerQuad && stickerQuadsEqual(draft, authoredStickerQuad)) {
      discardStickerDraft();
    }
  }, [authoredStickerQuad, discardStickerDraft]);

  // The sticker list and live decal both show the stage output, not its raw
  // source file. Some Flak Furnished stickers are white masks whose authored
  // levels supply the actual visible colour.
  useEffect(() => {
    let cancelled = false;
    const created = new Map<string, { url: string; dispose(): void }>();
    void (async () => {
      const cache = stickerArtworkCacheRef.current;
      const currentKeys = new Set<string>();
      const entries = await Promise.all(stickerTargets.map(async (target, index) => {
        const resolved = matchedStickerStages[index];
        const ref = resolved?.base ?? target.stickers[0]?.base.resolvedValue;
        if (!ref) return [target.id, null] as const;
        try {
          // Group artwork is generated by the compositor effect below from
          // the original mask plus both selector endpoints. A raw c0/c1 source
          // is not a truthful preview, most visibly for black selector blocks.
          if (composedStickerTargetIds.has(target.id)) return [target.id, null] as const;
          const sourceUrl = activeTextureOverrides[ref] ?? await sourceProvider.resolvePreview(ref);
          const levels = {
            black: resolved?.black ?? 0,
            white: resolved?.white ?? 1,
            gamma: resolved?.gamma ?? 1,
          };
          const key = `${target.id}\0decal\0${sourceUrl}\0${levels.black}\0${levels.white}\0${levels.gamma}`;
          currentKeys.add(key);
          let artwork = cache.get(key);
          if (!artwork) {
            artwork = await prepareStickerArtwork(sourceUrl, levels);
            created.set(key, artwork);
            cache.set(key, artwork);
          }
          return [target.id, artwork.url, artwork.url] as const;
        } catch {
          return [target.id, null] as const;
        }
      }));
      if (cancelled) {
        for (const [key, artwork] of created) {
          if (cache.get(key) === artwork) cache.delete(key);
          artwork.dispose();
        }
        return;
      }
      const nextArtwork: Record<string, string> = {};
      const nextThumbnails: Record<string, string> = {};
      for (const [id, artworkUrl, thumbnailUrl] of entries) {
        if (artworkUrl) nextArtwork[id] = artworkUrl;
        if (thumbnailUrl) nextThumbnails[id] = thumbnailUrl;
      }
      setStickerTargetArtwork(nextArtwork);
      setStickerTargetThumbnails(nextThumbnails);
      for (const [key, artwork] of cache) {
        if (currentKeys.has(key)) continue;
        cache.delete(key);
        artwork.dispose();
      }
    })().catch(() => {
      for (const [key, artwork] of created) {
        if (stickerArtworkCacheRef.current.get(key) === artwork) stickerArtworkCacheRef.current.delete(key);
        artwork.dispose();
      }
    });
    return () => { cancelled = true; };
  }, [
    activeTextureOverrides,
    composedStickerTargetIds,
    matchedStickerStages,
    packageGeneration,
    sourceProvider,
    stickerTargets,
  ]);

  // A prepared group image is tied to its paint/weapon/seed context, but not
  // to its destination. Destination-only edits keep the isolated artwork and
  // therefore stay instantaneous.
  useEffect(() => {
    setGroupStickerArtwork({});
  }, [editableKitId, packageGeneration, state.seed, state.team, state.wearIndex, state.weaponKey]);

  useEffect(() => () => {
    for (const artwork of stickerArtworkCacheRef.current.values()) artwork.dispose();
    stickerArtworkCacheRef.current.clear();
  }, []);

  // Every sticker uses a retained base with its stage removed plus a lightweight
  // UV overlay. Group stickers keep the same base, but reconstruct their layer
  // selector from the full source mask instead of a destination crop.
  useEffect(() => {
    const viewer = viewerRef.current;
    const compositor = compositorRef.current;
    const discardCurrentBase = () => {
      viewer?.clearStickerPreview();
      viewer?.setStickerEditorBaseMap(null);
      const current = stickerBaseSurfaceResultRef.current;
      stickerBaseSurfaceResultRef.current = null;
      if (current && compositor) compositor.releaseResult(current);
      setStickerBaseSurfaceKey(null);
    };

    if (!engineReady || editorTool !== 'sticker' || !data || !stickerSurfaceNode || !stickerSurfaceComposeKey) {
      discardCurrentBase();
      setStickerSurfaceUrl(null);
      return;
    }
    const weapon = data.manifest.weapons.find((entry) => entry.key === state.weaponKey);
    if (!compositor || !weapon) return;
    // A destination-only edit leaves the stripped recipe unchanged. Retain the
    // base texture so a committed new location never drops its live overlay
    // while the normal full composite catches up asynchronously.
    if (stickerBaseSurfaceKey === stickerSurfaceComposeKey && stickerBaseSurfaceResultRef.current) return;

    discardCurrentBase();
    setStickerSurfaceUrl(null);
    let cancelled = false;
    const dimensions = {
      width: weapon.compositeWidth ?? 1024,
      height: weapon.compositeHeight ?? 1024,
    };
    const composition = selectedGroupStickerContext
      ? compositor.composeResolved(selectedGroupStickerContext.base, dimensions)
      : compositor.compose(applyTextureOverrides(stickerSurfaceNode, activeTextureOverrides), state.seed, dimensions);
    void composition.then((result) => {
      if (cancelled) {
        compositor.releaseResult(result);
        return;
      }
      stickerBaseSurfaceResultRef.current = result;
      setStickerSurfaceUrl(compositor.toPreviewDataUrl(result.target));
      setStickerBaseSurfaceKey(stickerSurfaceComposeKey);
    }).catch(() => {
      if (!cancelled) setStickerBaseSurfaceKey(null);
    });
    return () => { cancelled = true; };
  }, [
    activeTextureOverrides,
    data,
    editorTool,
    engineReady,
    packageGeneration,
    state.seed,
    state.weaponKey,
    selectedGroupStickerContext,
    stickerBaseSurfaceKey,
    stickerSurfaceComposeKey,
    stickerSurfaceNode,
  ]);

  // A group sticker writes into a layer selector, rather than behaving like a
  // normal RGBA decal. Compose the selector without this sticker and the two
  // final selector endpoints once. Live movement then samples these retained
  // textures in Viewer and changes only destination uniforms.
  useEffect(() => {
    const compositor = compositorRef.current;
    const viewer = viewerRef.current;
    const preparation = groupStickerPreparationRef.current;
    const release = (resources: typeof groupStickerResourcesRef.current) => {
      if (!resources || !compositor) return;
      compositor.releaseResult(resources.selectorBase);
      compositor.releaseResult(resources.endpointZero);
      compositor.releaseResult(resources.endpointOne);
    };
    const previous = groupStickerResourcesRef.current;
    if (previous?.key === groupStickerComposeKey) {
      setGroupStickerResourcesKey(groupStickerComposeKey);
      return;
    }
    if (previous) {
      viewer?.clearStickerPreview();
      groupStickerResourcesRef.current = null;
      release(previous);
    }
    setGroupStickerResourcesKey(null);

    if (!engineReady || editorTool !== 'sticker' || !data || !compositor
      || !preparation || !groupStickerComposeKey) return;
    const weapon = data.manifest.weapons.find((entry) => entry.key === state.weaponKey);
    if (!weapon) return;
    let cancelled = false;
    const produced: ComposeResult[] = [];
    const dimensions = {
      width: weapon.compositeWidth ?? 1024,
      height: weapon.compositeHeight ?? 1024,
    };
    const compose = async (node: ResolvedNode) => {
      const result = await compositor.composeResolved(node, dimensions);
      produced.push(result);
      return result;
    };
    void (async () => {
      const { context, targetId } = preparation;
      const maskRef = context.sticker.base;
      const maskUrl = activeTextureOverrides[maskRef] ?? await sourceProvider.resolvePreview(maskRef);
      const selectorBase = await compose(context.selectorBase);
      const endpointZero = await compose(context.endpointZero);
      const endpointOne = await compose(context.endpointOne);
      const selectorBaseUrl = compositor.toPreviewDataUrl(selectorBase.target);
      const endpointZeroUrl = compositor.toPreviewDataUrl(endpointZero.target);
      const endpointOneUrl = compositor.toPreviewDataUrl(endpointOne.target);
      const levels = [
        context.sticker.black,
        context.sticker.white,
        context.sticker.gamma,
      ] as const;
      const artworkUrl = await compositor.composeGroupStickerArtworkDataUrl({
        mask: maskRef,
        selectorBase: selectorBase.texture,
        endpointZero: endpointZero.texture,
        endpointOne: endpointOne.texture,
        levels,
        destTl: context.sticker.destTl,
        destTr: context.sticker.destTr,
        destBl: context.sticker.destBl,
      });
      if (cancelled) {
        for (const result of produced) compositor.releaseResult(result);
        return;
      }
      groupStickerResourcesRef.current = {
        key: groupStickerComposeKey,
        targetId,
        maskUrl,
        selectorBase,
        selectorBaseUrl,
        endpointZero,
        endpointZeroUrl,
        endpointOne,
        endpointOneUrl,
        artworkUrl,
        levels,
      };
      setGroupStickerArtwork((current) => ({
        ...current,
        [targetId]: { key: groupStickerComposeKey, url: artworkUrl },
      }));
      setGroupStickerResourcesKey(groupStickerComposeKey);
    })().catch(() => {
      for (const result of produced) compositor.releaseResult(result);
      if (!cancelled) setGroupStickerResourcesKey(null);
    });

    return () => {
      cancelled = true;
      const current = groupStickerResourcesRef.current;
      if (current?.key === groupStickerComposeKey) {
        viewer?.clearStickerPreview();
        groupStickerResourcesRef.current = null;
        release(current);
      }
    };
  }, [
    activeTextureOverrides,
    data,
    editorTool,
    engineReady,
    groupStickerComposeKey,
    sourceProvider,
    state.weaponKey,
  ]);

  // The composed target is owned by the editor while its texture is installed
  // as Viewer's temporary base. Release it only when the base is abandoned or
  // the app unmounts - not on ordinary state renders, which would leave a live
  // material pointing at a render target returned to the compositor pool.
  useEffect(() => () => {
    const result = stickerBaseSurfaceResultRef.current;
    stickerBaseSurfaceResultRef.current = null;
    viewerRef.current?.setStickerEditorBaseMap(null);
    if (result) compositorRef.current?.releaseResult(result);
  }, [compositorRef, viewerRef]);

  useEffect(() => {
    let cancelled = false;
    const measure = (url: string | null, fallback: number, install: (value: number) => void) => {
      if (!url) {
        install(fallback);
        return;
      }
      const image = new Image();
      image.onload = () => {
        if (!cancelled && image.naturalWidth > 0 && image.naturalHeight > 0) {
          install(image.naturalWidth / image.naturalHeight);
        }
      };
      image.onerror = () => { if (!cancelled) install(fallback); };
      image.src = url;
    };
    measure(effectiveStickerTextureUrl, 1, setStickerAspect);
    measure(stickerSurfaceUrl, 1.6, setStickerSurfaceAspect);
    return () => { cancelled = true; };
  }, [effectiveStickerTextureUrl, stickerSurfaceUrl]);
  // Selection edits recreate the assignment target objects, but preserve this
  // layer order and each texture reference. The chooser is deterministic, so
  // re-evaluation after an assignment cannot reshuffle layer colours.
  const editableLayerTextureRefs = useMemo(
    () => groupAssignmentTargets.map((target) => target.textureRef),
    [groupAssignmentTargets],
  );
  const layerColorTextureRefs = useMemo(
    () => baseLayerTextureRef
      ? [...editableLayerTextureRefs, baseLayerTextureRef]
      : editableLayerTextureRefs,
    [baseLayerTextureRef, editableLayerTextureRefs],
  );

  useEffect(() => {
    const generation = `${packageGeneration}:${definitions.generation}:${assetOverrides.revision}`;
    if (layerThumbnailGenerationRef.current !== generation) {
      layerThumbnailGenerationRef.current = generation;
      layerThumbnailCacheRef.current.clear();
    }
    const refs = [...new Set(layerColorTextureRefs
      .filter((ref): ref is string => Boolean(ref)))];
    if (refs.length === 0) {
      setLayerTextureThumbnails({});
      setLayerTexturePreviewUrls({});
      return;
    }
    let cancelled = false;
    void Promise.all(refs.map(async (ref) => {
      try {
        const overrideUrl = activeTextureOverrides[ref];
        const stockThumbnailUrl = !overrideUrl && data?.manifest.textures?.[ref]
          ? `${import.meta.env.BASE_URL}data/thumbnails/${ref}`
          : null;
        const load = (url: string) => {
          const cacheKey = `${generation}\u0000${url}`;
          let thumbnail = layerThumbnailCacheRef.current.get(cacheKey);
          if (!thumbnail) {
            thumbnail = loadRgbaThumbnail(url).catch(() => null);
            layerThumbnailCacheRef.current.set(cacheKey, thumbnail);
          }
          return thumbnail;
        };
        let url = stockThumbnailUrl ?? overrideUrl ?? await sourceProvider.resolveThumbnail(ref);
        let pixels = await load(url);
        // Community definitions may assign a shipped texture that no stock
        // paint uses as a layer. Such refs have no generated thumbnail, so use
        // the same lazy exact path as an imported image instead of showing grey.
        if (!pixels && stockThumbnailUrl) {
          url = await sourceProvider.resolveThumbnail(ref);
          pixels = await load(url);
        }
        // Layer rows are identification aids, not a composited preview. Show
        // the authored RGB at full opacity so translucent masks remain easy to
        // tell apart at this small size.
        return [
          ref,
          pixels,
          pixels ? url === stockThumbnailUrl ? url : rgbaThumbnailDataUrl(pixels) : null,
        ] as const;
      } catch {
        return [ref, null, null] as const;
      }
    })).then((entries) => {
      if (cancelled) return;
      const next = Object.fromEntries(entries.map(([ref, thumbnail]) => [ref, thumbnail]));
      const nextUrls = Object.fromEntries(entries.map(([ref, , url]) => [ref, url]));
      setLayerTextureThumbnails((current) => {
        const keys = Object.keys(next);
        return keys.length === Object.keys(current).length
          && keys.every((key) => current[key] === next[key])
          ? current
          : next;
      });
      setLayerTexturePreviewUrls(nextUrls);
    });
    return () => { cancelled = true; };
  }, [
    activeTextureOverrides,
    assetOverrides.revision,
    definitions.generation,
    data?.manifest.textures,
    layerColorTextureRefs,
    packageGeneration,
    sourceProvider,
  ]);

  const editorLayerColors = useMemo(() => chooseEditorLayerColors(
    layerColorTextureRefs.map((textureRef, index) => ({
      thumbnail: textureRef ? layerTextureThumbnails[textureRef] : null,
      fallbackIndex: index,
    })),
  ), [layerColorTextureRefs, layerTextureThumbnails]);
  const activeEditorLayerColor = editorLayerColors[activeEditorLayerIndex]
    ?? EDITOR_LAYER_MAP_COLORS[activeEditorLayerIndex % EDITOR_LAYER_MAP_COLORS.length];
  // editorLayerColors are linear 0..1 triples, matching the shader math the
  // Viewer overlay uses. CSS colours are sRGB, so the context column swatches
  // and the parts board squares need their own converted copy or they will
  // read lighter than the on-model layer map they are meant to match.
  const editorLayerCssColors = useMemo(
    () => editorLayerColors.map((color) => linearLayerColorToCss(color, 1.35)),
    [editorLayerColors],
  );
  const editorLayerSwatchCssColors = useMemo(
    () => editorLayerColors.map((color) => linearLayerColorToCss(color, 1.85)),
    [editorLayerColors],
  );

  useEffect(() => {
    if (editorStatus !== 'ready' || !editorCurrent || editableKitId === null) return;
    let cancelled = false;
    setEditorPreviewPending(true);
    setEditorPreviewError(null);
    const preview = isCustomKitId(editableKitId)
      ? previewImportedKitMessages
      : previewStockKitMessages;
    void preview(editableKitId, editorCurrent)
      .catch((cause) => {
        console.warn('[warpaint-viewer] editor preview could not be updated:', cause);
        if (!cancelled) setEditorPreviewError('The preview could not be updated.');
      })
      .finally(() => {
        if (!cancelled) setEditorPreviewPending(false);
      });
    return () => { cancelled = true; };
  }, [editableKitId, editorCurrent, editorStatus, previewImportedKitMessages, previewStockKitMessages]);

  useEffect(() => {
    // Selection changes must release the isolated draft source; the imported
    // container remains the stable baseline for the next edit session.
    return () => {
      clearImportedPreviewKit();
      clearStockPreviewKit();
    };
  }, [clearImportedPreviewKit, clearStockPreviewKit, editableKitId]);

  useEffect(() => {
    groupImageCacheRef.current.clear();
  }, [activeTextureOverrides, packageGeneration]);

  useEffect(() => {
    setEditorSample(null);
    setGroupImageError(null);
    if (!displayedGroupRef) {
      setGroupImage(null);
      return;
    }
    let cancelled = false;
    const cacheKey = `${packageGeneration}:${activeTextureOverrides[displayedGroupRef] ?? displayedGroupRef}`;
    let pending = groupImageCacheRef.current.get(cacheKey);
    if (!pending) {
      pending = (async () => {
        const url = activeTextureOverrides[displayedGroupRef]
          ?? await sourceProvider.resolvePreview(displayedGroupRef);
        return loadRgbaImageData(url);
      })();
      groupImageCacheRef.current.set(cacheKey, pending);
      void pending.catch(() => groupImageCacheRef.current.delete(cacheKey));
    }
    void pending.then((image) => {
      if (!cancelled) setGroupImage(image);
    }).catch((cause) => {
        console.warn('[warpaint-viewer] editable areas could not be loaded:', cause);
        if (!cancelled) setGroupImageError('The editable areas could not be loaded.');
    });
    return () => { cancelled = true; };
  }, [activeTextureOverrides, displayedGroupRef, sourceProvider, packageGeneration]);

  const editorEnabled = editorStatus === 'ready' && Boolean(activeGroupEditTarget && groupImage);
  // Camera policy follows the Edit tab itself, even while its group map is
  // loading or unavailable. Selection input remains stricter: it only starts
  // once the editor has a usable target and image.
  const editorTabActive = workbenchOpen && workbenchTab === 'editor';
  const stickerEditingActive = editorTabActive && editorTool === 'sticker';
  const groupAssignActive = editorEnabled && editorTabActive && editorTool === 'paint' && paintSubView === 'parts';
  const stickerEditorPreparing = editorTabActive && editorTool === 'sticker'
    && stickerTargetEditable && !stickerEditorReady;
  const stickerPlacementActive = editorTabActive && editorTool === 'sticker' && stickerEditorReady;
  const stickerPartPickingActive = stickerEditingActive && modelPartPickingActive;
  const editorInteractionActive = groupAssignActive || stickerPlacementActive;

  // Keep one global listener for the editor tab while reading current actions
  // from a ref, rather than replacing it after every history-state render.
  const editorHistoryActionsRef = useRef({
    undo: undoEditorSynced,
    redo: redoEditorSynced,
    canUndo: editorCanUndo,
    canRedo: editorCanRedo,
  });
  editorHistoryActionsRef.current = {
    undo: undoEditorSynced,
    redo: redoEditorSynced,
    canUndo: editorCanUndo,
    canRedo: editorCanRedo,
  };

  const clearModelPartPickingInteraction = useCallback(() => {
    const gesture = modelPartPointerRef.current;
    if (gesture?.captureTarget.hasPointerCapture(gesture.pointerId)) {
      gesture.captureTarget.releasePointerCapture(gesture.pointerId);
    }
    modelPartPointerRef.current = null;
    viewerRef.current?.clearModelPartHover();
  }, []);

  const resetModelPartPicking = useCallback(() => {
    viewerRef.current?.restoreHiddenModelParts();
    clearModelPartPickingInteraction();
    setModelPartPickingActive(false);
    setHiddenModelPartCount(0);
  }, [clearModelPartPickingInteraction]);

  useEffect(() => {
    // Hidden parts must not leak into another model or editor session.
    if (stickerEditingActive && engineReady) return;
    resetModelPartPicking();
  }, [engineReady, resetModelPartPicking, stickerEditingActive]);

  useEffect(() => {
    resetModelPartPicking();
  }, [resetModelPartPicking, selectedAssetKey, state.weaponKey]);

  useEffect(() => {
    if (stickerPartPickingActive) return;
    clearModelPartPickingInteraction();
  }, [clearModelPartPickingInteraction, stickerPartPickingActive]);

  useEffect(() => {
    if (!editorTabActive || (lightingPanelOpen && state.preset === CUSTOM_LIGHTING_ID)) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || !(event.ctrlKey || event.metaKey)) return;
      if (shortcutTargetsEditableContent(event.target)) return;
      // A modal owns its own keyboard loop and must not trigger editing behind
      // it, even when focus momentarily lands on its dialog container.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const key = event.key.toLowerCase();
      const actions = editorHistoryActionsRef.current;
      if (key === 'z' && !event.shiftKey && actions.canUndo) {
        event.preventDefault();
        actions.undo();
      } else if ((key === 'y' || (key === 'z' && event.shiftKey)) && actions.canRedo) {
        event.preventDefault();
        actions.redo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editorTabActive, lightingPanelOpen, state.preset]);

  // Paint-area selection deliberately uses Shift + click. Keep free-fly out
  // of this focused workflow and make the modifier state visible through the
  // canvas cursor before the pointer reaches a selectable part.
  useEffect(() => {
    const viewer = viewerRef.current;
    viewer?.setAdvancedCameraAvailable(!editorTabActive);
    viewer?.setEditorSelectionActive(editorInteractionActive);
    viewer?.setStickerPlacementActive(stickerPlacementActive);
    if (!editorInteractionActive) {
      setEditorSelectionHeld(false);
      return;
    }

    const updateSelectionModifier = (event: KeyboardEvent) => {
      if (event.key === 'Shift') setEditorSelectionHeld(event.type === 'keydown');
    };
    const clearSelectionModifier = () => setEditorSelectionHeld(false);
    window.addEventListener('keydown', updateSelectionModifier);
    window.addEventListener('keyup', updateSelectionModifier);
    window.addEventListener('blur', clearSelectionModifier);
    return () => {
      window.removeEventListener('keydown', updateSelectionModifier);
      window.removeEventListener('keyup', updateSelectionModifier);
      window.removeEventListener('blur', clearSelectionModifier);
    };
  }, [editorInteractionActive, editorTabActive, engineReady, stickerPlacementActive]);

  useEffect(() => {
    if (!editorSelectionHeld) setEditorSample(null);
  }, [editorSelectionHeld]);

  useEffect(() => {
    if (!groupAssignActive || !showLayerMap) {
      setLayerMapImages({});
      return;
    }
    const refs = [...new Set(groupAssignmentTargets.map((target) => target.groupsRef))];
    let cancelled = false;
    void Promise.all(refs.map(async (ref) => {
      try {
        if (normalizeGroupTextureReference(ref) === normalizeGroupTextureReference(displayedGroupRef ?? '') && groupImage) {
          return [ref, groupImage] as const;
        }
        const cacheKey = `${packageGeneration}:${activeTextureOverrides[ref] ?? ref}`;
        let pending = groupImageCacheRef.current.get(cacheKey);
        if (!pending) {
          pending = (async () => {
            const url = activeTextureOverrides[ref] ?? await sourceProvider.resolvePreview(ref);
            return loadRgbaImageData(url);
          })();
          groupImageCacheRef.current.set(cacheKey, pending);
          void pending.catch(() => groupImageCacheRef.current.delete(cacheKey));
        }
        return [ref, await pending] as const;
      } catch (cause) {
        console.warn('[warpaint-viewer] one layer-map source could not be loaded:', cause);
        return null;
      }
    })).then((entries) => {
      if (!cancelled) setLayerMapImages(Object.fromEntries(entries.filter((entry) => entry !== null)));
    });
    return () => { cancelled = true; };
  }, [
    activeTextureOverrides,
    displayedGroupRef,
    groupAssignmentTargets,
    groupAssignActive,
    groupImage,
    packageGeneration,
    showLayerMap,
    sourceProvider,
  ]);

  const handleVisiblePaintResult = useCallback((
    result: ComposeResult,
    context: { interactive: boolean },
  ) => {
    if (!editorTabActive || paintSubView !== 'transform') return;
    const compositor = compositorRef.current;
    if (!compositor) return;
    const generation = ++transformUvSurfaceGenerationRef.current;
    setTransformUvSurfaceLoading(true);
    let previewBlob: Promise<Blob>;
    try {
      previewBlob = compositor.toPreviewBlob(
        result.target,
        context.interactive ? TRANSFORM_LIVE_PREVIEW_MAX_SIZE : 1024,
      );
    } catch {
      if (generation === transformUvSurfaceGenerationRef.current) setTransformUvSurfaceLoading(false);
      return;
    }
    void previewBlob.then((blob) => {
      if (generation !== transformUvSurfaceGenerationRef.current) return;
      const nextUrl = URL.createObjectURL(blob);
      const priorUrl = transformUvSurfaceUrlRef.current;
      transformUvSurfaceUrlRef.current = nextUrl;
      setTransformUvSurfaceUrl(nextUrl);
      setTransformUvSurfaceLoading(false);
      if (priorUrl) URL.revokeObjectURL(priorUrl);
    }).catch(() => {
      if (generation === transformUvSurfaceGenerationRef.current) setTransformUvSurfaceLoading(false);
    });
  }, [editorTabActive, paintSubView]);

  useEffect(() => {
    if (editorTabActive && paintSubView === 'transform') return;
    transformUvSurfaceGenerationRef.current += 1;
    const priorUrl = transformUvSurfaceUrlRef.current;
    transformUvSurfaceUrlRef.current = null;
    setTransformUvSurfaceUrl(null);
    setTransformUvSurfaceLoading(false);
    if (priorUrl) URL.revokeObjectURL(priorUrl);
  }, [editorTabActive, paintSubView]);

  useEffect(() => () => {
    transformUvSurfaceGenerationRef.current += 1;
    const priorUrl = transformUvSurfaceUrlRef.current;
    transformUvSurfaceUrlRef.current = null;
    if (priorUrl) URL.revokeObjectURL(priorUrl);
  }, []);

  const { composing, visibleDefinitionGeneration, resetComposeKey, disposeCache } = useComposedPaint({
    suspended: stickerPlacementActive && selectedStickerUsesComposedArtwork,
    // Isolation owns the live layer preview. Keep the normal compositor idle
    // during its drag, but available for weapon and committed recipe changes so
    // the translucent context always belongs to the current weapon.
    interactive: paintSubView === 'transform' && transformDraft !== null,
    interactiveRecipe: transformDraft ? transformPreviewRecipe : null,
    interactiveKey: transformDraft
      ? `${transformDraft.key}:${transformDraft.value.mode}:${transformDraft.value.min}:${transformDraft.value.max}`
      : '',
    onVisibleResult: handleVisiblePaintResult,
    engineReady,
    data,
    selectedKit,
    resolveRecipe,
    selectedAssetKey,
    loadedAssetKey,
    state,
    assetOverrides,
    packageGeneration,
    definitionGeneration: editorDefinitionGeneration,
    activeTextureOverrides,
    viewerRef,
    compositorRef,
    advanceBoot,
    setError,
    setState,
  });

  const isolatedTransformResultRef = useRef<ComposeResult | null>(null);
  useEffect(() => {
    const compositor = compositorRef.current;
    const viewer = viewerRef.current;
    const groupPixels = groupImage?.data;
    const clearIsolation = () => {
      const prior = isolatedTransformResultRef.current;
      isolatedTransformResultRef.current = null;
      viewer?.clearTransformIsolation();
      if (prior && compositor) compositor.releaseResult(prior);
    };
    if (!engineReady || paintSubView !== 'transform' || !transformIsolateLayer
      || !activeTransformIsolationNode || !compositor || !viewer || !data
      || !groupImage
      || !(groupPixels instanceof Uint8Array || groupPixels instanceof Uint8ClampedArray)
      || activeSelectedGroupBuckets.length === 0) {
      clearIsolation();
      return;
    }
    const weapon = data.manifest.weapons.find((entry) => entry.key === state.weaponKey);
    if (!weapon) return;
    let cancelled = false;
    const fullWidth = weapon.compositeWidth ?? 1024;
    const fullHeight = weapon.compositeHeight ?? 1024;
    const scale = transformDraft
      ? Math.min(1, TRANSFORM_LIVE_PREVIEW_MAX_SIZE / Math.max(fullWidth, fullHeight))
      : 1;
    const compose = transformDraft
      ? compositor.composeResolvedLatest('transform-isolation', activeTransformIsolationNode, {
        width: Math.max(1, Math.round(fullWidth * scale)),
        height: Math.max(1, Math.round(fullHeight * scale)),
      })
      : compositor.composeResolved(activeTransformIsolationNode, {
        width: Math.max(1, Math.round(fullWidth * scale)),
        height: Math.max(1, Math.round(fullHeight * scale)),
      });
    void compose.then((result) => {
      if (!result) return;
      if (cancelled) {
        compositor.releaseResult(result);
        return;
      }
      const prior = isolatedTransformResultRef.current;
      isolatedTransformResultRef.current = result;
      if (groupImage && (groupPixels instanceof Uint8Array || groupPixels instanceof Uint8ClampedArray)) {
        viewer.setTransformIsolation(
          result.texture,
          groupPixels,
          groupImage.width,
          groupImage.height,
          activeSelectedGroupBuckets,
        );
      }
      if (prior && prior !== result) compositor.releaseResult(prior);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [
    activeTransformIsolationNode,
    activeSelectedGroupBuckets,
    data,
    engineReady,
    groupImage,
    paintSubView,
    state.weaponKey,
    transformGestureActive,
    transformDraft,
    transformIsolateLayer,
    weaponBaseLayerActive,
  ]);

  useEffect(() => () => {
    viewerRef.current?.clearTransformIsolation();
    const prior = isolatedTransformResultRef.current;
    isolatedTransformResultRef.current = null;
    if (prior) compositorRef.current?.releaseResult(prior);
  }, [compositorRef, viewerRef]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const pixels = groupImage?.data;
    const bucket = panelPreviewGroup ?? editorSample?.bucket ?? null;
    if (!viewer) return;
    if (groupAssignActive
      && bucket !== null && bucket > 0
      && (pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray)
      && groupImage) {
      viewer.setGroupHighlight(
        pixels,
        groupImage.width,
        groupImage.height,
        bucket,
        activeEditorLayerColor,
      );
    } else {
      viewer.clearGroupHighlight();
    }
  }, [
    activeEditorLayerColor,
    engineReady,
    groupAssignActive,
    groupImage,
    editorSample?.bucket,
    panelPreviewGroup,
  ]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (!groupAssignActive || !showLayerMap) {
      viewer.clearGroupLayerOverlay();
      return;
    }
    const maps = Object.entries(layerMapImages).flatMap(([groupsRef, image]) => {
      const pixels = image.data;
      if (!(pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray)) return [];
      const layers = groupAssignmentTargets.flatMap((target, layerIndex) => {
        if (target.groupsRef !== groupsRef) return [];
        const color = editorLayerColors[layerIndex]
          ?? EDITOR_LAYER_MAP_COLORS[layerIndex % EDITOR_LAYER_MAP_COLORS.length];
        return target.selectedGroupIds
          .map(groupByteToCompositorBucket)
          .filter((bucket): bucket is number => bucket !== null && bucket > 0)
          .filter((bucket, index, buckets) => buckets.indexOf(bucket) === index)
          .map((bucket) => ({ bucket, color }));
      });
      return layers.length > 0 ? [{
        pixels,
        width: image.width,
        height: image.height,
        layers,
      }] : [];
    });
    viewer.setGroupLayerOverlay(maps);
  }, [
    engineReady,
    editorLayerColors,
    groupAssignActive,
    groupAssignmentTargets,
    layerMapImages,
    showLayerMap,
  ]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const surface = stickerBaseSurfaceResultRef.current;
    const quad = stickerDraftQuad ?? authoredStickerQuad;
    const awaitingNormalComposition = !stickerPlacementActive
      && (editorPreviewPending || visibleDefinitionGeneration < editorDefinitionGeneration);
    const canPreview = (stickerPlacementActive || awaitingNormalComposition)
      && (stickerBaseSurfaceKey === stickerSurfaceComposeKey || destinationEditSettling)
      && surface
      && effectiveStickerTextureUrl
      && quad;
    if (canPreview) {
      // Swap the material source before drawing the decal overlay. The base
      // recipe excludes only this sticker, so there is never an old baked
      // position under the live one.
      viewer.setStickerEditorBaseMap(surface.texture);
      if (selectedStickerUsesComposedArtwork && activeGroupStickerResources) {
        viewer.setGroupStickerPreview(activeGroupStickerResources.maskUrl, {
          selectorBase: activeGroupStickerResources.selectorBase.texture,
          endpointZero: activeGroupStickerResources.endpointZero.texture,
          endpointOne: activeGroupStickerResources.endpointOne.texture,
          levels: activeGroupStickerResources.levels,
        }, quad, { tool: stickerTransformTool });
      } else {
        viewer.setStickerPreview(effectiveStickerTextureUrl, quad, {
          tool: stickerTransformTool,
          specularUrl: stickerSpecularUrl,
        });
      }
      if (!stickerPlacementActive || modelPartPickingActive) viewer.setStickerGizmo(null);
    } else if (stickerPlacementActive && authoredStickerQuad && !modelPartPickingActive) {
      viewer.setStickerEditorBaseMap(null);
      viewer.clearStickerPreview();
      viewer.setStickerGizmo(authoredStickerQuad, stickerTransformTool);
    } else {
      viewer.setStickerEditorBaseMap(null);
      viewer.clearStickerPreview();
    }
  }, [
    authoredStickerQuad,
    activeGroupStickerResources,
    editorDefinitionGeneration,
    destinationEditSettling,
    editorPreviewPending,
    engineReady,
    stickerBaseSurfaceKey,
    stickerDraftQuad,
    selectedStickerUsesComposedArtwork,
    stickerPlacementActive,
    modelPartPickingActive,
    stickerSpecularUrl,
    stickerSurfaceComposeKey,
    effectiveStickerTextureUrl,
    stickerTransformTool,
    visibleDefinitionGeneration,
  ]);

  useEffect(() => {
    if (groupAssignActive) return;
    groupPointerRef.current = null;
    setEditorSample(null);
    setPanelPreviewGroup(null);
  }, [groupAssignActive]);
  const editorUnavailableReason = useMemo(() => {
    if (editableKitId === null) return 'Choose a war paint to edit.';
    if (editorStatus === 'loading') return 'Loading editable areas…';
    if (editorStatus === 'error') return 'This paint could not be opened.';
    if (!groupDiscovery) return 'This paint can’t be edited yet.';
    if (editableGroupTargets.length === 0) {
      return 'This paint can’t be edited yet.';
    }
    if (!activeGroupEditTarget) return 'Loading editable areas…';
    if (groupImageError) return groupImageError;
    if (!groupImage) return 'Loading editable areas…';
    return undefined;
  }, [editableKitId, editorStatus, groupDiscovery, editableGroupTargets.length, activeGroupEditTarget, groupImageError, groupImage]);

  const toggleEditorGroup = useCallback((bucket: number) => {
    if (weaponBaseLayerActive) {
      const owner = groupAssignmentTargets.find((target) => target.selectedGroupIds.some(
        (groupId) => groupByteToCompositorBucket(groupId) === bucket,
      ));
      if (!owner?.canAssign) return;
      const ownedIds = owner.selectedGroupIds.filter(
        (groupId) => groupByteToCompositorBucket(groupId) === bucket,
      );
      if (ownedIds.length === 0 || !clearSessionGroups(owner.target, ownedIds)) return;
      const part = formatGroupNameForDisplay(activeGroupLabels[bucket] ?? 'Part');
      setEditorSample(null);
      setPanelPreviewGroup(null);
      setEditorAssignmentNotice(`${part} moved to ${baseTextureTransform?.label ?? 'the base texture'}.`);
      return;
    }
    if (!activeGroupEditTarget || !activeGroupAssignmentTarget) return;
    const selectedRawIds = activeSelectedRawGroupIds.filter(
      (groupId) => groupByteToCompositorBucket(groupId) === bucket,
    );
    const rawIds = selectedRawIds.length > 0
      ? selectedRawIds
      : [rawGroupIdForBucket(bucket)].filter((groupId): groupId is number => groupId !== null);
    let moveNotice: string | null = null;
    const results = assignSessionGroups(activeGroupAssignmentTarget, groupAssignmentTargets, rawIds);
    if (results && results.length > 0) {
      for (const result of results) {
        if (result.action !== 'moved') continue;
        const from = result.displacedLabels.length === 1
          ? result.displacedLabels[0]
          : result.displacedLabels.length > 1
            ? 'other paint layers'
            : 'another paint layer';
        const part = formatGroupNameForDisplay(activeGroupLabels[bucket] ?? 'Part');
        moveNotice = `${part} moved from ${from}.`;
      }
      // The marker is only a targeting aid. Once an edit lands, remove it so
      // the recomposed paint itself is immediately readable. This also covers
      // a chip being clicked while hovered: its unmount does not reliably
      // produce a mouse-leave event for the preview callback.
      setEditorSample(null);
      setPanelPreviewGroup(null);
      setEditorAssignmentNotice(moveNotice);
    }
  }, [activeGroupAssignmentTarget, activeGroupEditTarget, activeGroupLabels, activeSelectedRawGroupIds, assignSessionGroups, baseTextureTransform?.label, clearSessionGroups, groupAssignmentTargets, weaponBaseLayerActive]);

  const clearEditorGroups = useCallback(() => {
    if (weaponBaseLayerActive || !activeGroupEditTarget) return;
    if (clearSessionGroups(activeGroupEditTarget, activeSelectedRawGroupIds)) {
      setEditorSample(null);
      setPanelPreviewGroup(null);
      setEditorAssignmentNotice(null);
    }
  }, [activeGroupEditTarget, activeSelectedRawGroupIds, clearSessionGroups, weaponBaseLayerActive]);

  const sampleEditorSurface = useCallback((clientX: number, clientY: number) => {
    if (!groupAssignActive || !groupImage) return null;
    const hit = viewerRef.current?.pickWeaponUv(clientX, clientY);
    if (!hit) {
      setEditorSample(null);
      return null;
    }
    const sampled = sampleGroupAtUv(groupImage, hit.uv[0], hit.uv[1]);
    if (!sampled) {
      setEditorSample(null);
      return null;
    }
    setEditorSample((current) => (
      current?.texel.x === sampled.x && current.texel.y === sampled.y
        ? current
        : {
            rawRed: sampled.red,
            bucket: sampled.bucket,
            uv: { u: hit.uv[0], v: hit.uv[1] },
            texel: { x: sampled.x, y: sampled.y },
          }
    ));
    return sampled;
  }, [groupAssignActive, groupImage]);

  const beginStickerInteraction = useCallback(() => {
    if (authoredStickerQuad) stickerDraftRef.current = authoredStickerQuad;
  }, [authoredStickerQuad]);

  const previewStickerDraft = useCallback((quad: StickerPlacementQuad) => {
    if (!stickerPlacementActive || !effectiveStickerTextureUrl) return;
    const viewer = viewerRef.current;
    if (selectedStickerUsesComposedArtwork && activeGroupStickerResources) {
      viewer?.setGroupStickerPreview(activeGroupStickerResources.maskUrl, {
        selectorBase: activeGroupStickerResources.selectorBase.texture,
        endpointZero: activeGroupStickerResources.endpointZero.texture,
        endpointOne: activeGroupStickerResources.endpointOne.texture,
        levels: activeGroupStickerResources.levels,
      }, quad, { tool: stickerTransformTool });
      return;
    }
    viewer?.setStickerPreview(effectiveStickerTextureUrl, quad, {
      tool: stickerTransformTool,
      specularUrl: stickerSpecularUrl,
    });
  }, [
    activeGroupStickerResources,
    selectedStickerUsesComposedArtwork,
    stickerPlacementActive,
    effectiveStickerTextureUrl,
    stickerSpecularUrl,
    stickerTransformTool,
  ]);

  const changeStickerPlacement = useCallback((placement: StickerPlacement) => {
    const constrained = constrainStickerPlacementToTexture(placement);
    const base = stickerDraftRef.current ?? authoredStickerQuad;
    const quad = base
      ? applyStickerPlacementToQuad(base, constrained)
      : stickerPlacementToQuad(constrained);
    if (!quad) return;
    // The 2D editor owns its lightweight local transform while dragging. Push
    // the matching shader uniforms now instead of waiting for React's effect
    // phase, so a dense pointer stream cannot make the model preview trail the
    // box. This never changes the composed base; the destination is committed
    // to the editor session only at interaction end.
    previewStickerDraft(quad);
    updateStickerDraft(quad);
  }, [authoredStickerQuad, previewStickerDraft, updateStickerDraft]);

  const changeStickerQuad = useCallback((quad: StickerPlacementQuad) => {
    const constrained = constrainStickerQuadToTexture(quad);
    previewStickerDraft(constrained);
    updateStickerDraft(constrained);
  }, [previewStickerDraft, updateStickerDraft]);

  const finishStickerInteraction = useCallback(() => {
    const next = stickerDraftRef.current;
    if (next && authoredStickerQuad && !stickerQuadsEqual(next, authoredStickerQuad)
      && selectedStickerTarget?.editable) {
      if (!setSessionStickerQuad(selectedStickerTarget.target, next)) updateStickerDraft(null);
    } else {
      updateStickerDraft(null);
    }
  }, [authoredStickerQuad, selectedStickerTarget, setSessionStickerQuad, updateStickerDraft]);

  const setModelPartPicking = useCallback((active: boolean) => {
    if (!stickerEditingActive) return;
    setModelPartPickingActive(active);
    // Entering the picker is a mode change worth re-explaining; leaving it
    // should not resurrect a hint the user already dismissed.
    if (active) setHintDismissed(false);
  }, [stickerEditingActive]);

  const restoreHiddenModelParts = useCallback(() => {
    viewerRef.current?.restoreHiddenModelParts();
    setHiddenModelPartCount(0);
  }, []);

  const beginEditorPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (stickerPartPickingActive && event.button === 0 && event.target === canvasRef.current) {
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      groupPointerRef.current = null;
      stickerGestureRef.current = null;
      stickerGizmoGestureRef.current = null;
      updateStickerDraft(null);
      setEditorSample(null);
      setHintDismissed(true);
      const pick = viewerRef.current?.pickModelPartAt(event.clientX, event.clientY) ?? null;
      viewerRef.current?.setModelPartHover(pick);
      modelPartPointerRef.current = {
        pointerId: event.pointerId,
        captureTarget: event.currentTarget,
        x: event.clientX,
        y: event.clientY,
        moved: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (stickerPlacementActive && event.button === 0 && event.target === canvasRef.current
      && authoredStickerQuad) {
      const viewer = viewerRef.current;
      const drag = viewer?.beginStickerGizmoDrag(event.clientX, event.clientY, authoredStickerQuad);
      if (drag) {
        event.preventDefault();
        event.stopPropagation();
        // The viewer has the same native-layer reservation as a backstop;
        // make this high-level ownership explicit for later canvas listeners.
        event.nativeEvent.stopImmediatePropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        stickerGizmoGestureRef.current = {
          pointerId: event.pointerId,
          drag,
          preserveAspect: event.shiftKey ? !stickerAspectLocked : stickerAspectLocked,
          base: authoredStickerQuad,
          latest: authoredStickerQuad,
        };
        beginStickerInteraction();
        return;
      }
    }
    if (stickerPlacementActive && event.shiftKey && event.button === 0
      && event.target === canvasRef.current && authoredStickerQuad) {
      const moved = viewerRef.current?.moveStickerQuadToClientPoint(
        authoredStickerQuad,
        event.clientX,
        event.clientY,
      );
      if (!moved) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      stickerGestureRef.current = {
        pointerId: event.pointerId,
        base: authoredStickerQuad,
        latest: moved,
      };
      previewStickerDraft(moved);
      updateStickerDraft(moved);
      return;
    }
    if (!groupAssignActive || !event.shiftKey || event.button !== 0 || event.target !== canvasRef.current) return;
    groupPointerRef.current = { x: event.clientX, y: event.clientY, moved: false };
  }, [authoredStickerQuad, beginStickerInteraction, groupAssignActive, previewStickerDraft, stickerAspectLocked, stickerPartPickingActive, stickerPlacementActive, updateStickerDraft]);

  const previewEditorSurface = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const modelPartGesture = modelPartPointerRef.current;
    if (modelPartGesture && modelPartGesture.pointerId === event.pointerId) {
      if (Math.hypot(event.clientX - modelPartGesture.x, event.clientY - modelPartGesture.y) > 4) {
        modelPartGesture.moved = true;
      }
      const pick = viewerRef.current?.pickModelPartAt(event.clientX, event.clientY) ?? null;
      viewerRef.current?.setModelPartHover(pick);
      return;
    }
    if (stickerPartPickingActive && event.target === canvasRef.current) {
      const pick = viewerRef.current?.pickModelPartAt(event.clientX, event.clientY) ?? null;
      viewerRef.current?.setModelPartHover(pick);
      return;
    }
    const gizmoGesture = stickerGizmoGestureRef.current;
    if (gizmoGesture && gizmoGesture.pointerId === event.pointerId) {
      const result = viewerRef.current?.updateStickerGizmoDrag(
        gizmoGesture.drag,
        event.clientX,
        event.clientY,
        gizmoGesture.preserveAspect,
      );
      if (result) {
        let nextQuad = result.quad;
        if (result.intent === 'rotate' && !event.shiftKey) {
          const read = stickerPlacementFromQuad(result.quad);
          if (read.editable && read.placement) {
            nextQuad = stickerPlacementToQuad({
              ...read.placement,
              rotation: snapStickerRotationToCardinal(read.placement.rotation),
            }) ?? result.quad;
          }
        }
        gizmoGesture.latest = nextQuad;
        previewStickerDraft(nextQuad);
        updateStickerDraft(nextQuad);
      }
      return;
    }
    const stickerGesture = stickerGestureRef.current;
    if (stickerGesture && stickerGesture.pointerId === event.pointerId) {
      const moved = viewerRef.current?.moveStickerQuadToClientPoint(
        stickerGesture.base,
        event.clientX,
        event.clientY,
      );
      if (moved) {
        stickerGesture.latest = moved;
        previewStickerDraft(moved);
        updateStickerDraft(moved);
      }
      return;
    }
    if (!groupAssignActive || event.target !== canvasRef.current) return;
    if (!event.shiftKey) {
      groupPointerRef.current = null;
      setEditorSample(null);
      return;
    }
    const start = groupPointerRef.current;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) start.moved = true;
    sampleEditorSurface(event.clientX, event.clientY);
  }, [groupAssignActive, previewStickerDraft, sampleEditorSurface, stickerPartPickingActive, updateStickerDraft]);

  const finishEditorPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const modelPartGesture = modelPartPointerRef.current;
    if (modelPartGesture && modelPartGesture.pointerId === event.pointerId) {
      const moved = modelPartGesture.moved
        || Math.hypot(event.clientX - modelPartGesture.x, event.clientY - modelPartGesture.y) > 4;
      const viewer = viewerRef.current;
      modelPartPointerRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      event.preventDefault();
      event.stopPropagation();
      const pick = viewer?.pickModelPartAt(event.clientX, event.clientY) ?? null;
      const count = !moved && event.button === 0 && pick ? viewer?.toggleModelPart(pick) : null;
      if (count !== null && count !== undefined) setHiddenModelPartCount(count);
      viewer?.setModelPartHover(stickerPartPickingActive ? pick : null);
      return;
    }
    const gizmoGesture = stickerGizmoGestureRef.current;
    if (gizmoGesture && gizmoGesture.pointerId === event.pointerId) {
      stickerGizmoGestureRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!stickerQuadsEqual(gizmoGesture.latest, gizmoGesture.base)
        && selectedStickerTarget?.editable) {
        if (!setSessionStickerQuad(selectedStickerTarget.target, gizmoGesture.latest)) updateStickerDraft(null);
      } else {
        updateStickerDraft(null);
      }
      return;
    }
    const stickerGesture = stickerGestureRef.current;
    if (stickerGesture && stickerGesture.pointerId === event.pointerId) {
      stickerGestureRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!stickerQuadsEqual(stickerGesture.latest, stickerGesture.base)
        && selectedStickerTarget?.editable) {
        if (!setSessionStickerQuad(selectedStickerTarget.target, stickerGesture.latest)) updateStickerDraft(null);
      } else {
        updateStickerDraft(null);
      }
      return;
    }
    const start = groupPointerRef.current;
    groupPointerRef.current = null;
    if (!groupAssignActive || !event.shiftKey || !start || start.moved || event.button !== 0 || event.target !== canvasRef.current) return;
    const sampled = sampleEditorSurface(event.clientX, event.clientY);
    if (sampled && sampled.bucket > 0) toggleEditorGroup(sampled.bucket);
  }, [groupAssignActive, sampleEditorSurface, selectedStickerTarget, setSessionStickerQuad, stickerPartPickingActive, toggleEditorGroup, updateStickerDraft]);

  const cancelEditorPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    groupPointerRef.current = null;
    if (modelPartPointerRef.current?.pointerId === event.pointerId) {
      modelPartPointerRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      viewerRef.current?.clearModelPartHover();
    }
    if (stickerGizmoGestureRef.current?.pointerId === event.pointerId) {
      stickerGizmoGestureRef.current = null;
      updateStickerDraft(null);
    }
    if (stickerGestureRef.current?.pointerId === event.pointerId) {
      stickerGestureRef.current = null;
      updateStickerDraft(null);
    }
  }, [updateStickerDraft]);

  const downloadEditorPackage = useCallback((format: EditorDownloadFormat) => {
    const messages = getEditorMessages();
    if (!messages || editorPackageExporting || editableKitId === null) return;
    setEditorPackageExportError(null);
    setEditorPackageExporting(true);
    const pending = format === 'zip'
      ? import('./editor/packageExport').then(({ exportEditedPackage }) => exportEditedPackage(messages, {
          package: sourceProvider.package,
          name: selectedKit?.name,
        }))
      : import('./editor/definitionExport').then(({ exportEditorDefinition }) => exportEditorDefinition(
          messages,
          format,
          isCustomKitId(editableKitId) ? customKitDefindex(editableKitId) : editableKitId,
          selectedKit?.name,
          !isCustomKitId(editableKitId),
        ));
    void pending.then((result) => {
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.fileName;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    }).catch((cause) => {
      setEditorPackageExportError(cause instanceof Error ? cause.message : 'The edited package could not be exported.');
    }).finally(() => setEditorPackageExporting(false));
  }, [editableKitId, editorPackageExporting, getEditorMessages, selectedKit?.name, sourceProvider]);

  // Set up viewer + compositor on the canvas. The three.js stack is dynamically
  // imported so it lands in its own chunk and the UI shell paints first.
  useEffect(() => {
    if (!canvasRef.current || !data) return;
    let disposed = false;
    let viewer: Viewer | null = null;
    let compositor: Compositor | null = null;
    let unsubscribeCameraMode: (() => void) | null = null;
    let unsubscribeCustomLighting: (() => void) | null = null;
    let unsubscribeLightSelection: (() => void) | null = null;
    (async () => {
      advanceBoot(22, 'Starting renderer…');
      const [{ Viewer: ViewerCls }, { Compositor: CompositorCls }] = await Promise.all([
        import('./viewer/Viewer'),
        import('./compositor/compositor'),
      ]);
      if (disposed || !canvasRef.current) return;
      viewer = new ViewerCls(canvasRef.current);
      compositor = new CompositorCls((ref) => sourceProvider.resolve(ref), {
        renderer: viewer.renderer,
        size: 1024,
        textureMetadata: data.manifest.textures,
        textureMetadataResolver: (ref) => sourceProvider.metadataFor(ref),
      });
      viewerRef.current = viewer;
      compositorRef.current = compositor;
      // Seed the viewer-side editor from the persisted rig before subscribing
      // to viewport edits, otherwise its constructor defaults would overwrite
      // the local rig on the first listener callback.
      viewer.setCustomLighting(customLightingRef.current);
      unsubscribeCameraMode = viewer.onCameraModeChange(setCameraMode);
      unsubscribeCustomLighting = viewer.onCustomLightingChange((customLighting) => {
        applyCustomLighting(customLighting);
      });
      unsubscribeLightSelection = viewer.onLightSelectionChange(setSelectedLightId);
      // Dev-only escape hatch for debugging the viewer from the console.
      if (import.meta.env.DEV) (window as unknown as { __viewer?: Viewer }).__viewer = viewer;
      setEngineReady(true);
      advanceBoot(34, 'Loading TF2 environment…');
      await viewer.ready();
      if (!disposed) {
        setEnvironmentReady(true);
        advanceBoot(43, 'Environment ready');
      }
    })();
    return () => {
      disposed = true;
      setEngineReady(false);
      setEnvironmentReady(false);
      disposeCache();
      compositor?.dispose();
      unsubscribeCameraMode?.();
      unsubscribeCustomLighting?.();
      unsubscribeLightSelection?.();
      viewer?.dispose();
      viewerRef.current = null;
      compositorRef.current = null;
    };
  }, [data, advanceBoot, applyCustomLighting, disposeCache, sourceProvider]);

  // Custom files only live in memory. Let the browser warn before a refresh,
  // tab close, or navigation would discard any cached edit set.
  useEffect(() => {
    const hasCachedEdits = Object.values(assetOverrideCache).some((entry) => Object.keys(entry.assets).length > 0);
    if (!hasCachedEdits && sourcePackage.status !== 'mounted' && definitions.state.status !== 'loaded') return;
    const confirmLoss = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', confirmLoss);
    return () => window.removeEventListener('beforeunload', confirmLoss);
  }, [assetOverrideCache, sourcePackage.status, definitions.state.status]);

  // A blank catalog selection has no model/paint work to wait for. Once the
  // renderer environment is ready, the intentionally empty stage is ready too.
  useEffect(() => {
    if (environmentReady && !selectedKit) advanceBoot(100, 'Ready');
  }, [environmentReady, selectedKit, advanceBoot]);

  // Start the tiny recipe request as soon as selection state changes, in
  // parallel with the lazily imported renderer/model setup.
  useEffect(() => {
    if (!data || !selectedKit || !state.weaponKey || !selectedKit.weapons.includes(state.weaponKey)) return;
    void resolveRecipe(selectedKit, state.weaponKey, state.team, state.wearIndex);
  }, [data, resolveRecipe, selectedKit, state.weaponKey, state.team, state.wearIndex]);

  // Files and Export list every input the paint can use, not just the ones the
  // current wear or team happens to reach. Team-aware operation stages resolve
  // texture_red and texture_blue to different refs; collecting only the
  // selected team produced packs whose definition referenced BLU artwork that
  // was never included. Package and Definitions do not consume recipes at all,
  // while Edit only needs the active team/wear recipe for group assignments.
  useEffect(() => {
    // Keep this workbench-only fan-out off the normal viewer path and pause it
    // while the mounted drawer is closed. Reopening or changing surface
    // refreshes only the recipes that surface consumes.
    if (!workbenchMounted || !data || !selectedKit || !state.weaponKey || !selectedKit.weapons.includes(state.weaponKey)) {
      editorRecipesRef.current = [];
      editorRecipeScopeRef.current = '';
      editorRecipeVariantRef.current = '';
      editorRecipeCompleteRef.current = false;
      setEditorRecipes([]);
      setEditorLoading(false);
      return;
    }
    if (!workbenchOpen) {
      setEditorLoading(false);
      return;
    }
    const recipeScope = `${selectedKit.id}|${state.weaponKey}|definition:${editorDefinitionGeneration}|package:${packageGeneration}`;
    const recipeVariant = `${state.team}|${state.wearIndex}`;
    if (workbenchTab === 'package' || workbenchTab === 'definitions') {
      if (editorRecipeScopeRef.current !== recipeScope) {
        editorRecipesRef.current = [];
        editorRecipeScopeRef.current = '';
        editorRecipeVariantRef.current = '';
        editorRecipeCompleteRef.current = false;
        setEditorRecipes([]);
      }
      setEditorLoading(false);
      return;
    }
    let cancelled = false;
    const completeRecipeMatrix = workbenchTab === 'files' || workbenchTab === 'export';
    const cachedRecipesCoverSurface = editorRecipeScopeRef.current === recipeScope
      && editorRecipesRef.current.length > 0
      && (editorRecipeCompleteRef.current || (!completeRecipeMatrix && editorRecipeVariantRef.current === recipeVariant));
    if (cachedRecipesCoverSurface) {
      setEditorLoading(false);
      return;
    }
    setEditorLoading(true);
    const wearIndexes = completeRecipeMatrix && selectedKit.perWear
      ? data.manifest.wearLevels.map((_, index) => index)
      : [state.wearIndex];
    const teams = completeRecipeMatrix && selectedKit.hasTeamTextures
      ? (['red', 'blu'] as const)
      : [state.team];
    void Promise.all(
      teams.flatMap((team) =>
        wearIndexes.map((wearIndex) => resolveRecipe(selectedKit, state.weaponKey, team, wearIndex)
          .then((recipe) => ({ wearIndex, recipe }))),
      ),
    ).then((loaded) => {
      if (cancelled) return;
      const recipes = loaded.flatMap(({ wearIndex, recipe }) => recipe ? [{ wearIndex, recipe }] : []);
      editorRecipesRef.current = recipes;
      editorRecipeScopeRef.current = recipeScope;
      editorRecipeVariantRef.current = recipeVariant;
      editorRecipeCompleteRef.current = completeRecipeMatrix;
      setEditorRecipes(recipes);
    }).finally(() => {
      if (!cancelled) setEditorLoading(false);
    });
    return () => { cancelled = true; };
  }, [workbenchMounted, workbenchOpen, workbenchTab, data, resolveRecipe, selectedKit, state.weaponKey, state.team, state.wearIndex, editorDefinitionGeneration, packageGeneration]);

  // Load the model when the weapon changes.
  useEffect(() => {
    if (!engineReady || !data || !viewerRef.current || !state.weaponKey) return;
    let cancelled = false;
    const viewer = viewerRef.current;
    const weapon = data.manifest.weapons.find((w) => w.key === state.weaponKey);
    if (!weapon || !selectedAssetKey) return;
    setLoadedAssetKey('');
    advanceBoot(48, 'Loading initial weapon…');
    const overrideId = selectedMaterialOverrideId || undefined;
    const builtInMaterial = (overrideId && data.manifest.materials?.[overrideId]) || weapon.material;
    // A mounted package may ship its own VMT for this weapon, which the game
    // would load in place of the stock material. Its parameters replace the
    // baked-in ones wholesale, the way a Source material does.
    const applyMaterial = sourceProvider.resolveMaterial(state.weaponKey, overrideId)
      .then((packaged) => viewer.applyMaterialParams(
        packaged?.material ?? builtInMaterial,
        (ref) => sourceProvider.resolve(ref),
        async (ref) => await sourceProvider.resolveCubemap(ref) ?? stockMaterialCubemapUrls(ref),
      ));
    void Promise.all([
      viewer.ready(),
      viewer.loadModel(
        data.getModelUrl(state.weaponKey),
        viewAngleIdRef.current === 'inventory-icon'
          ? weaponIconView(weapon, true)
          : state.weaponKey === 'paintkit_tool'
            ? weaponIconView(weapon)
            : VIEW_ANGLES.find((preset) => preset.id === viewAngleIdRef.current) ?? VIEW_ANGLES[0],
      ),
      applyMaterial,
    ]).then(() => {
      if (cancelled) return;
      setLoadedAssetKey(selectedAssetKey);
      advanceBoot(62, 'Weapon and material maps ready');
    }).catch((e) => {
      if (!cancelled) setError(`Failed to load weapon assets: ${String(e)}`);
    });
    return () => { cancelled = true; };
  }, [engineReady, data, selectedAssetKey, state.weaponKey, packageGeneration, advanceBoot, sourceProvider, selectedMaterialOverrideId]);

  // Archive replacement changes the answer for existing Source paths, so
  // release old source uploads and composite targets before the generation-keyed
  // compose starts. The provider ignores stale reads from the removed package.
  // A re-imported definitions file reuses the same catalog ids, so the compose
  // cache has to be dropped for it too or an edited paint would render stale.
  useEffect(() => {
    compositorRef.current?.invalidateTextures();
    disposeCache();
    resetComposeKey();
  }, [packageGeneration, definitions.generation, disposeCache, resetComposeKey]);

  // Lighting. Custom rigs stay in app state as plain serializable data; the
  // viewer owns the Three.js lights and updates them imperatively.
  useEffect(() => {
    if (!engineReady) return;
    if (state.preset === CUSTOM_LIGHTING_ID) {
      viewerRef.current?.setCustomLighting(state.customLighting);
    } else {
      viewerRef.current?.setLighting(
        state.weaponKey === 'paintkit_tool'
          ? state.preset === 'inspect'
            ? PAINTKIT_ICON_LIGHTING_ID
            : state.preset === 'inspect-legacy'
              ? LEGACY_PAINTKIT_ICON_LIGHTING_ID
              : state.preset
          : state.preset,
      );
    }
  }, [engineReady, state.customLighting, state.preset, state.weaponKey]);

  useEffect(() => {
    const timeout = window.setTimeout(() => saveCustomLighting(state.customLighting), 150);
    return () => window.clearTimeout(timeout);
  }, [state.customLighting]);

  useEffect(() => () => saveCustomLighting(customLightingRef.current), []);

  useEffect(() => {
    const selectedStillExists = selectedLightId !== null
      && state.customLighting.lights.some((light) => light.id === selectedLightId);
    if (!selectedStillExists) setSelectedLightId(state.customLighting.lights[0]?.id ?? null);
  }, [selectedLightId, state.customLighting]);

  // The stage panel being open *is* the viewport edit mode: helpers and the
  // move gizmo appear with it, so there is no second toggle to remember. It
  // opens with the preset and closes when the preset is switched away.
  useEffect(() => {
    setLightingPanelOpen(state.preset === CUSTOM_LIGHTING_ID);
  }, [state.preset]);

  useEffect(() => {
    if (!engineReady) return;
    viewerRef.current?.setLightingEditorState({
      enabled: lightingPanelOpen && state.preset === CUSTOM_LIGHTING_ID,
      selectedLightId,
    });
  }, [engineReady, lightingPanelOpen, selectedLightId, state.preset]);

  // Picking a light from the inspector jumps straight into editing it. Below
  // 860px the inspector is a slide-over covering the stage, so it steps aside
  // rather than hiding the panel it just opened.
  const selectLight = useCallback((id: string) => {
    setSelectedLightId(id);
    setLightingPanelOpen(true);
    setMobilePanel('none');
  }, []);

  const toggleLightingPanel = useCallback(() => {
    if (!lightingPanelOpen) setMobilePanel('none');
    setLightingPanelOpen(!lightingPanelOpen);
  }, [lightingPanelOpen]);

  // Killstreak sheen.
  useEffect(() => {
    if (engineReady) viewerRef.current?.setSheen(state.sheen, state.team);
  }, [engineReady, state.sheen, state.team]);

  // Unusual particle effect.
  useEffect(() => {
    if (engineReady) viewerRef.current?.setUnusual(state.unusual, state.weaponKey);
  }, [engineReady, state.unusual, state.weaponKey]);

  // Field of view.
  useEffect(() => {
    if (engineReady) viewerRef.current?.setFov(state.fov);
  }, [engineReady, state.fov]);

  // Projection mode.
  useEffect(() => {
    if (engineReady) viewerRef.current?.setProjection(state.projection);
  }, [engineReady, state.projection]);

  // Pushing history here (rather than inside the setState updater) keeps the
  // updater pure: React/StrictMode may invoke an updater function twice in
  // dev, which would double-push if the ref mutation lived in there.
  const patch = useCallback(
    (p: Partial<ControlsState>) => {
      if (p.seed !== undefined && p.seed !== state.seed) {
        const stack = seedHistoryRef.current;
        stack.push(state.seed);
        if (stack.length > SEED_HISTORY_CAP) stack.shift();
      }
      setState((s) => ({ ...s, ...p }));
    },
    [state.seed],
  );

  // Pops the history stack and jumps straight to that seed, bypassing patch
  // so the undo itself is not recorded as a new history entry.
  const undoSeed = useCallback(() => {
    const prev = seedHistoryRef.current.pop();
    if (prev === undefined) return;
    setState((s) => ({ ...s, seed: prev }));
  }, []);
  const canUndoSeed = seedHistoryRef.current.length > 0;

  const onSelectKit = useCallback(
    (id: number) => {
      if (id !== selectedKitId && editorDirty && !window.confirm('Discard unsaved edits and open another war paint?')) return;
      setSelectedKitId(id);
      const kit = paintkits.find((p) => p.id === id);
      const next: Partial<ControlsState> = {};
      if (kit && !kit.weapons.includes(state.weaponKey)) {
        next.weaponKey = kit.weapons[0] ?? state.weaponKey;
      }
      // Team Shine is the one sheen with a per-team color, so the team choice
      // stays meaningful (and selectable) even on single-team warpaints.
      if (kit && !kit.hasTeamTextures && state.sheen !== 'team_shine') next.team = 'red';
      patch(next);
    },
    [editorDirty, paintkits, selectedKitId, state.weaponKey, state.sheen, patch],
  );

  // Selecting a kit belongs to the app, so the hook leaves that hole for it.
  const definitionsState = useMemo<CustomDefinitionsState>(() => ({
    ...definitions.state,
    onSelectKit,
    onImport: (files) => {
      if (editorDirty && !window.confirm('Discard unsaved edits and replace the imported definitions?')) return;
      definitions.state.onImport(files);
    },
    onRemove: () => {
      if (editorDirty && !window.confirm('Discard unsaved edits and remove the imported definitions?')) return;
      definitions.state.onRemove();
    },
  }), [definitions.state, editorDirty, onSelectKit]);

  // A mounted package often carries the definitions its textures belong to, but
  // the Definitions tab that says so is behind a drawer most people never open.
  // Ask over the stage instead, once per package: importing or dismissing
  // answers it, and so does importing definitions from anywhere else.
  const { packageCandidate } = definitions.state;
  const candidateKey = packageCandidate ? `${packageGeneration}:${packageCandidate.path}` : '';
  const candidateKeyRef = useRef(candidateKey);
  candidateKeyRef.current = candidateKey;
  const [answeredCandidateKey, setAnsweredCandidateKey] = useState('');
  useEffect(() => {
    if (definitions.generation > 0) setAnsweredCandidateKey(candidateKeyRef.current);
  }, [definitions.generation]);
  const promptedCandidate = packageCandidate
    && candidateKey !== answeredCandidateKey
    && definitions.state.status !== 'importing'
    ? packageCandidate
    : null;

  // What the Export tab needs beyond the hand-replaced textures: the selected
  // paint's own definitions, and the package textures the compositor read.
  // Both are fetched only when an export actually runs, so opening the tab
  // costs nothing.
  const exportDefinitions = useMemo(() => {
    // Which of this paint's textures the mounted package supplies, answered
    // from the recipe rather than from what has been rendered so far, so the
    // count is right the moment the tab opens.
    const pkg = sourceProvider.package;
    const refs = collectTextureRefs(editorRecipes.map((entry) => entry.recipe));
    const packageSpecularRefs = pkg
      ? collectSlots(editorRecipes).flatMap((slot) => (
          slot.specularRef && sourceProvider.packagePathFor(slot.specularRef) ? [slot.specularRef] : []
        ))
      : [];
    const packageRefs = [...new Set([...refs, ...packageSpecularRefs])];
    const supplied = pkg ? resolvePackageTextures(packageRefs, (ref: string) => sourceProvider.packagePathFor(ref)) : [];
    const unresolvedTextureRefs = refs.filter((ref) => {
      if (!sourceTextureIdentity(ref).startsWith('materials/patterns/')) return false;
      if (sourceProvider.packagePathFor(ref)) return false;
      return !data?.manifest.textures?.[ref];
    });
    return {
      isImported: selectedKit ? isCustomKitId(selectedKit.id) : false,
      builtInKits: (data?.manifest.paintkits ?? []).map((kit) => ({ defindex: kit.id, name: kit.name })),
      loadKitMessages: async () => (
        selectedKit && isCustomKitId(selectedKit.id) ? exportImportedKit(selectedKit.id) : null
      ),
      packageFiles: async () => {
        if (!pkg) return [];
        const { collectPackageFiles } = await import('./export/bundle');
        // Files the user replaced by hand win over the package's copy, matching
        // what the viewer is rendering.
        const replaced = new Set(
          Object.keys(manualTextureOverrides).map((ref) => `${sourceTextureIdentity(ref)}.vtf`),
        );
        return collectPackageFiles(
          supplied.map(({ ref, path }) => ({ path, writeAs: exportPathFor(ref) })),
          (path) => pkg.read(path),
          replaced,
        );
      },
      materialFiles: async (overrides: readonly string[]) => {
        if (!pkg) return { files: [], missing: [...overrides], repaired: [] };
        const { collectMaterialFiles } = await import('./export/bundle');
        return collectMaterialFiles(
          overrides,
          (path: string) => sourceProvider.packagePathForFile(path),
          (path: string) => pkg.read(path),
        );
      },
      packageFileCount: supplied.length,
      packageMounted: Boolean(pkg),
      unresolvedTextureRefs,
    };
    // packageGeneration is what marks a mount or removal: the provider keeps
    // its own identity across both, so without it this would keep answering for
    // whatever archive was mounted first.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [data, selectedKit, exportImportedKit, sourceProvider, packageGeneration, editorRecipes, manualTextureOverrides]);

  const randomizeSeed = useCallback(() => patch({ seed: randomSeed() }), [patch]);

  const onViewAngle = useCallback((id: string) => {
    const preset = VIEW_ANGLES.find((p) => p.id === id) ?? VIEW_ANGLES[0];
    const weapon = data?.manifest.weapons.find((entry) => entry.key === state.weaponKey);
    const authoredView = id === 'inventory-icon'
      ? weaponIconView(weapon, true)
      : id === 'default' && state.weaponKey === 'paintkit_tool'
        ? weaponIconView(weapon)
        : undefined;
    viewerRef.current?.setViewAngle(authoredView ?? preset);
    setViewAngleId(id);
    viewAngleIdRef.current = id;
    if (id === 'inventory-icon') patch({ fov: TF2_ITEM_PANEL_FOV, projection: 'perspective' });
    else patch({ fov: DEFAULT_VIEWER_FOV });
  }, [data, patch, state.weaponKey]);

  const {
    saveImage: onScreenshot,
    copyImage: onCopyImage,
  } = useScreenshotActions({
    viewerRef,
    paintName: selectedKit?.name,
    weaponKey: state.weaponKey,
    seed: state.seed,
    scale: state.screenshotScale,
  });

  const paintToolForIcons = data?.manifest.weapons.find((weapon) => weapon.key === 'paintkit_tool');
  const customCatalogKitIds = useMemo(
    () => definitions.catalogKits.map((kit) => kit.id),
    [definitions.catalogKits],
  );
  const resolveCustomIconTexture = useCallback(
    (ref: string) => sourceProvider.resolve(ref),
    [sourceProvider],
  );
  const renderedCustomIcons = useCustomWarpaintIcons({
    enabled: engineReady,
    generation: definitions.generation,
    packageGeneration,
    kits: definitions.catalogKits,
    paintTool: paintToolForIcons,
    modelUrl: data && paintToolForIcons ? data.getModelUrl(paintToolForIcons.key) : null,
    compositorRef,
    getRecipe: definitions.getRecipe,
    resolveTexture: resolveCustomIconTexture,
    visibleKitIds: visibleCatalogKitIds,
  });

  // Some weapons are painted by kits that use material overrides, yet no stock
  // kit ever gives them one. Bazaar Bargain is the case the community reports
  // rendering oddly with Macaw materials, and the shipped data agrees: of the
  // 37 override-using kits that paint it, none override its material. Deriving
  // the rule from the data rather than naming weapons keeps it correct if a
  // future game update starts overriding one of them.
  const materialExcludedWeapons = useMemo(() => {
    const painted = new Map<string, number>();
    const overridden = new Set<string>();
    for (const kit of data?.manifest.paintkits ?? []) {
      const overrides = kit.materialOverrides;
      if (!overrides || Object.keys(overrides).length === 0) continue;
      for (const key of kit.weapons) painted.set(key, (painted.get(key) ?? 0) + 1);
      for (const key of Object.keys(overrides)) overridden.add(key);
    }
    const excluded = new Set<string>();
    // A single kit skipping a weapon says nothing; a weapon skipped by every
    // override-using kit that paints it is a deliberate authoring convention.
    for (const [key, count] of painted) {
      if (count >= 5 && !overridden.has(key)) excluded.add(key);
    }
    return excluded;
  }, [data?.manifest.paintkits]);

  if (error) return <div className="fatal">Failed to start: {error}</div>;
  if (!data) return <BootLoader boot={boot} />;

  const weaponOptions = (selectedKit?.weapons ?? data.manifest.weapons.map((w) => w.key)).map((key) => {
    const weapon = data.manifest.weapons.find((w) => w.key === key);
    return {
      value: key,
      label: weapon?.name ?? key,
      icon: weapon?.icon ? data.getAssetUrl(weapon.icon) : null,
    };
  });

  const collectionIcons: Record<string, string> = {};
  if (data.manifest.collectionIcons) {
    for (const [name, rel] of Object.entries(data.manifest.collectionIcons)) {
      const url = data.getAssetUrl(rel);
      if (url) collectionIcons[name] = url;
    }
  }

  // Imported kits have no shipped thumbnail; theirs is resolved from the
  // pattern texture the definition names, through the mounted package.
  const paintIcons: Record<number, string> = { ...definitions.icons, ...renderedCustomIcons };
  for (const kit of data.manifest.paintkits) {
    const url = kit.icon ? data.getAssetUrl(kit.icon) : null;
    if (url) paintIcons[kit.id] = url;
  }

  // selectedKit is set well before boot finishes (it drives the first model
  // load), so the header also waits on the boot overlay itself; otherwise
  // it would flash in over the loading screen.
  const showStageHeader = boot.progress >= 100 && !!selectedKit;
  const weaponName = data.manifest.weapons.find((w) => w.key === state.weaponKey)?.name ?? state.weaponKey;

  // Real per-weapon material_override rows for the Materials sub-view, driven
  // by the kit's actual resolved weapon slots (named fields and repeated
  // `item` entries alike; see materialTargets.ts and weaponSlots above).
  const weaponMaterialTargets = editorCurrent && weaponSlots.length > 0
    ? discoverWeaponMaterialTargets(editorCurrent, weaponSlots)
    : [];
  const materialWeaponRows: MaterialWeaponRow[] = weaponMaterialTargets.map((entry) => {
    const enabled = entry.overridePath !== null;
    // Only an actually mounted archive can prove a material absent. With none
    // mounted the honest answer is "unknown", so the row stays unflagged
    // rather than accusing every weapon of a missing file.
    const missing = entry.overridePath !== null && mountedMaterialPaths
      ? !packageHasMaterialOverride(mountedMaterialPaths, entry.overridePath)
      : undefined;
    const weapon = data.manifest.weapons.find((w) => w.key === entry.weaponKey);
    return {
      key: entry.weaponKey,
      name: weapon?.name ?? entry.weaponKey,
      thumbnail: weapon?.icon ? data.getAssetUrl(weapon.icon) : null,
      overridePath: entry.overridePath,
      enabled,
      missing,
      warning: materialExcludedWeapons.has(entry.weaponKey)
        ? 'No stock paint overrides this weapon'
        : undefined,
    };
  });
  const materialPresets = [{ id: 'macaw-metallic', label: 'Macaw metallic' }];
  const materialsEditorProps: MaterialOverridesPanelProps | undefined = materialWeaponRows.length > 0 ? {
    weapons: materialWeaponRows,
    presets: materialPresets,
    activePresetId: materialPresetId,
    disabled: editorStatus !== 'ready',
    onActivePresetChange: setMaterialPresetId,
    onToggleWeapon: (key, enabled) => {
      const target = weaponMaterialTargets.find((entry) => entry.weaponKey === key)?.target;
      if (!target) return;
      setSessionWeaponMaterial(target, enabled ? materialPresetPath(materialPresetId, key) : null);
    },
    onSetWeapons: (keys, enabled) => {
      const selected = new Set(keys);
      setSessionWeaponMaterials(weaponMaterialTargets.flatMap((entry) => (
        selected.has(entry.weaponKey)
          ? [{
            target: entry.target,
            overridePath: enabled ? materialPresetPath(materialPresetId, entry.weaponKey) : null,
          }]
          : []
      )));
    },
    onApplyPreset: () => {
      setSessionWeaponMaterials(weaponMaterialTargets.flatMap((entry) => {
        // Exclusion stays manual, per the feature request: a flagged weapon is
        // never switched on by the preset, but the row is still there to tick
        // by hand for anyone who wants it anyway.
        const row = materialWeaponRows.find((candidate) => candidate.key === entry.weaponKey);
        return row?.warning ? [] : [{
          target: entry.target,
          overridePath: materialPresetPath(materialPresetId, entry.weaponKey),
        }];
      }));
    },
    onClearAll: () => {
      setSessionWeaponMaterials(weaponMaterialTargets.flatMap((entry) => (
        entry.overridePath === null ? [] : [{ target: entry.target, overridePath: null }]
      )));
    },
  } : undefined;

  const albedoTransformLocked = weaponBaseLayerActive
    ? baseTextureTransform?.transformLocked ?? false
    : activeGroupTarget?.label.trim().toLowerCase() === 'albedo';
  const transformDisabled = editorStatus !== 'ready' || albedoTransformLocked
    || !activeTransformTargetInfo || activeTransformTargetInfo.blockers.length > 0;
  const activeTransformTarget = activeTransformTargetInfo?.target ?? null;
  const commitTransformField = (key: keyof TextureTransformFields, value: SeedRangeValue) => {
    if (!activeTransformTarget || transformDisabled) return;
    if (transformScope === 'all') {
      pushSessionTransformRangeToAll(
        activeTransformTarget,
        TRANSFORM_FIELD_TO_PROTO[key],
        value,
        weaponSlots.map((slot) => [...slot.path, 'data', 'variable']),
      );
      return;
    }
    setSessionTransformRange(transformTargetForScope(activeTransformTarget, transformScope), TRANSFORM_FIELD_TO_PROTO[key], value);
  };
  const handleTransformFieldChange = (key: keyof TextureTransformFields, value: SeedRangeValue) => {
    if (!transformGestureActiveRef.current) {
      commitTransformField(key, value);
      return;
    }
    const draft = { key, value };
    transformDraftRef.current = draft;
    setTransformDraft(draft);
  };
  const handleTransformFlipChange = (axis: 'u' | 'v', allowed: boolean) => {
    if (!activeTransformTarget || transformDisabled) return;
    setSessionTransformFlip(transformTargetForScope(activeTransformTarget, transformScope), axis, allowed);
  };
  const handleTransformResetAll = () => {
    if (!activeTransformTarget || transformDisabled) return;
    const target = transformTargetForScope(activeTransformTarget, transformScope);
    const original = originalTransformTargetInfo;
    beginSessionTransformGesture();
    setSessionTransformRange(target, 'rotation', transformRangeFieldValue(original?.rotation, TRANSFORM_FIELD_DEFAULTS.rotation));
    setSessionTransformRange(target, 'scale_uv', transformRangeFieldValue(original?.scaleUv, TRANSFORM_FIELD_DEFAULTS.scale));
    setSessionTransformRange(target, 'translate_u', transformRangeFieldValue(original?.translateU, TRANSFORM_FIELD_DEFAULTS.offsetU));
    setSessionTransformRange(target, 'translate_v', transformRangeFieldValue(original?.translateV, TRANSFORM_FIELD_DEFAULTS.offsetV));
    setSessionTransformFlip(target, 'u', original?.flipU.allowed ?? false);
    setSessionTransformFlip(target, 'v', original?.flipV.allowed ?? false);
    endSessionTransformGesture();
  };
  const authoredTransformFields: TextureTransformFields = {
    rotation: transformRangeFieldValue(activeTransformTargetInfo?.rotation, TRANSFORM_FIELD_DEFAULTS.rotation),
    scale: transformRangeFieldValue(activeTransformTargetInfo?.scaleUv, TRANSFORM_FIELD_DEFAULTS.scale),
    offsetU: transformRangeFieldValue(activeTransformTargetInfo?.translateU, TRANSFORM_FIELD_DEFAULTS.offsetU),
    offsetV: transformRangeFieldValue(activeTransformTargetInfo?.translateV, TRANSFORM_FIELD_DEFAULTS.offsetV),
  };
  const transformFields: TextureTransformFields = transformDraft
    ? { ...authoredTransformFields, [transformDraft.key]: transformDraft.value }
    : authoredTransformFields;
  const originalTransformFields: TextureTransformFields = {
    rotation: transformRangeFieldValue(originalTransformTargetInfo?.rotation, TRANSFORM_FIELD_DEFAULTS.rotation),
    scale: transformRangeFieldValue(originalTransformTargetInfo?.scaleUv, TRANSFORM_FIELD_DEFAULTS.scale),
    offsetU: transformRangeFieldValue(originalTransformTargetInfo?.translateU, TRANSFORM_FIELD_DEFAULTS.offsetU),
    offsetV: transformRangeFieldValue(originalTransformTargetInfo?.translateV, TRANSFORM_FIELD_DEFAULTS.offsetV),
  };
  const handlePushTransformFieldToAll = (key: keyof TextureTransformFields) => {
    if (!activeTransformTarget || transformDisabled) return;
    const overridePaths = weaponSlots.map((slot) => [...slot.path, 'data', 'variable']);
    pushSessionTransformRangeToAll(
      activeTransformTarget,
      TRANSFORM_FIELD_TO_PROTO[key],
      transformFields[key],
      overridePaths,
    );
  };
  const transformEditorProps: TextureTransformPanelProps | undefined = editorSelectors.length > 0 ? {
    layerLabel: weaponBaseLayerActive
      ? baseTextureTransform?.label ?? 'Base texture'
      : editorSelectors[activeEditorLayerIndex]?.label ?? 'Paint layer',
    layerIndex: activeEditorLayerIndex,
    layerCount: editorSelectors.length + (baseTextureTransform ? 1 : 0),
    fields: transformFields,
    currentSeedValues: activeSeedTransform ? {
      rotation: activeSeedTransform.rotationDeg,
      scale: activeSeedTransform.scale,
      offsetU: activeSeedTransform.translateU,
      offsetV: activeSeedTransform.translateV,
    } : undefined,
    originalValues: originalTransformFields,
    divergence: transformDivergence,
    flipU: activeTransformTargetInfo?.flipU.allowed ?? false,
    flipV: activeTransformTargetInfo?.flipV.allowed ?? false,
    scope: transformScope,
    scopeWeaponLabel: weaponName,
    isolateLayer: transformIsolateLayer,
    uvTextureSrc: transformUvSurfaceUrl,
    uvIsolationOverlaySrc: transformUvIsolationOverlayUrl,
    previewAspect: (() => {
      const weapon = data?.manifest.weapons.find((entry) => entry.key === state.weaponKey);
      return (weapon?.compositeWidth ?? 1024) / (weapon?.compositeHeight ?? 1024);
    })(),
    uvSurfaceLoading: transformUvSurfaceLoading,
    disabled: transformDisabled,
    onFieldChange: handleTransformFieldChange,
    onFlipChange: handleTransformFlipChange,
    onScopeChange: setTransformScope,
    onIsolateLayerChange: (active) => {
      if (!active) resetComposeKey();
      setTransformIsolateLayer(active);
    },
    onPushFieldToAll: handlePushTransformFieldToAll,
    onResetAll: handleTransformResetAll,
    onInteractionStart: () => {
      transformGestureActiveRef.current = true;
      transformDraftRef.current = null;
      transformDraftCommitGenerationRef.current = null;
      setTransformGestureActive(true);
    },
    onInteractionEnd: () => {
      const draft = transformDraftRef.current;
      transformGestureActiveRef.current = false;
      transformDraftRef.current = null;
      if (draft) {
        transformDraftCommitGenerationRef.current = editorDefinitionGeneration;
        commitTransformField(draft.key, draft.value);
      }
      setTransformGestureActive(false);
    },
  } : undefined;

  const openOperationTextureNode = (nodeId: string): void => {
    const node = operationGraph?.nodes.find((candidate) => candidate.id === nodeId);
    if (!node || node.kind !== 'texture_lookup') return;
    const stagePath = [...graphNodeOperationPath(node), 'stage', 'texture_lookup'];
    const samePath = (left: readonly string[] | undefined, right: readonly string[]) => (
      Boolean(left) && left!.join('\0') === right.join('\0')
    );
    if (baseTextureTransform && samePath(baseTextureTransform.transform.target.stagePath, stagePath)) {
      setWeaponBaseLayerActive(true);
      setPaintSubView('transform');
      setEditorTool('paint');
      return;
    }
    const targetIndex = transformDiscovery?.targets.findIndex((target) => (
      target !== null && samePath(target.target.stagePath, stagePath)
    )) ?? -1;
    if (targetIndex < 0 || !groupDiscovery) return;
    const groupTarget = groupDiscovery.targets[targetIndex];
    const selectorIndex = groupTarget
      ? editableGroupTargets.findIndex((target) => target.sourceKey === groupTarget.sourceKey)
      : -1;
    if (selectorIndex < 0) return;
    setWeaponBaseLayerActive(false);
    setActiveEditorSelector(selectorIndex);
    setPaintSubView('transform');
    setEditorTool('paint');
  };

  const openOperationSelectNode = (nodeId: string): void => {
    const node = operationGraph?.nodes.find((candidate) => candidate.id === nodeId);
    if (!node || node.kind !== 'select' || !groupDiscovery) return;
    const selectNodes = operationGraph?.nodes.filter((candidate) => candidate.kind === 'select') ?? [];
    const operationIndex = selectNodes.findIndex((candidate) => candidate.id === node.id);
    const groupTarget = operationIndex >= 0 ? groupDiscovery.targets[operationIndex] : undefined;
    const selectorIndex = groupTarget
      ? editableGroupTargets.findIndex((target) => target.sourceKey === groupTarget.sourceKey)
      : -1;
    if (selectorIndex < 0) return;
    setWeaponBaseLayerActive(false);
    setActiveEditorSelector(selectorIndex);
    setPaintSubView('parts');
    setEditorTool('paint');
  };

  const openOperationStickerNode = (nodeId: string): void => {
    const node = operationGraph?.nodes.find((candidate) => candidate.id === nodeId);
    if (!node || node.kind !== 'apply_sticker') return;
    const stagePath = [...graphNodeOperationPath(node), 'stage', 'apply_sticker'];
    const targetIndex = stickerTargets.findIndex((target) => target.stagePaths.some((path) => (
      path.join('\0') === stagePath.join('\0')
    )));
    if (targetIndex < 0) return;
    updateStickerDraft(null);
    setActiveStickerTarget(targetIndex);
    setEditorTool('sticker');
  };

  const toggleMobilePanel = (panel: MobilePanel) => setMobilePanel((current) => (current === panel ? 'none' : panel));

  return (
    <div
      className="app"
      data-mobile-panel={mobilePanel}
      data-catalog-hidden={!catalogVisible ? '' : undefined}
      data-controls-hidden={!controlsVisible ? '' : undefined}
    >
      <aside className="sidebar" id="warpaint-catalog-panel">
        <WarpaintList
          paintkits={paintkits}
          selectedId={selectedKitId}
          onSelect={onSelectKit}
          collectionIcons={collectionIcons}
          paintIcons={paintIcons}
          visibilityTrackedKitIds={customCatalogKitIds}
          onVisibleKitIdsChange={reportVisibleCatalogKitIds}
        />
      </aside>
      <main className="stage">
        <PanelEdgeToggle
          side="left"
          open={catalogVisible}
          label={catalogVisible ? 'Hide warpaint catalog' : 'Show warpaint catalog'}
          controls="warpaint-catalog-panel"
          onToggle={() => setCatalogVisible((visible) => !visible)}
        />
        <PanelEdgeToggle
          side="right"
          open={controlsVisible}
          label={controlsVisible ? 'Hide controls' : 'Show controls'}
          controls="viewer-controls-panel"
          onToggle={() => setControlsVisible((visible) => !visible)}
        />
        <div
          className="canvas-wrap"
          data-prompt={promptedCandidate ? '' : undefined}
          data-editor-selecting={editorInteractionActive && editorSelectionHeld ? '' : undefined}
          data-model-part-picking={stickerPartPickingActive ? '' : undefined}
          onPointerDownCapture={beginEditorPointer}
          onPointerMoveCapture={previewEditorSurface}
          onPointerUpCapture={finishEditorPointer}
          onPointerCancelCapture={cancelEditorPointer}
          onPointerLeave={() => {
            groupPointerRef.current = null;
            if (!modelPartPointerRef.current) viewerRef.current?.clearModelPartHover();
            if (groupAssignActive) setEditorSample(null);
          }}
          onPointerDown={() => setHintDismissed(true)}
          onWheel={() => setHintDismissed(true)}
        >
          <canvas ref={canvasRef} className="viewer-canvas" />
          <div className="stage-overlay-tl">
            {showStageHeader && selectedKit && (
              <div className="stage-header">
                <div
                  className="stage-header-name"
                  style={{ color: selectedKit?.grade ? `var(--grade-${selectedKit.grade})` : undefined }}
                >
                  {selectedKit.name}
                </div>
                <div className="stage-header-meta">
                  {isCustomKitId(selectedKit.id)
                    ? weaponName
                    : `${selectedKit.collection ?? 'Uncategorized'} - ${weaponName}`}
                  {Object.keys(manualTextureOverrides).length ? ' - Custom files' : ''}
                </div>
              </div>
            )}
            {composing && (
              <div className="composing-badge">
                <span className="composing-badge-spinner" aria-hidden="true" />
                <span>Compositing…</span>
              </div>
            )}
            {cameraMode === 'advanced' && (
              <div className="advanced-camera-badge" role="status">
                <span>Advanced Camera</span>
                <span className="advanced-camera-badge-exit">
                  <kbd>Alt</kbd> to exit
                </span>
              </div>
            )}
          </div>
          <StageToolbar
            workbenchOpen={workbenchOpen}
            editingMode={lightingPanelOpen && state.preset === CUSTOM_LIGHTING_ID
              ? 'lighting'
              : editorTabActive
                // The graph is a sub-view of paint editing, but its controls
                // share almost nothing with the weapon surface, so it gets its
                // own page in the reference.
                ? editorTool === 'paint' && paintSubView === 'graph' ? 'graph' : editorTool
                : null}
            onToggleWorkbench={() => {
              setWorkbenchMounted(true);
              setWorkbenchOpen((open) => !open);
            }}
            onSavePng={onScreenshot}
            onCopyImage={onCopyImage}
            onResetView={() => viewerRef.current?.resetView()}
          />
          {state.preset === CUSTOM_LIGHTING_ID && (
            <LightingPanel
              rig={state.customLighting}
              open={lightingPanelOpen}
              selectedLightId={selectedLightId}
              onChange={applyCustomLighting}
              onPreviewChange={previewCustomLighting}
              canUndo={lightingCanUndo}
              canRedo={lightingCanRedo}
              onUndo={undoLighting}
              onRedo={redoLighting}
              onClose={() => setLightingPanelOpen(false)}
              onSelectedLightIdChange={setSelectedLightId}
            />
          )}
          <div className={`canvas-hint${hintDismissed && !editorInteractionActive && !stickerEditorPreparing && !stickerPartPickingActive ? ' dismissed' : ''}`}>
            {stickerPartPickingActive
              ? 'click a part to hide it, click its outline to bring it back; Esc leaves, middle rotates, right pans'
              : stickerEditorPreparing
              ? 'Preparing sticker editor…'
              : stickerPlacementActive
              ? stickerTransformTool === 'move'
                ? 'drag the sticker to move it; Shift places, middle rotates / double-click resets, right pans'
                : stickerTransformTool === 'scale'
                  ? 'drag a scale handle; Shift places, middle rotates / double-click resets, right pans'
                  : 'drag the turn handle; Shift places, middle rotates / double-click resets, right pans'
              : groupAssignActive
                ? 'hold Shift to preview and select parts, drag to rotate'
              : 'drag to rotate, scroll to zoom, right-drag to pan, double-click to reset'}
          </div>
          {promptedCandidate && (
            <DefinitionsPrompt
              path={promptedCandidate.path}
              onImport={() => {
                promptedCandidate.onLoad();
                // Land on the tab that will show what was imported, whether the
                // drawer is open now or opened later.
                setWorkbenchTab('definitions');
                setAnsweredCandidateKey(candidateKey);
              }}
              onDismiss={() => setAnsweredCandidateKey(candidateKey)}
            />
          )}
        </div>
        <div
          className="custom-workbench-slot"
          data-open={workbenchOpen ? '' : undefined}
          data-expanded={workbenchExpanded ? '' : undefined}
          inert={!workbenchOpen}
          style={workbenchHeight ? ({ '--workbench-h': `${workbenchHeight}px` } as CSSProperties) : undefined}
        >
          {workbenchMounted && (
            <Suspense fallback={<div className="custom-workbench-loading">Loading custom files…</div>}>
              <CustomWarpaintWorkbench
                key={`${selectedKitId ?? 'empty'}|${state.weaponKey}`}
                recipes={workbenchTab === 'package' || workbenchTab === 'definitions' ? [] : editorRecipes}
                definitions={definitionsState}
                tab={workbenchTab}
                onTabChange={(nextTab) => {
                  setWorkbenchTab(nextTab);
                  if (nextTab !== 'editor') setWorkbenchExpanded(false);
                }}
                expanded={workbenchExpanded}
                onExpandedChange={setWorkbenchExpanded}
                resolveTexture={data.resolveTexture}
                textureMetadata={data.manifest.textures}
                paintName={selectedKit?.name}
                weaponName={weaponName}
                gameBuild={data.manifest.gameBuild}
                snapshotDate={data.manifest.generatedAt}
                exportDefinitions={exportDefinitions}
                editor={{
                  mode: editorTool,
                  onModeChange: (mode) => {
                    setEditorTool(mode);
                    updateStickerDraft(null);
                    setEditorSample(null);
                    setPanelPreviewGroup(null);
                  },
                  ...(stickerTargets.length > 0 ? {
                    sticker: {
                      targets: (() => {
                        // Several stickers can share a source, so a repeated
                        // name gets its ordinal back to stay distinguishable.
                        const seen = new Map<string, number>();
                        return stickerTargets.map((target, index) => {
                          const label = stickerTargetLabel(target.stickers[0]?.base.resolvedValue, index);
                          const count = (seen.get(label) ?? 0) + 1;
                          seen.set(label, count);
                          return {
                            id: target.id,
                            label: count > 1 ? `${label} ${count}` : label,
                            canMoveEarlier: target.canMoveEarlier,
                            canMoveLater: target.canMoveLater,
                            thumbnail: groupStickerArtwork[target.id]?.url
                              ?? stickerTargetThumbnails[target.id]
                              ?? null,
                          };
                        });
                      })(),
                      textureChoices: currentStickerTextureChoices,
                      allTextureChoices: allStickerTextureChoices,
                      selectionTargets: stickerTargets.flatMap((target, index) => {
                        if (!target.quad) return [];
                        const read = stickerPlacementFromQuad(target.quad);
                        if (!read.editable || !read.placement) return [];
                        return [{
                          id: target.id,
                          label: stickerTargetLabel(target.stickers[0]?.base.resolvedValue, index),
                          placement: read.placement,
                          artworkSrc: groupStickerArtwork[target.id]?.url
                            ?? stickerTargetArtwork[target.id]
                            ?? null,
                        }];
                      }),
                      activeSelectionId: selectedStickerTarget?.id,
                      onSelectionChange: (id: string) => {
                        const nextIndex = stickerTargets.findIndex((target) => target.id === id);
                        if (nextIndex < 0 || nextIndex === activeStickerTarget) return;
                        updateStickerDraft(null);
                        setActiveStickerTarget(nextIndex);
                      },
                      activeTargetId: selectedStickerTarget?.id ?? stickerTargets[0].id,
                      onActiveTargetChange: (id: string) => {
                        const nextIndex = stickerTargets.findIndex((target) => target.id === id);
                        if (nextIndex < 0 || nextIndex === activeStickerTarget) return;
                        updateStickerDraft(null);
                        setActiveStickerTarget(nextIndex);
                      },
                      onAddTarget: (baseReference: string) => {
                        if (!selectedStickerTarget?.quad) return;
                        if (addSessionSticker(
                          { stagePaths: selectedStickerTarget.stagePaths },
                          selectedStickerTarget.quad,
                          baseReference,
                        )) setPendingAddedStickerRef(baseReference);
                      },
                      onRemoveTarget: () => {
                        if (!selectedStickerTarget) return;
                        if (removeSessionSticker({ stagePaths: selectedStickerTarget.stagePaths })) {
                          setActiveStickerTarget(Math.max(0, selectedStickerIndex - 1));
                        }
                      },
                      onMoveTarget: (direction: -1 | 1) => {
                        if (!selectedStickerTarget) return;
                        if (moveSessionSticker({ stagePaths: selectedStickerTarget.stagePaths }, direction)) {
                          setActiveStickerTarget(selectedStickerIndex + direction);
                        }
                      },
                      textureSrc: stickerSurfaceUrl,
                      stickerSrc: effectiveStickerTextureUrl,
                      groupPreview: groupStickerUvPreview,
                      renderStickerArtwork: !selectedStickerUsesComposedArtwork,
                      textureAspect: stickerSurfaceAspect,
                      stickerAspect,
                      onCreatePlacement: selectedStickerTarget?.editable && !stickerPlacementRead.editable
                        ? () => {
                            const quad = stickerPlacementToQuad(fitStickerPlacement(stickerAspect));
                            if (quad) setSessionStickerQuad(selectedStickerTarget.target, quad);
                          }
                        : undefined,
                      placement: stickerPlacement ?? DEFAULT_STICKER_PLACEMENT,
                      quad: stickerDraftQuad ?? authoredStickerQuad ?? undefined,
                      onPlacementChange: changeStickerPlacement,
                      onQuadChange: changeStickerQuad,
                      protoVariableNames: selectedStickerTarget ? {
                        tl: selectedStickerTarget.destTl.variableName,
                        tr: selectedStickerTarget.destTr.variableName,
                        bl: selectedStickerTarget.destBl.variableName,
                      } : undefined,
                      activeTool: stickerTransformTool,
                      onActiveToolChange: setStickerTransformTool,
                      aspectLocked: stickerAspectLocked,
                      onAspectLockedChange: setStickerAspectLocked,
                      modelPartPickingActive: stickerPartPickingActive,
                      hiddenModelPartCount,
                      onModelPartPickingChange: setModelPartPicking,
                      onRestoreHiddenModelParts: restoreHiddenModelParts,
                      onInteractionStart: beginStickerInteraction,
                      onInteractionEnd: finishStickerInteraction,
                      onInteractionCancel: () => updateStickerDraft(null),
                      disabled: !stickerEditorReady,
                      notice: (!selectedStickerTarget?.editable || !stickerPlacementRead.editable)
                        ? selectedStickerTarget?.reason
                          ?? stickerPlacementRead.reason
                          ?? 'This sticker position cannot be changed.'
                        : (!stickerEditorReady ? 'Preparing sticker editor…' : null),
                    },
                  } : {}),
                  enabled: editorEnabled,
                  unavailableReason: editorUnavailableReason,
                  sample: editorSample,
                  selectedGroupIds: activeSelectedGroupBuckets,
                  selectionContextId: weaponBaseLayerActive ? 'weapon-base' : String(activeEditorSelector),
                  groupLabels: activeGroupLabels,
                  notice: editorAssignmentNotice,
                  activeLayerIndex: activeEditorLayerIndex,
                  activeLayerLabel: weaponBaseLayerActive ? baseTextureTransform?.label : editorSelectors[activeEditorLayerIndex]?.label,
                  groupLayerIndex: groupBucketLayerIndex,
                  layerColors: editorLayerCssColors,
                  layerSwatchColors: editorLayerSwatchCssColors,
                  layerThumbnails: editableLayerTextureRefs.map((textureRef) => (
                    textureRef ? layerTexturePreviewUrls[textureRef] ?? null : null
                  )),
                  baseLayer: baseTextureTransform ? {
                    label: baseTextureTransform.label,
                    thumbnail: baseLayerTextureRef ? layerTexturePreviewUrls[baseLayerTextureRef] ?? null : null,
                    active: weaponBaseLayerActive,
                    onSelect: () => {
                      setPanelPreviewGroup(null);
                      setEditorAssignmentNotice(null);
                      setWeaponBaseLayerActive(true);
                    },
                  } : undefined,
                  showLayerMap,
                  onShowLayerMapChange: setShowLayerMap,
                  inspectOnClick: groupAssignActive,
                  onInspectOnClickChange: () => undefined,
                  onToggleGroup: toggleEditorGroup,
                  onClearSelection: clearEditorGroups,
                  clearSelectionDisabled: weaponBaseLayerActive,
                  onPreviewGroup: setPanelPreviewGroup,
                  groupTextureChoices,
                  activeGroupTextureRef: activeGroupTextureValue,
                  onGroupTextureChange: groupTextureTarget ? (ref) => {
                    const normalizedRef = normalizeGroupTextureReference(ref);
                    setRequestedGroupTextureRef(normalizedRef);
                    const defaultIds = preferredAlbedoGroupIds(ref).filter((groupId) => (
                      !groupAssignmentTargets.some((target) => target.selectedGroupIds.includes(groupId))
                    ));
                    const albedoTarget = defaultIds.length > 0
                      ? groupAssignmentTargets.find((target) => (
                        target.canAssign && target.label.trim().toLowerCase() === 'albedo'
                      ))
                      : undefined;
                    const defaultAssignment = albedoTarget ? {
                      active: albedoTarget,
                      candidates: groupAssignmentTargets,
                      groupIds: defaultIds,
                    } : undefined;
                    if (setSessionGroupTexture(groupTextureTarget, ref, defaultAssignment)) {
                      setEditorSample(null);
                      setPanelPreviewGroup(null);
                    } else {
                      setRequestedGroupTextureRef(null);
                    }
                  } : undefined,
                  dirty: editorDirty,
                  canDownload: editableKitId !== null && !editorLoading && !editorPackageExporting,
                  exporting: editorPackageExporting,
                  canUndo: editorCanUndo,
                  canRedo: editorCanRedo,
                  error: editableKitId !== null
                    ? (editorPackageExportError
                      ?? operationGraphEditError
                      ?? editorSessionError
                      ?? editorPreviewError)
                    : null,
                  selectors: editorSelectors,
                  activeSelectorId: weaponBaseLayerActive ? 'weapon-base' : String(activeEditorSelector),
                  onActiveSelectorChange: (id) => {
                    setPanelPreviewGroup(null);
                    setEditorAssignmentNotice(null);
                    setWeaponBaseLayerActive(false);
                    setActiveEditorSelector(Number(id));
                  },
                  onUndo: undoEditorSynced,
                  onRedo: redoEditorSynced,
                  onReset: resetEditorSynced,
                  onDownloadPackage: downloadEditorPackage,
                  ...(transformEditorProps ? { transform: transformEditorProps } : {}),
                  ...(operationGraph ? {
                    graph: {
                      graph: operationGraph,
                      selectedNodeId: selectedOperationGraphNodeId ?? undefined,
                      onSelectNode: setSelectedOperationGraphNodeId,
                      onGraphChange: handleOperationGraphChange,
                      onUpdateNodeRaw: updateOperationGraphRaw,
                      onUpdateParameter: updateOperationGraphParameter,
                      textureOptions: operationGraphTextureOptions,
                      variables: operationGraphVariables,
                      onOpenTextureEditor: openOperationTextureNode,
                      onOpenSelectEditor: openOperationSelectNode,
                      onOpenStickerEditor: openOperationStickerNode,
                      onPreviewNode: (nodeId) => operationGraphPreviewUrls[nodeId],
                      onExportNode: (nodeId, format) => { void exportOperationGraphNode(nodeId, format); },
                      readOnly: editorStatus !== 'ready',
                    },
                  } : {}),
                  ...(materialsEditorProps ? { materials: materialsEditorProps } : {}),
                  paintSubView,
                  onPaintSubViewChange: setPaintSubView,
                  layerHasTransformEdits,
                  layerTransformLocked,
                }}
                sourcePackage={sourcePackage}
                resolvePackageTexture={resolvePackageTexture}
                hasPackageTexture={(ref) => Boolean(sourceProvider.packagePathFor(ref))}
                packageGeneration={packageGeneration}
                loading={editorLoading}
                open={workbenchOpen}
                initialOverrides={assetOverrides}
                onChange={(overrides) => {
                  resetComposeKey();
                  setAssetOverrideCache((cache) => ({ ...cache, [assetOverrideScope]: overrides }));
                }}
                onResetAll={() => {
                  removePackage();
                  clearAssetOverrideCache();
                }}
                // A height of 0 means "back to the default clamp", which is what
                // double-clicking the drawer's resize handle asks for.
                onResize={setWorkbenchHeight}
                onClose={() => {
                  setWorkbenchExpanded(false);
                  setWorkbenchOpen(false);
                }}
              />
            </Suspense>
          )}
        </div>
      </main>
      <aside className="inspector" id="viewer-controls-panel">
        <Inspector
          manifest={data.manifest}
          weaponOptions={weaponOptions}
          hasTeamTextures={selectedKit?.hasTeamTextures ?? false}
          state={state}
          viewAngle={viewAngleId}
          onChange={patch}
          onRandomizeSeed={randomizeSeed}
          onUndoSeed={undoSeed}
          canUndoSeed={canUndoSeed}
          onViewAngle={onViewAngle}
          lightingPanelOpen={lightingPanelOpen}
          selectedLightId={selectedLightId}
          onToggleLightingPanel={toggleLightingPanel}
          onSelectLight={selectLight}
          onCustomLightingChange={applyCustomLighting}
          onCustomLightingPreviewChange={previewCustomLighting}
        />
      </aside>
      <nav className="mobile-tabstrip" aria-label="Panels">
        <button
          type="button"
          className="mobile-tab-btn"
          aria-pressed={mobilePanel === 'catalog'}
          onClick={() => toggleMobilePanel('catalog')}
        >
          <Palette size={18} />
          <span>Warpaints</span>
        </button>
        <button
          type="button"
          className="mobile-tab-btn"
          aria-pressed={mobilePanel === 'none'}
          onClick={() => setMobilePanel('none')}
        >
          <Eye size={18} />
          <span>Viewer</span>
        </button>
        <button
          type="button"
          className="mobile-tab-btn"
          aria-pressed={mobilePanel === 'controls'}
          onClick={() => toggleMobilePanel('controls')}
        >
          <SlidersHorizontal size={18} />
          <span>Controls</span>
        </button>
      </nav>
      {boot.progress < 100 && <BootLoader boot={boot} />}
    </div>
  );
}
