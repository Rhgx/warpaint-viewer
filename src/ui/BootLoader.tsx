export interface BootState {
  progress: number;
  label: string;
}

export function BootLoader({ boot }: { boot: BootState }) {
  return (
    <div className="boot-loader" role="status" aria-live="polite">
      <div className="boot-loader-card">
        <div className="boot-loader-title">Loading TF2 Warpaints</div>
        <div className="boot-loader-track" aria-label={boot.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={boot.progress} role="progressbar">
          <div className="boot-loader-fill" style={{ width: `${boot.progress}%` }} />
        </div>
        <div className="boot-loader-meta">
          <span>{boot.label}</span>
          <span>{Math.round(boot.progress)}%</span>
        </div>
      </div>
    </div>
  );
}
