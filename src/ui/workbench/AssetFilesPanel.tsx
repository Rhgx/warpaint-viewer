import { useEffect, useRef, useState } from 'react';
import {
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
import { Button, FileButton } from '../primitives/Button';
import { cn } from '../primitives/cn';
import { SearchField } from '../primitives/Input';
import { InlineNotice } from '../primitives/Notice';
import { PATH_TEXT, SECTION_TITLE } from '../primitives/textStyles';

const EMPTY = 'flex h-full items-center justify-center gap-2 text-11 text-dim';
const FILE_LINE = 'flex min-w-0 items-center gap-0.75 truncate';
const FILE_REMOVE = 'grid size-3.25 cursor-pointer place-items-center rounded-xs border-0 bg-transparent p-0 text-inherit focus-ring hover:bg-border hover:text-text';
const TEXTURE_ACCEPT = '.png,.jpg,.jpeg,.webp,.tga,.vtf';

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

/** Assigns a source only once the card nears the viewport, so large grids stay cheap; the image element stays for layout. */
function useNearViewport() {
  const elementRef = useRef<HTMLImageElement>(null);
  const [nearViewport, setNearViewport] = useState(() => !('IntersectionObserver' in window));

  useEffect(() => {
    const element = elementRef.current;
    if (!element || !('IntersectionObserver' in window)) return;
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
  const [resolved, setResolved] = useState<{
    refPath: string;
    fallbackUrl: string;
    resolvePackageTexture: (ref: string) => Promise<string>;
    packageGeneration: number;
    url: string;
  } | null>(null);
  const isCurrent = resolved !== null
    && resolved.refPath === refPath
    && resolved.fallbackUrl === fallbackUrl
    && resolved.resolvePackageTexture === resolvePackageTexture
    && resolved.packageGeneration === packageGeneration;
  const src = isCurrent ? resolved.url : fallbackUrl;
  useEffect(() => {
    if (!nearViewport) return;
    let cancelled = false;
    if (!refPath || !resolvePackageTexture) return;
    void resolvePackageTexture(refPath)
      .then((url) => {
        if (!cancelled) setResolved({ refPath, fallbackUrl, resolvePackageTexture, packageGeneration, url });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [nearViewport, refPath, fallbackUrl, resolvePackageTexture, packageGeneration]);
  return <img className="size-full object-contain" ref={elementRef} src={nearViewport ? src : undefined} loading="lazy" alt="" />;
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
  onUpdateFile: (ref: string, file: File | undefined, alphaOnly: boolean) => void;
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-10 flex-none items-center gap-2 border-b border-border px-3 py-1.75">
        <SearchField
          className="max-w-60 flex-auto [&_input]:text-11"
          value={filter}
          onChange={setFilter}
          placeholder="Filter inputs..."
          // SearchField clears on Escape. Marked handled, so that the same key does not also close the drawer.
          onKeyDown={(event) => {
            if (event.key === 'Escape' && filter) event.preventDefault();
          }}
        />
        <div className="ml-auto flex items-center gap-2 text-11 whitespace-nowrap text-dim">
          <span>
            {replacedCount
              ? `${replacedCount} replacement${replacedCount === 1 ? '' : 's'}`
              : `${slots.length} inputs`}
          </span>
          {replacedCount > 0 && (
            <Button variant="outline" size="compact" onClick={onExport}>
              <Download size={12} />
              Export
            </Button>
          )}
          {(replacedCount > 0 || sourceMounted) && (
            <Button
              variant={confirmReset ? 'armed' : 'outline'}
              size="compact"
              onClick={confirmReset ? onResetAll : onConfirmReset}
            >
              <RotateCcw size={12} />
              {confirmReset ? 'Discard all?' : 'Reset all'}
            </Button>
          )}
        </div>
      </div>
      <div className="scrollbar-slim min-h-0 flex-1 overflow-auto px-3 pt-2.5 pb-3">
        {loading ? (
          <div className={EMPTY}>
            <LoaderCircle className="animate-spin motion-reduce:animate-none" size={20} /> Reading recipe inputs...
          </div>
        ) : slots.length === 0 ? (
          <div className={EMPTY}>
            <FileImage size={22} /> Select a warpaint to use as the editable recipe template.
          </div>
        ) : groups.length === 0 ? (
          <div className={EMPTY}>
            <Search size={18} /> No inputs match “{filter}”.
          </div>
        ) : (
          groups.map(({ group, items }) => (
            <div className="not-first:mt-3" key={group}>
              <div className={cn('mb-1.5 flex items-center gap-1.5 after:h-px after:flex-1 after:bg-border', SECTION_TITLE)}>
                {GROUP_LABEL[group]}
                <span className="rounded-sm bg-panel-2 px-1 font-normal text-dim tabular-nums">{items.length}</span>
              </div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-2">
                {items.map((slot) => {
                  const specularRef = slot.specularRef;
                  const asset = assets[slot.ref];
                  const specularAsset = specularRef ? assets[specularRef] : undefined;
                  const specularOriginal = specularRef ? textureMetadata?.[specularRef] : undefined;
                  const specularInPackage = Boolean(specularRef && hasPackageTexture?.(specularRef));
                  const original = textureMetadata?.[slot.ref];
                  const showOriginal = comparing[slot.ref] && asset?.output;
                  const previewOutput = showOriginal ? undefined : asset?.output;
                  const mismatch =
                    asset?.size &&
                    original &&
                    (asset.size.width !== original.width ||
                      asset.size.height !== original.height);
                  return (
                    <article
                      className="relative grid min-w-0 grid-cols-[82px_minmax(0,1fr)] overflow-hidden rounded-sm border border-border bg-panel-2 transition-fast data-replaced:border-accent-edge"
                      data-slot="asset-card"
                      key={slot.ref}
                      data-replaced={asset || specularAsset ? '' : undefined}
                    >
                      <div className="relative min-h-29 texture-checkerboard">
                        <TexturePreview
                          refPath={previewOutput ?? slot.ref}
                          fallbackUrl={previewOutput ?? resolveTexture(slot.ref)}
                          resolvePackageTexture={resolvePackageTexture}
                          packageGeneration={packageGeneration}
                        />
                        <span className="absolute inset-x-1 bottom-1 truncate rounded-xs bg-black/70 px-1 py-0.5 text-center text-8 text-text">{KIND_LABEL[slot.kind]}</span>
                        {asset?.output && (
                          <button
                            type="button"
                            className="absolute top-1 right-1 grid size-5 cursor-pointer place-items-center rounded-sm border-0 bg-black/70 p-0 text-text focus-ring hover:text-white aria-pressed:bg-accent aria-pressed:text-accent-text"
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
                          <div className="absolute inset-0 grid place-items-center bg-black/50 text-text">
                            <LoaderCircle className="animate-spin motion-reduce:animate-none" size={18} />
                          </div>
                        )}
                      </div>
                      <div className="flex min-w-0 flex-col p-2">
                        <div className="flex items-center gap-1 text-11 font-[650] capitalize">
                          {slot.kind.startsWith('sticker') && <Sticker size={12} />}
                          <span className="truncate">{shortName(slot.ref)}</span>
                        </div>
                        <div className={cn('mt-0.5 truncate text-dim', PATH_TEXT)} title={slot.ref}>{slot.ref}</div>
                        <div className="mt-1.5 flex flex-col gap-0.5 text-11 text-dim">
                          {asset?.color ? (
                            <>
                              <span className={FILE_LINE} title={asset.color.fileName}>
                                {asset.color.fileName}
                                {asset.color.hasEmbeddedAlpha ? ' (embedded alpha)' : ''}
                              </span>
                              {asset.alpha && (
                                <span className={FILE_LINE} title={asset.alpha.fileName}>
                                  Alpha: {asset.alpha.fileName}
                                  <button
                                    type="button"
                                    className={FILE_REMOVE}
                                    title="Remove the alpha mask"
                                    aria-label="Remove the alpha mask"
                                    onClick={() => onRemoveAlpha(slot.ref)}
                                  >
                                    <X size={10} />
                                  </button>
                                </span>
                              )}
                              {asset.size && (
                                mismatch && original
                                  ? <InlineNotice>{asset.size.width} x {asset.size.height} (original {original.width} x {original.height})</InlineNotice>
                                  : <span>{asset.size.width} x {asset.size.height}</span>
                              )}
                            </>
                          ) : (
                            <span>
                              {original ? `Original ${original.width} x ${original.height}` : 'Original file'}
                            </span>
                          )}
                          {errors[slot.ref] && <InlineNotice tone="error" role="alert">{errors[slot.ref]}</InlineNotice>}
                          {specularRef && (
                            specularAsset?.color ? (
                              <span className={FILE_LINE} title={specularAsset.color.fileName}>
                                Specular: {specularAsset.color.fileName}
                                <button
                                  type="button"
                                  className={FILE_REMOVE}
                                  title="Remove the specular map"
                                  aria-label={`Remove the specular map for ${shortName(slot.ref)}`}
                                  onClick={() => onResetSlot(specularRef)}
                                >
                                  <X size={10} />
                                </button>
                              </span>
                            ) : specularInPackage ? (
                              <span className={FILE_LINE} title={specularRef}>
                                <Sparkles size={10} /> Specular detected in archive
                              </span>
                            ) : specularOriginal ? (
                              <span>
                                Specular: Original {specularOriginal.width} x {specularOriginal.height}
                              </span>
                            ) : (
                              <span>No specular map</span>
                            )
                          )}
                          {specularRef && errors[specularRef] && (
                            <InlineNotice tone="error" role="alert">{errors[specularRef]}</InlineNotice>
                          )}
                        </div>
                        {/* Pinned to the bottom of every card, so buttons align across the grid. */}
                        <div className="mt-auto flex items-center gap-1.25 pt-2.25">
                          <FileButton
                            variant="primary"
                            className="min-w-0 flex-1"
                            title="Import a PNG, JPG, WebP, TGA or VTF texture"
                            label={`Import a texture for ${shortName(slot.ref)}`}
                            accept={TEXTURE_ACCEPT}
                            onFiles={([file]) => onUpdateFile(slot.ref, file, false)}
                          >
                            <ImagePlus className="flex-none" size={13} />
                            <span className="truncate">{asset?.color ? 'Replace' : 'Texture'}</span>
                          </FileButton>
                          {!asset?.color?.hasEmbeddedAlpha && (
                            <FileButton
                              variant="outline"
                              className="min-w-0 flex-1"
                              title="Import a separate greyscale or transparent image to use as this texture's alpha channel"
                              label={`Import an alpha mask for ${shortName(slot.ref)}`}
                              accept=".png,.jpg,.jpeg,.webp"
                              onFiles={([file]) => onUpdateFile(slot.ref, file, true)}
                            >
                              <Layers className="flex-none" size={12} />
                              <span className="truncate">Alpha</span>
                            </FileButton>
                          )}
                          {specularRef && (
                            <FileButton
                              variant="outline"
                              className="min-w-0 flex-1"
                              title="Import this sticker's phong/specular mask"
                              label={`Import a specular map for ${shortName(slot.ref)}`}
                              accept={TEXTURE_ACCEPT}
                              onFiles={([file]) => onUpdateFile(specularRef, file, false)}
                            >
                              <Sparkles className="flex-none" size={12} />
                              <span className="truncate">{specularAsset?.color ? 'Replace spec' : 'Specular'}</span>
                            </FileButton>
                          )}
                          {asset && (
                            <Button variant="outline" size="icon" className="flex-none" title="Restore the original file" aria-label={`Restore the original ${shortName(slot.ref)}`} onClick={() => onResetSlot(slot.ref)}>
                              <RotateCcw size={12} />
                            </Button>
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
