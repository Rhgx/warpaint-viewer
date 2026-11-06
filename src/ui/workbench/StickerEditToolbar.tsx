import { ArrowDown, ArrowUp, ImageUp, Plus, Trash2 } from 'lucide-react';
import { Button } from '../primitives/Button';
import { TEXTURE_FILE_ACCEPT } from './workbenchLabels';
import type { WorkbenchSticker } from './workbenchTypes';

export function StickerEditToolbar({
  sticker,
  stickerFileRef,
  addButtonRef,
  pickerOpen,
  pickerPurpose,
  onTogglePicker,
  onReplaceImage,
}: {
  sticker: WorkbenchSticker;
  stickerFileRef: { current: HTMLInputElement | null };
  addButtonRef: { current: HTMLButtonElement | null };
  pickerOpen: boolean;
  pickerPurpose: 'sticker' | 'variant';
  onTogglePicker: (purpose: 'sticker' | 'variant') => void;
  onReplaceImage: (file: File) => void;
}) {
  const active = sticker.targets.find((target) => target.id === sticker.activeTargetId);
  return (
    <div
      className="flex gap-0.75 border-t border-border px-2.5 py-1.5 [grid-area:tools] @max-[900px]:justify-self-start @max-[900px]:border-t-0 @max-[900px]:pr-0"
      role="toolbar"
      aria-label="Sticker actions"
    >
      <Button
        ref={addButtonRef}
        size="icon"
        className="aria-expanded:border-accent aria-expanded:bg-accent aria-expanded:text-accent-text"
        title="Add sticker"
        aria-label="Add sticker"
        aria-expanded={pickerOpen && pickerPurpose === 'sticker'}
        onClick={() => onTogglePicker('sticker')}
      >
        <Plus size={13} />
      </Button>
      <Button variant="danger" size="icon" title="Remove sticker" aria-label="Remove sticker" onClick={sticker.onRemoveTarget}>
        <Trash2 size={13} />
      </Button>
      {sticker.onSetTargetTexture && (
        <Button
          size="icon"
          title={(active?.sharedWith ?? 0) > 0
            ? `Replace this sticker's image. The other ${active?.sharedWith} sticker${active?.sharedWith === 1 ? '' : 's'} using it keep theirs.`
            : "Replace this sticker's image"}
          aria-label="Replace this sticker's image"
          disabled={!active?.baseReference}
          onClick={() => stickerFileRef.current?.click()}
        >
          <ImageUp size={13} />
        </Button>
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
      <span className="flex-1" />
      <Button size="icon" title="Move sticker earlier" aria-label="Move sticker earlier" disabled={!active?.canMoveEarlier} onClick={() => sticker.onMoveTarget(-1)}>
        <ArrowUp size={13} />
      </Button>
      <Button size="icon" title="Move sticker later" aria-label="Move sticker later" disabled={!active?.canMoveLater} onClick={() => sticker.onMoveTarget(1)}>
        <ArrowDown size={13} />
      </Button>
    </div>
  );
}
