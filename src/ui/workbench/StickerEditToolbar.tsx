import { ArrowDown, ArrowUp, ImageUp, Plus, Trash2 } from 'lucide-react';
import { TEXTURE_FILE_ACCEPT } from './workbenchLabels';
import type { WorkbenchSticker } from './workbenchTypes';

export function StickerEditToolbar({
  sticker,
  stickerFileRef,
  pickerOpen,
  pickerPurpose,
  onTogglePicker,
  onReplaceImage,
}: {
  sticker: WorkbenchSticker;
  stickerFileRef: { current: HTMLInputElement | null };
  pickerOpen: boolean;
  pickerPurpose: 'sticker' | 'variant';
  onTogglePicker: (purpose: 'sticker' | 'variant') => void;
  onReplaceImage: (file: File) => void;
}) {
  const active = sticker.targets.find((target) => target.id === sticker.activeTargetId);
  return (
    <div className="custom-workbench-edit-sticker-actions" role="toolbar" aria-label="Sticker actions">
      <button
        type="button"
        title="Add sticker"
        aria-label="Add sticker"
        aria-expanded={pickerOpen && pickerPurpose === 'sticker'}
        onClick={() => onTogglePicker('sticker')}
      >
        <Plus size={13} />
      </button>
      <button type="button" title="Remove sticker" aria-label="Remove sticker" onClick={sticker.onRemoveTarget}>
        <Trash2 size={13} />
      </button>
      {sticker.onSetTargetTexture && (
        <button
          type="button"
          title={(active?.sharedWith ?? 0) > 0
            ? `Replace this sticker's image. The other ${active?.sharedWith} sticker${active?.sharedWith === 1 ? '' : 's'} using it keep theirs.`
            : "Replace this sticker's image"}
          aria-label="Replace this sticker's image"
          disabled={!active?.baseReference}
          onClick={() => stickerFileRef.current?.click()}
        >
          <ImageUp size={13} />
        </button>
      )}
      <input
        ref={stickerFileRef}
        type="file"
        accept={TEXTURE_FILE_ACCEPT}
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) onReplaceImage(file);
        }}
      />
      <span />
      <button type="button" title="Move sticker earlier" aria-label="Move sticker earlier" disabled={!active?.canMoveEarlier} onClick={() => sticker.onMoveTarget(-1)}>
        <ArrowUp size={13} />
      </button>
      <button type="button" title="Move sticker later" aria-label="Move sticker later" disabled={!active?.canMoveLater} onClick={() => sticker.onMoveTarget(1)}>
        <ArrowDown size={13} />
      </button>
    </div>
  );
}
