import { ImageUp, Plus, Trash2 } from 'lucide-react';
import { EDITOR_BUTTON, STICKER_THUMB } from '../editor/editorStyles';
import { Button } from '../primitives/Button';
import { cn } from '../primitives/cn';
import { referenceLabel, TEXTURE_FILE_ACCEPT } from './workbenchLabels';
import { StickerVariantWeightInput } from './StickerVariantWeightInput';
import type { WorkbenchSticker, WorkbenchStickerVariant } from './workbenchTypes';

export function StickerVariantList({
  sticker,
  variants,
  variantFileRef,
  variantReplaceIndexRef,
  actionsRef,
  pickerOpen,
  pickerPurpose,
  onTogglePicker,
  onReplaceVariantImage,
}: {
  sticker: WorkbenchSticker;
  variants: readonly WorkbenchStickerVariant[];
  variantFileRef: { current: HTMLInputElement | null };
  variantReplaceIndexRef: { current: number | null };
  actionsRef: { current: HTMLDivElement | null };
  pickerOpen: boolean;
  pickerPurpose: 'sticker' | 'variant';
  onTogglePicker: (purpose: 'sticker' | 'variant') => void;
  onReplaceVariantImage: (index: number, file: File) => void;
}) {
  const total = variants.reduce((sum, variant) => sum + variant.weight, 0);
  const weightsEqual = variants.every((variant) => variant.weight === variants[0]?.weight);
  return (
    <div className="grid content-start gap-0.5" data-slot="sticker-variants" role="listbox" aria-label="Sticker variants">
      {variants.map((variant) => {
        const label = variant.baseReference ? referenceLabel(variant.baseReference) : 'No texture';
        const percent = total > 0 ? Math.round((variant.weight / total) * 100) : 0;
        const onlyVariant = variants.length <= 1;
        const togglePreview = () => sticker.onPreviewVariant?.(variant.index);
        return (
          <div
            key={`${variant.index}:${variant.baseReference ?? ''}`}
            className="grid grid-cols-[26px_minmax(0,1fr)_52px_var(--spacing-control)_var(--spacing-control)] grid-rows-[auto_auto] items-center gap-x-1 gap-y-0.5 rounded-sm py-0.75 transition-fast outline-accent not-aria-selected:hover:bg-panel-2 focus-visible:outline-2 focus-visible:-outline-offset-2 aria-selected:bg-accent-soft aria-selected:shadow-[inset_2px_0_0_var(--color-accent)] @max-[900px]:aria-selected:shadow-[inset_0_-2px_0_var(--color-accent)]"
            role="option"
            tabIndex={0}
            aria-selected={variant.previewing}
            title="Preview this variant in the sticker editor"
            onClick={(event) => {
              // Controls inside the row keep their own clicks.
              if (event.target instanceof Element && event.target.closest('button, input')) return;
              togglePreview();
            }}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
              event.preventDefault();
              togglePreview();
            }}
          >
            <span className={cn(STICKER_THUMB, 'row-span-2')} aria-hidden="true">
              {variant.thumbnail ? <img src={variant.thumbnail} alt="" draggable={false} /> : null}
            </span>
            <span className="col-span-4 flex min-w-0 items-baseline justify-between gap-1.5">
              <span className="min-w-0 truncate text-11 font-semibold text-text" title={variant.baseReference}>{label}</span>
              {variant.previewing
                ? <span className="flex-none text-10 font-[650] text-accent" title="Shown in the sticker editor">Previewing</span>
                : variant.picked && <span className="flex-none text-10 font-[650] text-accent" title="Drawn for the current seed">Picked</span>}
            </span>
            <Button
              size="icon"
              className="col-start-4 row-start-2"
              title="Replace this variant's image"
              aria-label="Replace this variant's image"
              disabled={!variant.baseReference}
              onClick={() => {
                variantReplaceIndexRef.current = variant.index;
                variantFileRef.current?.click();
              }}
            >
              <ImageUp size={12} />
            </Button>
            <span
              className="col-start-2 row-start-2 min-w-0 truncate text-10 text-dim tabular-nums"
              title={`Weight ${variant.weight} of ${total} total`}
            >
              {percent}%
            </span>
            <StickerVariantWeightInput
              label={`Relative weight of ${label}`}
              weight={variant.weight}
              onCommit={(weight) => sticker.onSetVariantWeight?.(variant.index, weight)}
            />
            <Button
              variant="danger"
              size="icon"
              className="col-start-5 row-start-2"
              title={onlyVariant ? 'A sticker needs at least one variant.' : 'Remove variant'}
              aria-label="Remove variant"
              disabled={onlyVariant}
              onClick={() => sticker.onRemoveVariant?.(variant.index)}
            >
              <Trash2 size={12} />
            </Button>
          </div>
        );
      })}
      <input
        ref={variantFileRef}
        type="file"
        accept={TEXTURE_FILE_ACCEPT}
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          const index = variantReplaceIndexRef.current;
          event.currentTarget.value = '';
          if (file && index !== null) onReplaceVariantImage(index, file);
        }}
      />
      {/* Add Variant and Equal Weights share one row, so each gets half the inspector. The picker opens beside this row, so that it clears the list. */}
      <div ref={actionsRef} className="mt-1 grid grid-cols-2 gap-1.25 border-t border-border pt-2">
        <Button
          size="compact"
          className={cn(EDITOR_BUTTON, 'w-full px-1.5 aria-expanded:border-accent aria-expanded:bg-accent aria-expanded:text-accent-text')}
          aria-expanded={pickerOpen && pickerPurpose === 'variant'}
          onClick={() => onTogglePicker('variant')}
        >
          <Plus size={13} aria-hidden="true" />
          Add Variant
        </Button>
        <Button
          size="compact"
          className={cn(EDITOR_BUTTON, 'w-full px-1.5')}
          title={weightsEqual ? 'Every variant already has the same weight.' : 'Give every variant the same weight'}
          disabled={weightsEqual}
          onClick={() => sticker.onEqualizeVariantWeights?.()}
        >
          Equal Weights
        </Button>
      </div>
    </div>
  );
}
