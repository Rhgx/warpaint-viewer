import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent } from 'react';
import {
  AlertTriangle,
  Eye,
  EyeOff,
  FileImage,
  ImagePlus,
  Layers,
  LoaderCircle,
  PackageOpen,
  RotateCcw,
  Search,
  Sticker,
  X,
} from 'lucide-react';
import type { RecipeNode } from '../compositor/types';
import type { TextureMetadata } from '../data/types';
import { TextField } from './components';
import { SourcePackageImport, SourcePackagePanel } from './SourcePackagePanel';
import type { SourcePackageState } from './SourcePackagePanel';
import './CustomWarpaintImport.css';
import './SourcePackagePanel.css';

export interface WarpaintAssetOverrides {
  revision: number;
  assets: Record<string, WarpaintAssetState>;
}

type SlotGroup = 'artwork' | 'mask' | 'support';

export interface WearRecipe {
  wearIndex: number;
  recipe: RecipeNode;
}

interface AssetSlot {
  ref: string;
  kind: 'texture' | 'mask' | 'sticker' | 'sticker-mask';
  group: SlotGroup;
}

export interface WarpaintAssetState {
  color?: { dataUrl: string; fileName: string; isTga: boolean; hasEmbeddedAlpha?: boolean };
  alpha?: { dataUrl: string; fileName: string };
  output?: string;
  size?: { width: number; height: number };
}

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_VTF_PIXELS = 16 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'tga', 'vtf'];
const MIN_PANEL_HEIGHT = 190;
const RESET_CONFIRM_MS = 3000;

// Unions the inputs of every wear variant. A per-wear paint reads different
// textures at different wear levels (dirt, blood, scratches, burnt albedo),
// and all of them stay listed so an edit never depends on where the wear
// slider happens to sit.
function collectSlots(recipes: WearRecipe[]): AssetSlot[] {
  if (recipes.length === 0) return [];
  type Draft = Omit<AssetSlot, 'group'>;
  const slots = new Map<string, Draft>();
  const add = (ref: string | undefined, kind: AssetSlot['kind']) => {
    if (ref && !slots.has(ref)) slots.set(ref, { ref, kind });
  };
  const visit = (current: RecipeNode) => {
    switch (current.type) {
      case 'texture_lookup':
        add(current.texture, 'texture');
        break;
      case 'select':
        add(current.groups, 'mask');
        break;
      case 'apply_sticker':
        for (const sticker of current.stickers ?? []) {
          add(sticker.base, 'sticker');
          add(sticker.spec, 'sticker-mask');
        }
        current.nodes.forEach(visit);
        break;
      default:
        current.nodes.forEach(visit);
    }
  };
  for (const entry of recipes) visit(entry.recipe);
  const priority = (slot: Draft) => {
    const ref = slot.ref.toLowerCase();
    // Put the identity of the selected paint in view first. Weapon AO/group/
    // wear maps and generated blank inputs are still editable, but they are
    // implementation support files and should not bury the custom artwork.
    if (ref.includes('/patterns/workshop/')) return 0;
    if (ref.includes('/patterns/') && !ref.includes('/blank')) return 1;
    if (slot.kind === 'sticker' && !ref.includes('/blank')) return 2;
    if (ref.includes('albedo')) return 3;
    if (slot.kind === 'mask' || slot.kind === 'sticker-mask') return 4;
    if (ref.includes('ao') || ref.includes('wearblend') || ref.includes('/blank')) return 6;
    return 5;
  };
  return [...slots.values()]
    .sort((a, b) => priority(a) - priority(b))
    .map((slot) => {
      const rank = priority(slot);
      const group: SlotGroup = rank <= 2 ? 'artwork' : rank === 4 ? 'mask' : 'support';
      return { ...slot, group };
    });
}

function shortName(ref: string): string {
  const file = ref.split('/').pop() ?? ref;
  return file.replace(/\.[^.]+$/, '').replace(/^p_/, '').replace(/[_-]+/g, ' ');
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error('The image could not be decoded.'));
    image.onload = () => resolve(image);
    image.src = dataUrl;
  });
}

function TexturePreview({
  refPath,
  fallbackUrl,
  resolvePackageTexture,
  packageGeneration,
}: {
  refPath: string | undefined;
  fallbackUrl: string;
  resolvePackageTexture?: (ref: string) => Promise<string>;
  packageGeneration: number;
}) {
  const [src, setSrc] = useState(fallbackUrl);
  useEffect(() => {
    let cancelled = false;
    setSrc(fallbackUrl);
    if (!refPath || !resolvePackageTexture) return () => { cancelled = true; };
    void resolvePackageTexture(refPath).then((url) => {
      if (!cancelled) setSrc(url);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [refPath, fallbackUrl, resolvePackageTexture, packageGeneration]);
  return <img src={src} alt="" />;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);

  let crc = 0xffffffff;
  for (let i = 4; i < 8 + data.length; i += 1) {
    crc ^= chunk[i];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  view.setUint32(8 + data.length, (crc ^ 0xffffffff) >>> 0);
  return chunk;
}

function storeZlib(data: Uint8Array): Uint8Array {
  const blockCount = Math.ceil(data.length / 0xffff);
  const output = new Uint8Array(2 + data.length + blockCount * 5 + 4);
  output.set([0x78, 0x01]); // zlib header: deflate with the fastest strategy
  let sourceOffset = 0;
  let outputOffset = 2;
  while (sourceOffset < data.length) {
    const length = Math.min(0xffff, data.length - sourceOffset);
    output[outputOffset] = sourceOffset + length === data.length ? 1 : 0;
    output[outputOffset + 1] = length & 0xff;
    output[outputOffset + 2] = length >>> 8;
    output[outputOffset + 3] = (~length) & 0xff;
    output[outputOffset + 4] = ((~length) >>> 8) & 0xff;
    output.set(data.subarray(sourceOffset, sourceOffset + length), outputOffset + 5);
    sourceOffset += length;
    outputOffset += length + 5;
  }
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i += 1) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  new DataView(output.buffer).setUint32(outputOffset, ((b << 16) | a) >>> 0);
  return output;
}

async function encodeRgbaPng(data: Uint8Array, width: number, height: number): Promise<string> {
  // Canvas serialisation premultiplies RGB by alpha. That is correct for a
  // displayed image, but corrupts TF2 textures where RGB and alpha are two
  // independent data channels. Build the PNG bytes directly instead.
  const scanlines = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 4);
    scanlines[row] = 0;
    scanlines.set(data.subarray(y * width * 4, (y + 1) * width * 4), row + 1);
  }
  const compressed = typeof CompressionStream === 'undefined'
    ? storeZlib(scanlines)
    : new Uint8Array(await new Response(
      new Blob([scanlines]).stream().pipeThrough(new CompressionStream('deflate')),
    ).arrayBuffer());
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, deflate, no interlace
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', new Uint8Array()),
  ];
  const png = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return readAsDataUrl(new File([png.buffer], 'decoded.png', { type: 'image/png' }));
}

async function decodeTga(file: File): Promise<string> {
  const { TGALoader } = await import('three/addons/loaders/TGALoader.js');
  const parsed = new TGALoader().parse(await file.arrayBuffer());
  if (!parsed.data || !parsed.width || !parsed.height) throw new Error('This TGA has no readable pixel data.');
  return encodeRgbaPng(Uint8Array.from(parsed.data as ArrayLike<number>), parsed.width, parsed.height);
}

async function decodeVtf(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  // The Worker client is loaded only when a VTF is selected. It retains an
  // in-process fallback for older browsers and test environments.
  const { decodeVtfToPng, VtfDecodeError } = await import('../source/vtfDecode');
  try {
    const decoded = await decodeVtfToPng(bytes, {
      maxPixels: MAX_VTF_PIXELS,
      limitDescription: '16 megapixel import limit',
    });
    return readAsDataUrl(new File([decoded.png], 'decoded.png', { type: 'image/png' }));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'The image data could not be decoded.';
    const header = cause instanceof VtfDecodeError ? cause.header : undefined;
    // Header-size validation was historically reported without decode details.
    // Keep that actionable import error stable while retaining VTF metadata for
    // actual pixel-format/decompression failures.
    if (detail.startsWith('VTF dimensions ')) throw new Error(`${file.name}: ${detail}`);
    throw new Error(header
      ? `${file.name}: VTF ${header.verMajor}.${header.verMinor}, format ${header.highResFormat}: ${detail}`
      : `${file.name}: ${detail}`);
  }
}

async function readTexture(file: File, alphaOnly = false) {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!SUPPORTED_EXTENSIONS.includes(extension) || (alphaOnly && extension === 'tga')) {
    throw new Error(alphaOnly ? 'Choose a PNG, JPG, or WebP alpha mask.' : 'Choose a PNG, JPG, WebP, TGA, or VTF texture.');
  }
  if (alphaOnly && extension === 'vtf') throw new Error('VTF textures contain their own alpha channel and cannot be used as a separate alpha mask.');
  if (file.size > MAX_FILE_BYTES) throw new Error('Files must be 32 MB or smaller.');
  return {
    dataUrl: extension === 'tga' ? await decodeTga(file) : extension === 'vtf' ? await decodeVtf(file) : await readAsDataUrl(file),
    fileName: file.name,
    isTga: extension === 'tga',
    hasEmbeddedAlpha: extension === 'tga' || extension === 'vtf',
  };
}

async function mergeAlpha(colorUrl: string, alphaUrl: string): Promise<string> {
  const [color, alpha] = await Promise.all([loadImage(colorUrl), loadImage(alphaUrl)]);
  const canvas = document.createElement('canvas');
  canvas.width = color.naturalWidth;
  canvas.height = color.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('The browser could not merge the alpha mask.');
  context.drawImage(color, 0, 0);
  const colorPixels = context.getImageData(0, 0, canvas.width, canvas.height);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(alpha, 0, 0, canvas.width, canvas.height);
  const maskPixels = context.getImageData(0, 0, canvas.width, canvas.height);
  let hasTransparency = false;
  for (let i = 3; i < maskPixels.data.length; i += 4) {
    if (maskPixels.data[i] < 255) { hasTransparency = true; break; }
  }
  for (let i = 0; i < colorPixels.data.length; i += 4) {
    colorPixels.data[i + 3] = hasTransparency
      ? maskPixels.data[i + 3]
      : Math.round(maskPixels.data[i] * 0.299 + maskPixels.data[i + 1] * 0.587 + maskPixels.data[i + 2] * 0.114);
  }
  context.putImageData(colorPixels, 0, 0);
  return canvas.toDataURL('image/png');
}

const KIND_LABEL: Record<AssetSlot['kind'], string> = {
  texture: 'Texture',
  mask: 'Region mask',
  sticker: 'Sticker',
  'sticker-mask': 'Sticker mask',
};

const GROUP_LABEL: Record<SlotGroup, string> = {
  artwork: 'Artwork',
  mask: 'Masks',
  support: 'Support files',
};

const GROUP_ORDER: SlotGroup[] = ['artwork', 'mask', 'support'];

export function CustomWarpaintWorkbench({
  recipes,
  resolveTexture,
  textureMetadata,
  sourcePackage,
  resolvePackageTexture,
  packageGeneration,
  loading,
  open,
  initialOverrides,
  onChange,
  onResetAll,
  onResize,
  onClose,
}: {
  recipes: WearRecipe[];
  resolveTexture: (ref: string) => string;
  textureMetadata?: Record<string, TextureMetadata>;
  sourcePackage: SourcePackageState;
  /** Async Source package resolver used only for the non-destructive preview. */
  resolvePackageTexture?: (ref: string) => Promise<string>;
  packageGeneration?: number;
  loading: boolean;
  open: boolean;
  initialOverrides: WarpaintAssetOverrides;
  onChange: (overrides: WarpaintAssetOverrides) => void;
  /** Reset all returns the entire workbench to built-ins, including its package. */
  onResetAll?: () => void;
  onResize: (height: number) => void;
  onClose: () => void;
}) {
  const slots = useMemo(() => collectSlots(recipes), [recipes]);
  const [assets, setAssets] = useState<Record<string, WarpaintAssetState>>(initialOverrides.assets);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [comparing, setComparing] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [dropping, setDropping] = useState(false);
  // dragenter/dragleave fire for every child the pointer crosses, so the cue
  // is driven by a depth count instead of the last event seen.
  const dragDepthRef = useRef(0);
  const revisionRef = useRef(initialOverrides.revision);
  // Async imports read the edit set after their awaits, so the latest map has
  // to be readable outside of React's render closure.
  const assetsRef = useRef(assets);
  const sectionRef = useRef<HTMLElement | null>(null);

  const replacedCount = Object.keys(assets).length;

  // Escape closes the drawer, matching every other dismissible surface. The
  // filter field swallows it first so a stray Escape only clears the search.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!confirmReset) return;
    const timer = window.setTimeout(() => setConfirmReset(false), RESET_CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [confirmReset]);

  const commit = (next: Record<string, WarpaintAssetState>) => {
    assetsRef.current = next;
    setAssets(next);
    revisionRef.current += 1;
    onChange({ revision: revisionRef.current, assets: next });
  };

  const setSlotError = (ref: string, message: string) => {
    setErrors((current) => {
      const next = { ...current };
      if (message) next[ref] = message;
      else delete next[ref];
      return next;
    });
  };

  const rebuild = async (asset: WarpaintAssetState): Promise<WarpaintAssetState> => {
    if (!asset.color) return { ...asset, output: undefined, size: undefined };
    const output = asset.alpha
      ? await mergeAlpha(asset.color.dataUrl, asset.alpha.dataUrl)
      : asset.color.dataUrl;
    const image = await loadImage(output);
    return { ...asset, output, size: { width: image.naturalWidth, height: image.naturalHeight } };
  };

  const updateFile = async (slot: AssetSlot, file: File | undefined, alphaOnly: boolean) => {
    if (!file) return;
    setSlotError(slot.ref, '');
    setBusy((current) => ({ ...current, [slot.ref]: true }));
    try {
      const read = await readTexture(file, alphaOnly);
      const current = assetsRef.current[slot.ref] ?? {};
      const nextAsset: WarpaintAssetState = alphaOnly
        ? { ...current, alpha: { dataUrl: read.dataUrl, fileName: read.fileName } }
        : { ...current, color: read, alpha: read.hasEmbeddedAlpha ? undefined : current.alpha };
      commit({ ...assetsRef.current, [slot.ref]: await rebuild(nextAsset) });
    } catch (cause) {
      setSlotError(slot.ref, cause instanceof Error ? cause.message : 'The file could not be imported.');
    } finally {
      setBusy((current) => {
        const next = { ...current };
        delete next[slot.ref];
        return next;
      });
    }
  };

  const removeAlpha = async (ref: string) => {
    const current = assetsRef.current[ref];
    if (!current?.alpha) return;
    const { alpha: _alpha, ...rest } = current;
    commit({ ...assetsRef.current, [ref]: await rebuild(rest) });
  };

  const resetSlot = (ref: string) => {
    const next = { ...assetsRef.current };
    delete next[ref];
    setSlotError(ref, '');
    commit(next);
  };

  const resetAll = () => {
    setErrors({});
    setComparing({});
    commit({});
    onResetAll?.();
  };

  // Drag the drawer's top edge to trade stage height for a taller asset grid.
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const startY = event.clientY;
    const startHeight = sectionRef.current?.offsetHeight ?? 0;
    const maxHeight = Math.round(window.innerHeight * 0.75);
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
    const move = (moveEvent: PointerEvent) => {
      const height = startHeight + (startY - moveEvent.clientY);
      onResize(Math.min(maxHeight, Math.max(MIN_PANEL_HEIGHT, height)));
    };
    const stop = () => {
      setResizing(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  };

  // Package files can be dropped anywhere on the workbench, not just onto the
  // bar: the drawer is short, and hunting for a small well is worse than
  // treating the whole surface as the target.
  const dragging = (event: ReactDragEvent<HTMLElement>) => [...event.dataTransfer.types].includes('Files');
  const dropHandlers = {
    onDragEnter: (event: ReactDragEvent<HTMLElement>) => {
      if (!dragging(event)) return;
      dragDepthRef.current += 1;
      setDropping(true);
    },
    onDragOver: (event: ReactDragEvent<HTMLElement>) => {
      if (!dragging(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: () => {
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setDropping(false);
    },
    onDrop: (event: ReactDragEvent<HTMLElement>) => {
      if (!dragging(event)) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      setDropping(false);
      const files = [...event.dataTransfer.files];
      if (files.length) sourcePackage.onImport(files);
    },
  };

  const query = filter.trim().toLowerCase();
  const visible = slots.filter((slot) => !query
    || shortName(slot.ref).toLowerCase().includes(query)
    || slot.ref.toLowerCase().includes(query));
  const groups = GROUP_ORDER
    .map((group) => ({ group, items: visible.filter((slot) => slot.group === group) }))
    .filter((entry) => entry.items.length > 0);

  return (
    <section
      className="custom-workbench"
      aria-label="Custom warpaint files"
      ref={sectionRef}
      data-dropping={dropping ? '' : undefined}
      {...dropHandlers}
    >
      <div
        className="custom-workbench-resizer"
        role="separator"
        aria-label="Resize custom files panel"
        aria-orientation="horizontal"
        data-resizing={resizing ? '' : undefined}
        onPointerDown={startResize}
        onDoubleClick={() => onResize(0)}
      />
      <header className="custom-workbench-header">
        <div className="custom-workbench-search">
          <Search className="custom-workbench-search-icon" size={13} />
          <TextField
            value={filter}
            onChange={setFilter}
            placeholder="Filter inputs..."
            onKeyDown={(event) => {
              if (event.key === 'Escape' && filter) {
                event.preventDefault();
                setFilter('');
              }
            }}
          />
        </div>
        <div className="custom-workbench-summary">
          <SourcePackageImport state={sourcePackage} />
          <span>{replacedCount ? `${replacedCount} of ${slots.length} replaced` : `${slots.length} inputs`}</span>
          {(replacedCount > 0 || sourcePackage.status === 'mounted') && (
            <button
              type="button"
              className="custom-workbench-reset-all"
              data-confirm={confirmReset ? '' : undefined}
              onClick={() => (confirmReset ? resetAll() : setConfirmReset(true))}
            >
              <RotateCcw size={12} />
              {confirmReset ? 'Discard all?' : 'Reset all'}
            </button>
          )}
          <button
            type="button"
            title="Close custom warpaint files"
            aria-label="Close custom warpaint files"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
      </header>

      <SourcePackagePanel state={sourcePackage} />

      {dropping && (
        <div className="source-package-dropzone">
          <PackageOpen size={18} />
          Drop a Source .zip or .vpk to mount it
        </div>
      )}

      <div className="custom-workbench-body">
        {loading ? (
          <div className="custom-workbench-empty"><LoaderCircle className="custom-workbench-spinner" size={20} /> Reading recipe inputs...</div>
        ) : recipes.length === 0 ? (
          <div className="custom-workbench-empty"><FileImage size={22} /> Select a warpaint to use as the editable recipe template.</div>
        ) : groups.length === 0 ? (
          <div className="custom-workbench-empty">
            <Search size={18} /> No inputs match “{filter}”.
          </div>
        ) : (
          groups.map(({ group, items }) => (
            <div className="custom-asset-group" key={group}>
              <div className="custom-asset-group-label">{GROUP_LABEL[group]}<span>{items.length}</span></div>
              <div className="custom-asset-grid">
                {items.map((slot) => {
                  const asset = assets[slot.ref];
                  const original = textureMetadata?.[slot.ref];
                  const showOriginal = comparing[slot.ref] && asset?.output;
                  const mismatch = asset?.size && original
                    && (asset.size.width !== original.width || asset.size.height !== original.height);
                  return (
                    <article className="custom-asset-card" key={slot.ref} data-replaced={asset ? '' : undefined}>
                      <div className="custom-asset-preview">
                        <TexturePreview
                          // Compare removes only the manual layer. It must
                          // reveal a mounted package before falling through to
                          // the built-in asset, matching the real resolver.
                          refPath={showOriginal ? slot.ref : asset?.output ?? slot.ref}
                          fallbackUrl={showOriginal ? resolveTexture(slot.ref) : asset?.output ?? resolveTexture(slot.ref)}
                          resolvePackageTexture={resolvePackageTexture}
                          packageGeneration={packageGeneration ?? 0}
                        />
                        <span className="custom-asset-kind">{KIND_LABEL[slot.kind]}</span>
                        {asset?.output && (
                          <button
                            type="button"
                            className="custom-asset-compare"
                            title={showOriginal ? 'Show imported file' : 'Show original file'}
                            aria-label={showOriginal ? 'Show imported file' : 'Show original file'}
                            aria-pressed={Boolean(showOriginal)}
                            onClick={() => setComparing((current) => ({ ...current, [slot.ref]: !current[slot.ref] }))}
                          >
                            {showOriginal ? <EyeOff size={12} /> : <Eye size={12} />}
                          </button>
                        )}
                        {busy[slot.ref] && (
                          <div className="custom-asset-busy">
                            <LoaderCircle className="custom-workbench-spinner" size={18} />
                          </div>
                        )}
                      </div>
                      <div className="custom-asset-info">
                        <div className="custom-asset-name">
                          {slot.kind.startsWith('sticker') && <Sticker size={12} />}
                          <span>{shortName(slot.ref)}</span>
                        </div>
                        <div className="custom-asset-path" title={slot.ref}>{slot.ref}</div>
                        <div className="custom-asset-files">
                          {asset?.color ? (
                            <>
                              <span className="custom-asset-file" title={asset.color.fileName}>
                                {asset.color.fileName}{(asset.color.hasEmbeddedAlpha ?? asset.color.isTga) ? ' (embedded alpha)' : ''}
                              </span>
                              {asset.alpha && (
                                <span className="custom-asset-file" title={asset.alpha.fileName}>
                                  Alpha: {asset.alpha.fileName}
                                  <button
                                    type="button"
                                    className="custom-asset-file-remove"
                                    title="Remove the alpha mask"
                                    aria-label="Remove the alpha mask"
                                    onClick={() => void removeAlpha(slot.ref)}
                                  >
                                    <X size={10} />
                                  </button>
                                </span>
                              )}
                              {asset.size && (
                                <span className={mismatch ? 'custom-asset-warn' : undefined}>
                                  {mismatch && <AlertTriangle size={10} />}
                                  {asset.size.width} x {asset.size.height}
                                  {mismatch && original ? ` (original ${original.width} x ${original.height})` : ''}
                                </span>
                              )}
                            </>
                          ) : (
                            <span className="custom-asset-hint">
                              {original ? `Original ${original.width} x ${original.height}` : 'Original file'}
                            </span>
                          )}
                          {errors[slot.ref] && <span className="custom-asset-error" role="alert">{errors[slot.ref]}</span>}
                        </div>
                        <div className="custom-asset-actions">
                          <label className="custom-file-button" title="Import a PNG, JPG, WebP, TGA or VTF texture">
                            <ImagePlus size={13} />
                            <span>{asset?.color ? 'Replace' : 'Texture'}</span>
                            <input
                              type="file"
                              accept=".png,.jpg,.jpeg,.webp,.tga,.vtf"
                              aria-label={`Import a texture for ${shortName(slot.ref)}`}
                              onChange={(event) => {
                                const file = event.target.files?.[0];
                                // Clear the input so picking the same file
                                // again after a reset still fires a change.
                                event.target.value = '';
                                void updateFile(slot, file, false);
                              }}
                            />
                          </label>
                          {!(asset?.color && (asset.color.hasEmbeddedAlpha ?? asset.color.isTga)) && (
                            <label
                              className="custom-file-button custom-file-button-secondary"
                              title="Import a separate greyscale or transparent image to use as this texture's alpha channel"
                            >
                              <Layers size={12} />
                              <span>Alpha</span>
                              <input
                                type="file"
                                accept=".png,.jpg,.jpeg,.webp"
                                aria-label={`Import an alpha mask for ${shortName(slot.ref)}`}
                                onChange={(event) => {
                                  const file = event.target.files?.[0];
                                  event.target.value = '';
                                  void updateFile(slot, file, true);
                                }}
                              />
                            </label>
                          )}
                          {asset && (
                            <button
                              type="button"
                              className="custom-asset-reset"
                              title="Restore the original file"
                              aria-label={`Restore the original ${shortName(slot.ref)}`}
                              onClick={() => resetSlot(slot.ref)}
                            >
                              <RotateCcw size={12} />
                            </button>
                          )}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
