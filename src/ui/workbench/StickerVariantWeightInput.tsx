import { useState } from 'react';

/** Commits on blur or Enter, so typing a weight is one history entry rather than one per keystroke. */
export function StickerVariantWeightInput({
  label,
  weight,
  onCommit,
}: {
  label: string;
  weight: number;
  onCommit: (weight: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="number"
      className="sticker-placement-editor-variant-weight"
      aria-label={label}
      title={label}
      min={0}
      step={0.1}
      value={draft ?? String(weight)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft === null) return;
        setDraft(null);
        const parsed = draft.trim() === '' ? Number.NaN : Number(draft);
        if (Number.isFinite(parsed) && parsed >= 0 && parsed !== weight) onCommit(parsed);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}
