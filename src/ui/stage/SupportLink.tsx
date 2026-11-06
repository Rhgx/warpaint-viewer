// Quiet support link in the bottom-right corner. It lives in the page, not the canvas, so captures exclude it.
// Mobile: shrinks to its mark, finger-sized and lifted above a two-line hint.
export function SupportLink() {
  return (
    <a
      className="absolute right-3 bottom-3 z-2 inline-flex items-center gap-1.25 rounded-xs text-11 tracking-[0.2px] text-on-canvas/55 underline decoration-on-canvas/30 underline-offset-2 transition-fast focus-ring hover:text-on-canvas/92 hover:decoration-current focus-visible:text-on-canvas/92 focus-visible:decoration-current mobile:right-[env(safe-area-inset-right)] mobile:bottom-13 mobile:min-h-10 mobile:min-w-10 mobile:justify-center"
      href="https://boosty.to/rhgx/donate"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Support me on Boosty"
    >
      {/* Boosty mark (Simple Icons), drawn in the text colour. */}
      <svg className="size-3 flex-none fill-current mobile:size-4" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M2.661 14.337 6.801 0h6.362L11.88 4.444l-.038.077-3.378 11.733h3.15c-1.321 3.289-2.35 5.867-3.086 7.733-5.816-.063-7.442-4.228-6.02-9.155M8.554 24l7.67-11.035h-3.25l2.83-7.073c4.852.508 7.137 4.33 5.791 8.952C20.16 19.81 14.344 24 8.68 24h-.127z" />
      </svg>
      <span className="mobile:hidden">Support me on Boosty</span>
    </a>
  );
}
