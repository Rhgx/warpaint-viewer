import { ImageUp, Plus, Trash2 } from 'lucide-react';
import { referenceLabel, TEXTURE_FILE_ACCEPT } from './workbenchLabels';
import { StickerVariantWeightInput } from './StickerVariantWeightInput';
import type { WorkbenchSticker, WorkbenchStickerVariant } from './workbenchTypes';

export function StickerVariantList({
  sticker,
  variants,
  variantFileRef,
  variantReplaceIndexRef,
  pickerOpen,
  pickerPurpose,
  onTogglePicker,
  onReplaceVariantImage,
}: {
  sticker: WorkbenchSticker;
  variants: readonly WorkbenchStickerVariant[];
  variantFileRef: { current: HTMLInputElement | null };
  variantReplaceIndexRef: { current: number | null };
  pickerOpen: boolean;
  pickerPurpose: 'sticker' | 'variant';
  onTogglePicker: (purpose: 'sticker' | 'variant') => void;
  onReplaceVariantImage: (index: number, file: File) => void;
}) {
  const total = variants.reduce((sum, variant) => sum + variant.weight, 0);
  const weightsEqual = variants.every((variant) => variant.weight === variants[0]?.weight);
  return (
    <div className="sticker-placement-editor-variants" role="listbox" aria-label="Sticker variants">
      {variants.map((variant) => {
        const label = variant.baseReference ? referenceLabel(variant.baseReference) : 'No texture';
        const percent = total > 0 ? Math.round((variant.weight / total) * 100) : 0;
        const onlyVariant = variants.length <= 1;
        const togglePreview = () => sticker.onPreviewVariant?.(variant.index);
        return (
          <div
            key={`${variant.index}:${variant.baseReference ?? ''}`}
            className="sticker-placement-editor-variant"
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
            <span className="custom-workbench-edit-sticker-thumb" aria-hidden="true">
              {variant.thumbnail ? <img src={variant.thumbnail} alt="" draggable={false} /> : null}
            </span>
            <span className="sticker-placement-editor-variant-name" title={variant.baseReference}>{label}</span>
            <button
              type="button"
              className="sticker-placement-editor-variant-remove"
              title={onlyVariant ? 'A sticker needs at least one variant.' : 'Remove variant'}
              aria-label="Remove variant"
              disabled={onlyVariant}
              onClick={() => sticker.onRemoveVariant?.(variant.index)}
            >
              <Trash2 size={12} />
            </button>
            <button
              type="button"
              className="sticker-placement-editor-variant-replace"
              title="Replace this variant's image"
              aria-label="Replace this variant's image"
              disabled={!variant.baseReference}
              onClick={() => {
                variantReplaceIndexRef.current = variant.index;
                variantFileRef.current?.click();
              }}
            >
              <ImageUp size={12} />
            </button>
            <span
              className="sticker-placement-editor-variant-chance"
              title={`Weight ${variant.weight} of ${total} total`}
            >
              {variant.previewing
                ? <span title="Shown in the sticker editor">Previewing · </span>
                : variant.picked && <span title="Drawn for the current seed">Picked · </span>}
              {percent}%
            </span>
            <StickerVariantWeightInput
              label={`Relative weight of ${label}`}
              weight={variant.weight}
              onCommit={(weight) => sticker.onSetVariantWeight?.(variant.index, weight)}
            />
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
      <div className="sticker-placement-editor-corner-actions">
        <button
          type="button"
          aria-expanded={pickerOpen && pickerPurpose === 'variant'}
          onClick={() => onTogglePicker('variant')}
        >
          <Plus size={13} aria-hidden="true" />
          Add variant
        </button>
        <button
          type="button"
          title={weightsEqual ? 'Every variant already has the same weight.' : 'Give every variant the same weight'}
          disabled={weightsEqual}
          onClick={() => sticker.onEqualizeVariantWeights?.()}
        >
          Equal weights
        </button>
      </div>
    </div>
  );
}
