import type { BootState } from '../../hooks/useBootData';

export function BootLoader({ boot }: { boot: BootState }) {
  return (
    <div className="fixed inset-0 z-1000 grid place-items-center bg-bg" data-slot="boot-loader" role="status" aria-live="polite">
      <div className="w-[min(420px,calc(100vw-48px))] rounded-lg border border-border bg-panel p-6 shadow-pop">
        <div className="mb-3.5 text-15 font-semibold tracking-[0.2px] text-text">Loading TF2 Warpaints</div>
        <div className="h-1.5 overflow-hidden rounded-sm border border-strong bg-panel-2" aria-label={boot.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={boot.progress} role="progressbar">
          <div className="h-full bg-accent [transition:width_180ms_ease-out]" style={{ width: `${boot.progress}%` }} />
        </div>
        <div className="mt-2 flex justify-between gap-5 text-11 text-dim tabular-nums">
          <span>{boot.label}</span>
          <span>{Math.round(boot.progress)}%</span>
        </div>
      </div>
    </div>
  );
}
