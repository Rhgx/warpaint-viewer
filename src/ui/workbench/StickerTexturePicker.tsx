import { Popover } from '@base-ui/react/popover';
import { X } from 'lucide-react';
import { useRef } from 'react';

import { EDITOR_TITLE } from '../editor/editorStyles';
import { Button } from '../primitives/Button';
import { cn } from '../primitives/cn';
import { COMPACT_INPUTS, SearchField } from '../primitives/Input';
import { PATH_TEXT } from '../primitives/textStyles';
import { ToggleGroup } from '../primitives/ToggleGroup';
import type { WorkbenchSticker } from './workbenchTypes';

export function StickerTexturePicker({
  sticker,
  purpose,
  anchorRef,
  search,
  showAll,
  onOpenChange,
  onSearchChange,
  onShowAllChange,
}: {
  sticker: WorkbenchSticker;
  purpose: 'sticker' | 'variant';
  /** What it opens beside. A variant's anchor can leave the page with its tab, and the picker then hides. */
  anchorRef: { current: HTMLElement | null };
  search: string;
  showAll: boolean;
  onOpenChange: (open: boolean) => void;
  onSearchChange: (search: string) => void;
  onShowAllChange: (showAll: boolean) => void;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    // Stays open while the sticker is edited behind it, so a press outside or a move of focus does not close it. Escape does.
    <Popover.Root
      open
      modal={false}
      onOpenChange={(open, details) => {
        if (!open && details.reason === 'escape-key') onOpenChange(false);
      }}
    >
      <Popover.Portal>
        <Popover.Positioner
          className="z-1100 data-anchor-hidden:hidden"
          anchor={anchorRef}
          side={purpose === 'variant' ? 'right' : 'top'}
          align="start"
          sideOffset={6}
          collisionPadding={8}
        >
          <Popover.Popup
            ref={popupRef}
            className={cn('flex h-[min(290px,var(--available-height))] w-105 max-w-(--available-width) min-w-0 flex-col rounded-sm border border-strong bg-panel text-text shadow-pop outline-none', COMPACT_INPUTS)}
            data-slot="sticker-picker"
            aria-label={purpose === 'variant' ? 'Add Variant' : 'Add Sticker'}
            initialFocus={() => popupRef.current?.querySelector('input') ?? true}
          >
            <div className="flex min-h-8.5 flex-none items-center justify-between gap-2 border-b border-border pr-2 pl-2.5">
              <strong className={EDITOR_TITLE}>{purpose === 'variant' ? 'Add Variant' : 'Add Sticker'}</strong>
              <Button variant="ghost" size="icon-sm" aria-label="Close sticker picker" onClick={() => onOpenChange(false)}>
                <X size={13} />
              </Button>
            </div>
            <div className="flex flex-none flex-col gap-1.75 p-1.75">
              <SearchField
                value={search}
                placeholder="Filter sticker textures..."
                label="Filter sticker textures"
                onChange={onSearchChange}
              />
              <ToggleGroup<'current' | 'all'>
                size="tool"
                label="Sticker texture source"
                value={showAll ? 'all' : 'current'}
                options={[
                  { value: 'current', label: 'Current Paint' },
                  { value: 'all', label: 'All Available' },
                ]}
                onChange={(value) => onShowAllChange(value === 'all')}
              />
            </div>
            <div className="scrollbar-slim grid min-h-0 flex-1 grid-cols-2 content-start gap-0.5 overflow-auto px-1.25 pb-1.5 max-[620px]:grid-cols-1" role="listbox" aria-label="Sticker textures">
              {(showAll ? sticker.allTextureChoices : sticker.textureChoices)
                .filter((choice) => `${choice.label} ${choice.ref}`.toLowerCase().includes(search.trim().toLowerCase()))
                .map((choice) => (
                  <button
                    type="button"
                    className="grid w-full min-w-0 cursor-pointer grid-cols-[30px_minmax(0,1fr)] grid-rows-[auto_auto] items-center gap-x-1.75 gap-y-px rounded-sm border-0 bg-transparent p-1.25 text-left text-text transition-fast focus-ring hover:bg-panel-2 focus-visible:-outline-offset-2"
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
                    <span className="checker-cells row-span-2 block size-7.5 overflow-hidden rounded-sm border border-border bg-checker [--checker-size:8px]" aria-hidden="true">
                      {choice.thumbnail ? <img className="size-full object-contain" src={choice.thumbnail} alt="" loading="lazy" draggable={false} /> : null}
                    </span>
                    <strong className="truncate text-10.5 font-medium">{choice.label}</strong>
                    <small className={cn('truncate text-dim', PATH_TEXT)}>{choice.ref.replace(/^patterns\/(workshop\/)?/, '')}</small>
                  </button>
                ))}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
