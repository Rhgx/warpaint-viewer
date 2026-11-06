import { memo, useState } from 'react';
import { LayoutGrid, X } from 'lucide-react';

import { IconSelectField, type IconOption } from '../common/controls';
import { Button } from '../primitives/Button';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../primitives/Tooltip';
import type { ShowcaseBoard } from '../../showcase/ShowcaseBoard';
import { TEAM_PAIR_LIMIT, type BoardLayout, type LayoutRows } from '../../showcase/layouts';
import { Section, SliderRow, ValueSlider } from './ShowcaseControls';
import { WEAPON_SIZE } from './showcaseSettings';
import { useBusy } from './useBusy';

// Ready-made board layouts, and the pickers for the weapons they feature.

const SKETCH_PICTURE = 'block h-auto w-full rounded-xs bg-panel-2';

/** Ready-made arrangements of the current paint, each drawn as a small sketch. */
export const LayoutsSection = memo(function LayoutsSection({ board, layouts, featureOptions, onFeature, onApply, weaponSize, onWeaponSizeChange, pickerReset }: {
  board: ShowcaseBoard;
  layouts: readonly BoardLayout[];
  featureOptions: IconOption[];
  /** Feature other weapons; returns the layout `layoutId` becomes with them. */
  onFeature: (pick: FeaturePick, layoutId: string) => BoardLayout | undefined;
  onApply: () => void;
  /** Percent of the largest size that fits. */
  weaponSize: number;
  onWeaponSizeChange: (weaponSize: number) => void;
  /** Changes when the board is replaced from elsewhere, which leaves the weapon picker belonging to nothing. */
  pickerReset: number;
}) {
  const [busy, run] = useBusy();
  // The weapon picker belongs to the wears and the RED and BLU pair, so it shows once one is applied.
  const [appliedId, setAppliedId] = useState<string | null>(null);
  const [seenReset, setSeenReset] = useState(pickerReset);
  if (seenReset !== pickerReset) {
    setSeenReset(pickerReset);
    setAppliedId(null);
  }
  const applied = appliedId && FEATURE_LAYOUTS.has(appliedId) ? layouts.find((layout) => layout.id === appliedId) : undefined;
  const featured = applied?.rows[0]?.[0]?.weaponKey;
  const reapply = (pick: FeaturePick) => {
    const layout = applied && onFeature(pick, applied.id);
    if (layout) void apply(layout)();
  };
  const apply = (layout: BoardLayout) => run(async () => {
    setAppliedId(layout.id);
    onApply();
    await board.applyLayout(layout.rows, layout.pack, layout.inward, layout.upright, layout.logoSpace);
  });
  return (
    <Section title="Layouts" icon={LayoutGrid}>
      <div className="grid grid-cols-3 gap-1.5">
        {layouts.map((layout) => (
          <Tooltip key={layout.id}>
            <TooltipTrigger delay={200} render={(
              <Button data-slot="board-layout" className="h-auto flex-col items-stretch justify-start gap-1 bg-panel px-1.25 pt-1.25 pb-1 text-11 disabled:cursor-progress disabled:opacity-60" disabled={busy}
                onPointerEnter={() => board.preload(layout.rows)} onFocus={() => board.preload(layout.rows)}
                onClick={apply(layout)} />
            )}>
              {layout.pack === 'composed' ? <ComposedSketch logoSpace={layout.logoSpace} /> : <LayoutSketch rows={layout.rows} />}
              <span>{layout.label}</span>
            </TooltipTrigger>
            <TooltipPopup>Replaces the weapons on the board</TooltipPopup>
          </Tooltip>
        ))}
      </div>
      {/* Not called a size: each weapon's own Size slider is its true size, which a layout sets below 100%. */}
      <ValueSlider label="Fill" display={`${weaponSize}%`} value={weaponSize} min={WEAPON_SIZE.min} max={WEAPON_SIZE.max} step={WEAPON_SIZE.step}
        hint="How much of the board a layout's weapons fill. 100% is the largest that fits."
        onChange={onWeaponSizeChange}
        onCommit={(size) => {
          // Set here as well as from the setting, so the layout uses the released value right away.
          board.setLayoutSize(size / 100);
          void run(() => board.reapplyLayout())();
        }} />
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
      <div className="flex flex-col gap-1">
        {picked.map((weaponKey, index) => (
          // The field's own minimum width would push the remove button out.
          <div key={weaponKey} className="flex gap-1 [&>:first-child]:min-w-0 [&>:first-child]:flex-auto">
            <IconSelectField value={weaponKey} options={choices(weaponKey)} ariaLabel={`RED and BLU weapon ${index + 1}`} searchPlaceholder="Filter weapons..."
              onChange={(next) => onChange(picked.map((key, at) => (at === index ? next : key)))} />
            {picked.length > 1 && (
              <Button className="h-auto self-stretch" title="Remove" aria-label={`Remove ${options.find((option) => option.value === weaponKey)?.label ?? 'weapon'}`}
                onClick={() => onChange(picked.filter((_, at) => at !== index))}>
                <X size={13} />
              </Button>
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
const SKETCH_LOGO = { width: 15, height: 18 };

/** x, y, width and height of each bar. */
const COMPOSED_BARS = [
  [4, 5, 18, 4], [4, 13, 15, 3], [4, 20, 16, 3], [4, 27, 11, 3],
  [47, 6, 13, 3], [42, 13, 18, 3], [45, 20, 15, 3], [40, 27, 20, 4],
];
const CENTER_BARS = [[26, 12, 12, 3], [26, 21, 9, 3]];
const LOGO_CENTER_BARS = [[26, 4, 12, 2], [26, 30, 12, 2]];

function ComposedSketch({ logoSpace }: { logoSpace?: boolean }) {
  return (
    <svg className={SKETCH_PICTURE} viewBox={`0 0 ${SKETCH.width} ${SKETCH.height}`} aria-hidden="true">
      {[...COMPOSED_BARS, ...(logoSpace ? LOGO_CENTER_BARS : CENTER_BARS)].map(([x, y, width, height]) => (
        <rect className="fill-dim" key={`${x}-${y}`} x={x} y={y} width={width} height={height} rx={1} />
      ))}
      {logoSpace && (
        <rect className="fill-none stroke-dim stroke-1 [stroke-dasharray:2_2]" x={(SKETCH.width - SKETCH_LOGO.width) / 2} y={(SKETCH.height - SKETCH_LOGO.height) / 2} width={SKETCH_LOGO.width} height={SKETCH_LOGO.height} rx={1} />
      )}
    </svg>
  );
}

function LayoutSketch({ rows }: { rows: LayoutRows }) {
  const mixedTeams = rows.some((row) => row.some((entry) => entry.paint.team !== rows[0][0]?.paint.team));
  return (
    <svg className={SKETCH_PICTURE} viewBox={`0 0 ${SKETCH.width} ${SKETCH.height}`} aria-hidden="true">
      {rows.flatMap((row, rowIndex) => {
        const y = (SKETCH.height * (rowIndex + 1)) / (rows.length + 1);
        const pitch = SKETCH.width / row.length;
        return row.map((slot, index) => {
          const length = Math.min(pitch * 0.7, SKETCH.width * 0.6);
          const thickness = Math.min(4, (SKETCH.height / (rows.length + 1)) * 0.55);
          const x = pitch * (index + 0.5);
          const team = mixedTeams ? slot.paint.team : null;
          return (
            <rect className="fill-dim data-[team=blu]:fill-blu data-[team=red]:fill-red" key={`${rowIndex}-${index}`} x={x - length / 2} y={y - thickness / 2} width={length} height={thickness} rx={1}
              data-team={team ?? undefined} />
          );
        });
      })}
    </svg>
  );
}
