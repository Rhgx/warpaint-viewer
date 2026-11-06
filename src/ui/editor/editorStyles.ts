// The parts, transform and materials views share one header, so that switching between them moves nothing.
export const EDITOR_HEAD = 'flex min-h-control flex-none flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border px-3 py-1.5';
export const EDITOR_TITLE = 'min-w-0 truncate text-11.5 font-[650] text-text';
export const EDITOR_NOTE = 'text-10.5 font-medium whitespace-nowrap text-dim';
export const EDITOR_BUTTON = 'gap-1.25 text-10.5 font-semibold whitespace-nowrap';
export const EDITOR_CHECKBOX = 'm-0 size-3.5 flex-none accent-accent focus-ring';
export const EDITOR_CHECK_LABEL = 'inline-flex min-h-control cursor-pointer items-center gap-1.25 text-10.5 text-dim has-checked:text-text has-disabled:cursor-default has-disabled:opacity-45';
// Right-aligned figures and native spinners fight for the same few pixels.
export const EDITOR_NUMBER = 'text-right tabular-nums [appearance:textfield] disabled:cursor-default disabled:opacity-45 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none';
// Checker backing, so that light, dark and mid-grey sticker art stay equally legible.
export const STICKER_THUMB = 'checker-cells block size-6.5 flex-none overflow-hidden rounded-sm border border-border bg-checker [--checker-size:8px] @max-[900px]:size-6 [&>img]:block [&>img]:size-full [&>img]:object-contain';
