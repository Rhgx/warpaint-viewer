import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Download,
  Eye,
  EyeOff,
  FileImage,
  ImagePlus,
  Layers,
  LoaderCircle,
  RotateCcw,
  Search,
  Sparkles,
  Sticker,
  X,
} from 'lucide-react';
import type { TextureMetadata } from '../../data/types';
import type { AssetSlot, SlotGroup } from '../../workbench/assetSlots';
import type { WarpaintAssetState } from '../../workbench/types';
import { TextField } from '../common/controls';

const KIND_LABEL: Record<AssetSlot['kind'], string> = {
  texture: 'Texture',
  mask: 'Region mask',
  sticker: 'Sticker',
  'sticker-mask': 'Sticker specular',
};

const GROUP_LABEL: Record<SlotGroup, string> = {
  artwork: 'Artwork',
  mask: 'Masks',
  support: 'Support files',
};

function shortName(ref: string): string {
  const file = ref.split('/').pop() ?? ref;
  return file
    .replace(/\.[^.]+$/, '')
    .replace(/^p_/, '')
    .replace(/[_-]+/g, ' ');
}

/**
 * Asset grids can contain dozens of source textures. Keep the image element
 * in the card so the preview keeps its layout, but do not assign a source
 * until the card is close to the viewport. Native lazy loading remains as a
 * browser-level backstop once the source is assigned.
 */
function useNearViewport() {
  const elementRef = useRef<HTMLImageElement>(null);
  const [nearViewport, setNearViewport] = useState(false);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    if (!('IntersectionObserver' in window)) {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setNearViewport(true);
        observer.disconnect();
      },
      { rootMargin: '240px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { elementRef, nearViewport };
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
  const { elementRef, nearViewport } = useNearViewport();
  const [src, setSrc] = useState(fallbackUrl);
  useEffect(() => {
    if (!nearViewport) return;
    let cancelled = false;
    setSrc(fallbackUrl);
    if (!refPath || !resolvePackageTexture)
      return () => {
        cancelled = true;
      };
    void resolvePackageTexture(refPath)
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [nearViewport, refPath, fallbackUrl, resolvePackageTexture, packageGeneration]);
  return <img ref={elementRef} src={nearViewport ? src : undefined} loading="lazy" alt="" />;
}

export function AssetFilesPanel({
  slots,
  assets,
  errors,
  busy,
  loading,
  textureMetadata,
  resolveTexture,
  resolvePackageTexture,
  hasPackageTexture,
  packageGeneration,
  sourceMounted,
  confirmReset,
  onConfirmReset,
  onResetAll,
  onExport,
  onUpdateFile,
  onRemoveAlpha,
  onResetSlot,
}: {
  slots: AssetSlot[];
  assets: Record<string, WarpaintAssetState>;
  errors: Record<string, string>;
  busy: Record<string, boolean>;
  loading: boolean;
  textureMetadata?: Record<string, TextureMetadata>;
  resolveTexture: (ref: string) => string;
  resolvePackageTexture?: (ref: string) => Promise<string>;
  hasPackageTexture?: (ref: string) => boolean;
  packageGeneration: number;
  sourceMounted: boolean;
  confirmReset: boolean;
  onConfirmReset: () => void;
  onResetAll: () => void;
  onExport: () => void;
  onUpdateFile: (slot: AssetSlot, file: File | undefined, alphaOnly: boolean) => void;
  onRemoveAlpha: (ref: string) => void;
  onResetSlot: (ref: string) => void;
}) {
  const [filter, setFilter] = useState('');
  const [comparing, setComparing] = useState<Record<string, boolean>>({});
  const query = filter.trim().toLowerCase();
  const visible = slots.filter(
    (slot) =>
      !query ||
      shortName(slot.ref).toLowerCase().includes(query) ||
      slot.ref.toLowerCase().includes(query) ||
      Boolean(slot.specularRef?.toLowerCase().includes(query)),
  );
  const groups = (['artwork', 'mask', 'support'] as SlotGroup[])
    .map((group) => ({
      group,
      items: visible.filter((slot) => slot.group === group),
    }))
    .filter((entry) => entry.items.length > 0);
  const replacedCount = Object.keys(assets).length;

  return (
    <div className="custom-workbench-panel">
      <div className="custom-workbench-toolbar">
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
          <span>
            {replacedCount
              ? `${replacedCount} replacement${replacedCount === 1 ? '' : 's'}`
              : `${slots.length} inputs`}
          </span>
          {replacedCount > 0 && (
            <button type="button" className="custom-workbench-reset-all" onClick={onExport}>
              <Download size={12} />
              Export
            </button>
          )}
          {(replacedCount > 0 || sourceMounted) && (
            <button
              type="button"
              className="custom-workbench-reset-all"
              data-confirm={confirmReset ? '' : undefined}
              onClick={confirmReset ? onResetAll : onConfirmReset}
            >
              <RotateCcw size={12} />
              {confirmReset ? 'Discard all?' : 'Reset all'}
            </button>
          )}
        </div>
      </div>
      <div className="custom-workbench-body">
        {loading ? (
          <div className="custom-workbench-empty">
            <LoaderCircle className="custom-workbench-spinner" size={20} /> Reading recipe inputs...
          </div>
        ) : slots.length === 0 ? (
          <div className="custom-workbench-empty">
            <FileImage size={22} /> Select a warpaint to use as the editable recipe template.
          </div>
        ) : groups.length === 0 ? (
          <div className="custom-workbench-empty">
            <Search size={18} /> No inputs match “{filter}”.
          </div>
        ) : (
          groups.map(({ group, items }) => (
            <div className="custom-asset-group" key={group}>
              <div className="custom-asset-group-label">
                {GROUP_LABEL[group]}
                <span>{items.length}</span>
              </div>
              <div className="custom-asset-grid">
                {items.map((slot) => {
                  const specularRef = slot.specularRef;
                  const asset = assets[slot.ref];
                  const specularAsset = specularRef ? assets[specularRef] : undefined;
                  const specularOriginal = specularRef ? textureMetadata?.[specularRef] : undefined;
                  const specularInPackage = Boolean(specularRef && hasPackageTexture?.(specularRef));
                  const original = textureMetadata?.[slot.ref];
                  const showOriginal = comparing[slot.ref] && asset?.output;
                  const mismatch =
                    asset?.size &&
                    original &&
                    (asset.size.width !== original.width ||
                      asset.size.height !== original.height);
                  return (
                    <article className="custom-asset-card" key={slot.ref} data-replaced={asset || specularAsset ? '' : undefined}>
                      <div className="custom-asset-preview">
                        <TexturePreview
                          refPath={showOriginal ? slot.ref : (asset?.output ?? slot.ref)}
                          fallbackUrl={showOriginal ? resolveTexture(slot.ref) : (asset?.output ?? resolveTexture(slot.ref))}
                          resolvePackageTexture={resolvePackageTexture}
                          packageGeneration={packageGeneration}
                        />
                        <span className="custom-asset-kind">{KIND_LABEL[slot.kind]}</span>
                        {asset?.output && (
                          <button
                            type="button"
                            className="custom-asset-compare"
                            title={showOriginal ? 'Show imported file' : 'Show original file'}
                            aria-label={showOriginal ? 'Show imported file' : 'Show original file'}
                            aria-pressed={Boolean(showOriginal)}
                            onClick={() => setComparing((current) => ({
                              ...current,
                              [slot.ref]: !current[slot.ref],
                            }))}
                          >
                            {showOriginal ? <EyeOff size={12} /> : <Eye size={12} />}
                          </button>
                        )}
                        {(busy[slot.ref] || (specularRef && busy[specularRef])) && (
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
                                {asset.color.fileName}
                                {(asset.color.hasEmbeddedAlpha ?? asset.color.isTga) ? ' (embedded alpha)' : ''}
                              </span>
                              {asset.alpha && (
                                <span className="custom-asset-file" title={asset.alpha.fileName}>
                                  Alpha: {asset.alpha.fileName}
                                  <button
                                    type="button"
                                    className="custom-asset-file-remove"
                                    title="Remove the alpha mask"
                                    aria-label="Remove the alpha mask"
                                    onClick={() => onRemoveAlpha(slot.ref)}
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
                          {specularRef && (
                            specularAsset?.color ? (
                              <span className="custom-asset-file" title={specularAsset.color.fileName}>
                                Specular: {specularAsset.color.fileName}
                                <button
                                  type="button"
                                  className="custom-asset-file-remove"
                                  title="Remove the specular map"
                                  aria-label={`Remove the specular map for ${shortName(slot.ref)}`}
                                  onClick={() => onResetSlot(specularRef)}
                                >
                                  <X size={10} />
                                </button>
                              </span>
                            ) : specularInPackage ? (
                              <span className="custom-asset-file" title={specularRef}>
                                <Sparkles size={10} /> Specular detected in archive
                              </span>
                            ) : specularOriginal ? (
                              <span className="custom-asset-hint">
                                Specular: Original {specularOriginal.width} x {specularOriginal.height}
                              </span>
                            ) : (
                              <span className="custom-asset-hint">No specular map</span>
                            )
                          )}
                          {specularRef && errors[specularRef] && (
                            <span className="custom-asset-error" role="alert">{errors[specularRef]}</span>
                          )}
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
                                event.target.value = '';
                                onUpdateFile(slot, file, false);
                              }}
                            />
                          </label>
                          {!(asset?.color && (asset.color.hasEmbeddedAlpha ?? asset.color.isTga)) && (
                            <label className="custom-file-button custom-file-button-secondary" title="Import a separate greyscale or transparent image to use as this texture's alpha channel">
                              <Layers size={12} />
                              <span>Alpha</span>
                              <input
                                type="file"
                                accept=".png,.jpg,.jpeg,.webp"
                                aria-label={`Import an alpha mask for ${shortName(slot.ref)}`}
                                onChange={(event) => {
                                  const file = event.target.files?.[0];
                                  event.target.value = '';
                                  onUpdateFile(slot, file, true);
                                }}
                              />
                            </label>
                          )}
                          {specularRef && (
                            <label className="custom-file-button custom-file-button-secondary" title="Import this sticker's phong/specular mask">
                              <Sparkles size={12} />
                              <span>{specularAsset?.color ? 'Replace spec' : 'Specular'}</span>
                              <input
                                type="file"
                                accept=".png,.jpg,.jpeg,.webp,.tga,.vtf"
                                aria-label={`Import a specular map for ${shortName(slot.ref)}`}
                                onChange={(event) => {
                                  const file = event.target.files?.[0];
                                  event.target.value = '';
                                  onUpdateFile({ ref: specularRef, kind: 'sticker-mask', group: 'mask' }, file, false);
                                }}
                              />
                            </label>
                          )}
                          {asset && (
                            <button type="button" className="custom-asset-reset" title="Restore the original file" aria-label={`Restore the original ${shortName(slot.ref)}`} onClick={() => onResetSlot(slot.ref)}>
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
    </div>
  );
}
