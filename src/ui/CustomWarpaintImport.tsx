import { useMemo, useRef, useState } from 'react';
import { FileImage, ImagePlus, LoaderCircle, Sticker, X } from 'lucide-react';
import type { RecipeNode } from '../compositor/types';
import './CustomWarpaintImport.css';

export interface WarpaintAssetOverrides {
  revision: number;
  assets: Record<string, WarpaintAssetState>;
}

interface AssetSlot {
  ref: string;
  kind: 'texture' | 'mask' | 'sticker' | 'sticker-mask';
}

export interface WarpaintAssetState {
  color?: { dataUrl: string; fileName: string; isTga: boolean };
  alpha?: { dataUrl: string; fileName: string };
  output?: string;
}

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'tga'];

function collectSlots(node: RecipeNode | null): AssetSlot[] {
  if (!node) return [];
  const slots = new Map<string, AssetSlot>();
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
  visit(node);
  const priority = (slot: AssetSlot) => {
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
  return [...slots.values()].sort((a, b) => priority(a) - priority(b));
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

async function decodeTga(file: File): Promise<string> {
  const { TGALoader } = await import('three/addons/loaders/TGALoader.js');
  const parsed = new TGALoader().parse(await file.arrayBuffer());
  if (!parsed.data || !parsed.width || !parsed.height) throw new Error('This TGA has no readable pixel data.');
  const bytes = Uint8ClampedArray.from(parsed.data as ArrayLike<number>);
  const canvas = document.createElement('canvas');
  canvas.width = parsed.width;
  canvas.height = parsed.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The browser could not decode this TGA.');
  context.putImageData(new ImageData(bytes, parsed.width, parsed.height), 0, 0);
  return canvas.toDataURL('image/png');
}

async function readTexture(file: File, alphaOnly = false) {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!SUPPORTED_EXTENSIONS.includes(extension) || (alphaOnly && extension === 'tga')) {
    throw new Error(alphaOnly ? 'Choose a PNG, JPG, or WebP alpha mask.' : 'Choose a PNG, JPG, WebP, or TGA texture.');
  }
  if (file.size > MAX_FILE_BYTES) throw new Error('Files must be 32 MB or smaller.');
  return {
    dataUrl: extension === 'tga' ? await decodeTga(file) : await readAsDataUrl(file),
    fileName: file.name,
    isTga: extension === 'tga',
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

export function CustomWarpaintWorkbench({
  recipe,
  resolveTexture,
  loading,
  initialOverrides,
  onChange,
  onClose,
}: {
  recipe: RecipeNode | null;
  resolveTexture: (ref: string) => string;
  loading: boolean;
  initialOverrides: WarpaintAssetOverrides;
  onChange: (overrides: WarpaintAssetOverrides) => void;
  onClose: () => void;
}) {
  const slots = useMemo(() => collectSlots(recipe), [recipe]);
  const [assets, setAssets] = useState<Record<string, WarpaintAssetState>>(initialOverrides.assets);
  const [error, setError] = useState('');
  const revisionRef = useRef(initialOverrides.revision);

  const publish = (next: Record<string, WarpaintAssetState>) => {
    revisionRef.current += 1;
    onChange({
      revision: revisionRef.current,
      assets: next,
    });
  };

  const updateFile = async (slot: AssetSlot, file: File | undefined, alphaOnly: boolean) => {
    if (!file) return;
    setError('');
    try {
      const read = await readTexture(file, alphaOnly);
      const current = assets[slot.ref] ?? {};
      const nextAsset: WarpaintAssetState = alphaOnly
        ? { ...current, alpha: { dataUrl: read.dataUrl, fileName: read.fileName } }
        : { ...current, color: read, alpha: read.isTga ? undefined : current.alpha };
      nextAsset.output = nextAsset.color
        ? nextAsset.alpha
          ? await mergeAlpha(nextAsset.color.dataUrl, nextAsset.alpha.dataUrl)
          : nextAsset.color.dataUrl
        : undefined;
      const next = { ...assets, [slot.ref]: nextAsset };
      setAssets(next);
      publish(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The file could not be imported.');
    }
  };

  const resetSlot = (ref: string) => {
    const next = { ...assets };
    delete next[ref];
    setAssets(next);
    publish(next);
  };

  return (
    <section className="custom-workbench" aria-label="Custom warpaint files">
      <header className="custom-workbench-header">
        <div className="custom-workbench-summary">
          <span>{slots.length} inputs</span>
          <span>{Object.keys(assets).length} replaced</span>
          <button type="button" aria-label="Close custom warpaint files" onClick={onClose}><X size={16} /></button>
        </div>
      </header>

      {error && <div className="custom-workbench-error" role="alert">{error}</div>}
      <div className="custom-workbench-body">
        {loading ? (
          <div className="custom-workbench-empty"><LoaderCircle className="custom-workbench-spinner" size={20} /> Reading recipe inputs...</div>
        ) : !recipe ? (
          <div className="custom-workbench-empty"><FileImage size={22} /> Select a warpaint to use as the editable recipe template.</div>
        ) : (
          <div className="custom-asset-grid">
            {slots.map((slot) => {
              const asset = assets[slot.ref];
              return (
                <article className="custom-asset-card" key={slot.ref}>
                  <div className="custom-asset-preview">
                    <img src={asset?.output ?? resolveTexture(slot.ref)} alt="" />
                    <span>{KIND_LABEL[slot.kind]}</span>
                  </div>
                  <div className="custom-asset-info">
                    <div className="custom-asset-name">{slot.kind.startsWith('sticker') && <Sticker size={12} />}{shortName(slot.ref)}</div>
                    <div className="custom-asset-path" title={slot.ref}>{slot.ref}</div>
                    <div className="custom-asset-actions">
                      <label className="custom-file-button">
                        <ImagePlus size={13} /> {asset?.color ? 'Replace' : 'Texture'}
                        <input type="file" accept=".png,.jpg,.jpeg,.webp,.tga" onChange={(event) => void updateFile(slot, event.target.files?.[0], false)} />
                      </label>
                      {!asset?.color?.isTga && (
                        <label className="custom-file-button custom-file-button-secondary">
                          Alpha
                          <input type="file" accept=".png,.jpg,.jpeg,.webp" onChange={(event) => void updateFile(slot, event.target.files?.[0], true)} />
                        </label>
                      )}
                      {asset && <button type="button" className="custom-asset-reset" onClick={() => resetSlot(slot.ref)}>Reset</button>}
                    </div>
                    {asset?.color && (
                      <div className="custom-asset-files">
                        <span>{asset.color.fileName}{asset.color.isTga ? ' (embedded alpha)' : ''}</span>
                        {asset.alpha && <span>Alpha: {asset.alpha.fileName}</span>}
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
