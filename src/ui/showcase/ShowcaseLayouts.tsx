import { memo, useState } from 'react';
import { X } from 'lucide-react';

import { IconSelectField, type IconOption } from '../common/controls';
import type { ShowcaseBoard } from '../../showcase/ShowcaseBoard';
import { TEAM_PAIR_LIMIT, type BoardLayout, type LayoutRows } from '../../showcase/layouts';
import { Section, SliderRow } from './ShowcaseControls';
import { useBusy } from './useBusy';

// Ready-made board layouts, and the pickers for the weapons they feature.

/** Ready-made arrangements of the current paint, each drawn as a small sketch. */
export const LayoutsSection = memo(function LayoutsSection({ board, layouts, featureOptions, onFeature }: {
  board: ShowcaseBoard;
  layouts: readonly BoardLayout[];
  featureOptions: IconOption[];
  /** Feature other weapons; returns the layout `layoutId` becomes with them. */
  onFeature: (pick: FeaturePick, layoutId: string) => BoardLayout | undefined;
}) {
  const [busy, run] = useBusy();
  // The weapon picker belongs to the wears and the RED and BLU pair, so it shows once one is applied.
  const [appliedId, setAppliedId] = useState<string | null>(null);
  const applied = appliedId && FEATURE_LAYOUTS.has(appliedId) ? layouts.find((layout) => layout.id === appliedId) : undefined;
  const featured = applied?.rows[0]?.[0]?.weaponKey;
  const reapply = (pick: FeaturePick) => {
    const layout = applied && onFeature(pick, applied.id);
    if (layout) void apply(layout)();
  };
  const apply = (layout: BoardLayout) => run(async () => {
    setAppliedId(layout.id);
    await board.applyLayout(layout.rows, layout.pack, layout.inward, layout.upright);
  });
  return (
    <Section title="Layouts">
      <div className="showcase-layouts">
        {layouts.map((layout) => (
          <button key={layout.id} type="button" className="showcase-layout" disabled={busy}
            title={`${layout.label}: replaces the board (Ctrl+Z brings it back)`}
            onPointerEnter={() => board.preload(layout.rows)} onFocus={() => board.preload(layout.rows)}
            onClick={apply(layout)}>
            <LayoutSketch rows={layout.rows} />
            <span>{layout.label}</span>
          </button>
        ))}
      </div>
      {applied?.id === 'wears' && featured && featureOptions.length > 1 && (
        <SliderRow label="Weapon for Wears" value={null}>
          <IconSelectField value={featured} options={featureOptions} ariaLabel="Weapon for Wears" searchPlaceholder="Filter weapons..."
            onChange={(weapon) => reapply({ weapon })} />
        </SliderRow>
      )}
      {applied?.id === 'teams' && featureOptions.length > 1 && (
        <PairPicker picked={applied.rows.map((row) => row[0].weaponKey)} options={featureOptions} onChange={(pairs) => reapply({ pairs })} />
      )}
    </Section>
  );
});

const FEATURE_LAYOUTS = new Set(['wears', 'teams']);

/** A new weapon for the wears, or the weapons RED and BLU pair up. */
export type FeaturePick = { weapon?: string; pairs?: readonly string[] };

/** Up to three weapons for RED and BLU, each shown as a pair. */
function PairPicker({ picked, options, onChange }: {
  picked: readonly string[];
  options: IconOption[];
  onChange: (pairs: readonly string[]) => void;
}) {
  const choices = (current: string | null) => options.filter((option) => option.value === current || !picked.includes(option.value));
  return (
    <SliderRow label="Weapons for RED and BLU" value={`${picked.length} of ${TEAM_PAIR_LIMIT}`}>
      <div className="showcase-pairs">
        {picked.map((weaponKey, index) => (
          <div key={weaponKey} className="showcase-pair">
            <IconSelectField value={weaponKey} options={choices(weaponKey)} ariaLabel={`RED and BLU weapon ${index + 1}`} searchPlaceholder="Filter weapons..."
              onChange={(next) => onChange(picked.map((key, at) => (at === index ? next : key)))} />
            {picked.length > 1 && (
              <button type="button" className="showcase-btn" title="Remove" aria-label={`Remove ${options.find((option) => option.value === weaponKey)?.label ?? 'weapon'}`}
                onClick={() => onChange(picked.filter((_, at) => at !== index))}>
                <X size={13} />
              </button>
            )}
          </div>
        ))}
        {picked.length < TEAM_PAIR_LIMIT && (
          <IconSelectField value="" placeholder="Add weapon" options={choices(null)} ariaLabel="Add a RED and BLU weapon" searchPlaceholder="Filter weapons..."
            onChange={(next) => onChange([...picked, next])} />
        )}
      </div>
    </SliderRow>
  );
}

const SKETCH = { width: 64, height: 36 };

function LayoutSketch({ rows }: { rows: LayoutRows }) {
  const mixedTeams = rows.some((row) => row.some((entry) => entry.paint.team !== rows[0][0]?.paint.team));
  return (
    <svg viewBox={`0 0 ${SKETCH.width} ${SKETCH.height}`} aria-hidden="true">
      {rows.flatMap((row, rowIndex) => {
        const y = (SKETCH.height * (rowIndex + 1)) / (rows.length + 1);
        const pitch = SKETCH.width / row.length;
        return row.map((slot, index) => {
          const length = Math.min(pitch * 0.7, SKETCH.width * 0.6);
          const thickness = Math.min(4, (SKETCH.height / (rows.length + 1)) * 0.55);
          const x = pitch * (index + 0.5);
          const team = mixedTeams ? slot.paint.team : null;
          return (
            <rect key={`${rowIndex}-${index}`} x={x - length / 2} y={y - thickness / 2} width={length} height={thickness} rx={1}
              data-team={team ?? undefined} />
          );
        });
      })}
    </svg>
  );
}
