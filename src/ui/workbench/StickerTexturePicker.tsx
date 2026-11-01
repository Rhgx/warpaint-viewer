import { X } from 'lucide-react';
import type { WorkbenchSticker } from './workbenchTypes';

export function StickerTexturePicker({
  sticker,
  purpose,
  search,
  showAll,
  onOpenChange,
  onSearchChange,
  onShowAllChange,
}: {
  sticker: WorkbenchSticker;
  purpose: 'sticker' | 'variant';
  search: string;
  showAll: boolean;
  onOpenChange: (open: boolean) => void;
  onSearchChange: (search: string) => void;
  onShowAllChange: (showAll: boolean) => void;
}) {
  return (
    <div
      className="custom-workbench-sticker-picker"
      data-purpose={purpose}
      role="dialog"
      aria-label={purpose === 'variant' ? 'Add variant' : 'Add sticker'}
    >
      <div className="custom-workbench-sticker-picker-head">
        <strong>{purpose === 'variant' ? 'Add variant' : 'Add sticker'}</strong>
        <button type="button" aria-label="Close sticker picker" onClick={() => onOpenChange(false)}>
          <X size={13} />
        </button>
      </div>
      <input
        type="search"
        value={search}
        placeholder="Find sticker texture..."
        aria-label="Find sticker texture"
        autoFocus
        onChange={(event) => onSearchChange(event.target.value)}
      />
      <div className="custom-workbench-sticker-picker-scope" role="group" aria-label="Sticker texture source">
        <button
          type="button"
          aria-pressed={!showAll}
          onClick={() => onShowAllChange(false)}
        >
          Current paint
        </button>
        <button
          type="button"
          aria-pressed={showAll}
          onClick={() => onShowAllChange(true)}
        >
          All available
        </button>
      </div>
      <div className="custom-workbench-sticker-picker-list" role="listbox" aria-label="Sticker textures">
        {(showAll ? sticker.allTextureChoices : sticker.textureChoices)
          .filter((choice) => `${choice.label} ${choice.ref}`.toLowerCase().includes(search.trim().toLowerCase()))
          .map((choice) => (
            <button
              type="button"
              key={choice.ref}
              role="option"
              aria-selected="false"
              title={choice.ref}
              onClick={() => {
                if (purpose === 'variant') sticker.onAddVariant?.(choice.ref);
                else sticker.onAddTarget(choice.ref);
                onOpenChange(false);
                onSearchChange('');
              }}
            >
              <span aria-hidden="true">
                {choice.thumbnail ? <img src={choice.thumbnail} alt="" loading="lazy" draggable={false} /> : null}
              </span>
              <strong>{choice.label}</strong>
              <small>{choice.ref}</small>
            </button>
          ))}
      </div>
    </div>
  );
}
