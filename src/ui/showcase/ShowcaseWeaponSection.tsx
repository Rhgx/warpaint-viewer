import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Boxes, CopyPlus, Crosshair, FlipHorizontal2, Image, PackageOpen, RotateCcw, RotateCw, Trash2 } from 'lucide-react';

import type { PaintkitEntry } from '../../data/types';
import { TILT_LIMIT, type ShowcaseBoard } from '../../showcase/ShowcaseBoard';
import type { FitProblem, ShowcaseItem, ShowcasePaint } from '../../showcase/showcaseTypes';
import { restingRoll, shownSideFlip } from '../../showcase/weaponGeometry';
import { POSE_RIGS, WEAPON_PARTS, defaultPose, snapMarks, snapPose, type PoseControl } from '../../showcase/poseRigs';
import { randomSeed } from '../../hooks/useBootData';
import { Control, SeedInput, TeamToggle, WearSliderField } from '../common/controls';
import { Slider } from '../primitives/Slider';
import { Switch } from '../primitives/Switch';
import { Button } from '../primitives/Button';
import { cn } from '../primitives/cn';
import { InlineNotice } from '../primitives/Notice';
import { SECTION_TITLE } from '../primitives/textStyles';
import { EYE_ICON, EYE_OFF_ICON, PercentInput, Row, Section, SliderRow, ValueSlider } from './ShowcaseControls';
import { describeProblem } from './showcaseSettings';

// The selected weapon's controls: paint, transform, pose, parts, and actions.

const SIZE_SLIDER = { min: 50, max: 150 };

/** Typed sizes may go past the slider. */
const SIZE_TYPED = { min: 10, max: 500 };

const ZERO_MARK = [0];
const HUNDRED_MARK = [100];

const ROTATE_CCW_ICON = <RotateCcw size={13} />;
const ROTATE_CW_ICON = <RotateCw size={13} />;
const FLIP_ICON = <FlipHorizontal2 size={13} />;
const DUPLICATE_ICON = <CopyPlus size={13} />;
const REMOVE_ICON = <Trash2 size={13} />;
// The same icons as these fields have in the inspector.

const SUBHEADING = cn('mt-1 border-t border-border pt-2', SECTION_TITLE);

const ACTIONS = 'flex gap-1 pt-0.5';

export const WeaponSection = memo(function WeaponSection({ board, item, problem, rotationSnap, rotationStep, poseHandles, onPoseHandlesChange, kit, wearNames }: {
  board: ShowcaseBoard;
  item: ShowcaseItem;
  kit: PaintkitEntry | null;
  wearNames: readonly string[];
  problem: FitProblem;
  rotationSnap: number;
  rotationStep: number;
  poseHandles: boolean;
  onPoseHandlesChange: (shown: boolean) => void;
}) {
  const { id } = item;
  // Handlers depend only on the weapon's id, so a rotation re-renders just the
  // slider whose value moved.
  const poseRef = useRef(item.pose);
  useEffect(() => {
    poseRef.current = item.pose;
  }, [item.pose]);
  const settle = useCallback(() => board.settle(id), [board, id]);
  const setRoll = useCallback((roll: number) => board.update(id, { roll }), [board, id]);
  const setTilt = useCallback((tilt: number) => board.update(id, { tilt }), [board, id]);
  const setTurn = useCallback((turn: number) => board.update(id, { turn }), [board, id]);
  const setSize = useCallback((value: number) => board.update(id, { scale: value / 100 }), [board, id]);
  const typeSize = useCallback((value: number) => { board.update(id, { scale: value / 100 }); board.settle(id); }, [board, id]);
  const setPose = useCallback((key: string, value: number) => board.update(id, { pose: { ...poseRef.current, [key]: value } }), [board, id]);
  const rig = item.part ? undefined : POSE_RIGS[item.weaponKey];
  const parts = item.part ? [] : WEAPON_PARTS[item.weaponKey] ?? [];
  const size = Math.round(item.scale * 100);
  const restPose = item.part ? {} : defaultPose(item.weaponKey);
  const restRoll = restingRoll(item.weaponKey, item.part);
  const restFlipped = shownSideFlip(item.weaponKey, item.part) ?? false;
  const changed = item.roll !== restRoll || item.tilt !== 0 || item.turn !== 0 || item.flipped !== restFlipped || item.scale !== 1
    || JSON.stringify(item.pose) !== JSON.stringify(restPose);
  return (
    <Section
      icon={Crosshair}
      // The header keeps the name in view when the layer list is collapsed or scrolled away.
      title={item.weaponName}
      onClose={() => board.select(null)}
      canReset={changed}
      onReset={() => {
        board.update(id, { roll: restRoll, tilt: 0, turn: 0, flipped: restFlipped, scale: 1, pose: restPose });
        board.settle(id);
      }}
    >
      {problem && <InlineNotice tone="error">{describeProblem(problem)}</InlineNotice>}
      <PaintRows board={board} id={id} paint={item.paint} kit={kit} wearNames={wearNames} />
      <div className={SUBHEADING}>Transform</div>
      <ValueSlider label="Roll" display={`${item.roll}°`} value={item.roll} min={-180} max={180} step={rotationSnap || 1}
        markers={ZERO_MARK} onChange={setRoll} onCommit={settle} />
      <ValueSlider label="Tilt" display={`${item.tilt}°`} value={item.tilt} min={-TILT_LIMIT} max={TILT_LIMIT} step={1}
        markers={ZERO_MARK} onChange={setTilt} onCommit={settle} />
      <ValueSlider label="Turn" display={`${item.turn}°`} value={item.turn} min={-TILT_LIMIT} max={TILT_LIMIT} step={1}
        markers={ZERO_MARK} onChange={setTurn} onCommit={settle} />
      <SizeSlider size={size} onChange={setSize} onCommit={settle} onType={typeSize} />
      {rig && (
        <>
          <div className={SUBHEADING}>Pose</div>
          {rig.controls.map((control) => (
            <PoseSlider key={control.id} control={control} value={item.pose[control.id] ?? control.defaultValue} onPose={setPose} onCommit={settle} />
          ))}
          {rig.controls.some((control) => control.handle) && (
            <Row label="Handles on the weapon">
              <Switch checked={poseHandles} onChange={onPoseHandlesChange} ariaLabel="Handles on the weapon" />
            </Row>
          )}
        </>
      )}
      {parts.length > 0 && (
        <>
          <div className={SUBHEADING}>Parts</div>
          {parts.map((part) => {
            const shown = !part.loose && !item.hiddenParts.includes(part.id);
            return (
              <div key={part.id} className="flex min-h-control items-center gap-1.5">
                <span className="min-w-0 flex-1 text-12 text-dim">{part.label}</span>
                {!part.loose && (
                  <Button variant="ghost" size="icon-sm" className="flex-none" aria-pressed={shown}
                    title={shown ? `Leave the ${part.label.toLowerCase()} out` : `Put the ${part.label.toLowerCase()} back`}
                    onClick={() => board.setPartShown(id, part.id, !shown)}>
                    {shown ? EYE_ICON : EYE_OFF_ICON}
                  </Button>
                )}
                <Button title={`Place the ${part.label.toLowerCase()} on the board by itself`}
                  onClick={() => void board.pullOutPart(id, part.id)}>
                  <PackageOpen size={13} /> Take out
                </Button>
              </div>
            );
          })}
        </>
      )}
      <div className={ACTIONS}>
        <Button title={`Rotate ${rotationStep}° counterclockwise (Q)`}
          onClick={() => board.rotateBy(id, rotationStep)}>{ROTATE_CCW_ICON}</Button>
        <Button title={`Rotate ${rotationStep}° clockwise (E)`}
          onClick={() => board.rotateBy(id, -rotationStep)}>{ROTATE_CW_ICON}</Button>
        <Button title="Show the other side (F)"
          onClick={() => { board.update(id, { flipped: !item.flipped }); board.settle(id); }}>{FLIP_ICON}</Button>
        <Button title="Duplicate" onClick={() => void board.duplicate(id)}>{DUPLICATE_ICON}</Button>
        <span className="flex-1" />
        <Button variant="danger" title="Remove (Delete)" onClick={() => board.remove(id)}>{REMOVE_ICON}</Button>
      </div>
    </Section>
  );
});

/** Only what a picture can do: it has no paint, and lies flat. */
export const ImageSection = memo(function ImageSection({ board, item, problem, rotationSnap, rotationStep }: {
  board: ShowcaseBoard;
  item: ShowcaseItem;
  problem: FitProblem;
  rotationSnap: number;
  rotationStep: number;
}) {
  const { id } = item;
  const settle = useCallback(() => board.settle(id), [board, id]);
  const setRoll = useCallback((roll: number) => board.update(id, { roll }), [board, id]);
  const setSize = useCallback((value: number) => board.update(id, { scale: value / 100 }), [board, id]);
  const typeSize = useCallback((value: number) => { board.update(id, { scale: value / 100 }); board.settle(id); }, [board, id]);
  return (
    <Section
      icon={Image}
      title={item.weaponName}
      onClose={() => board.select(null)}
      canReset={item.roll !== 0 || item.flipped || item.scale !== 1}
      onReset={() => {
        board.update(id, { roll: 0, flipped: false, scale: 1 });
        board.settle(id);
      }}
    >
      {problem && <InlineNotice tone="error">{describeProblem(problem)}</InlineNotice>}
      <ValueSlider label="Roll" display={`${item.roll}°`} value={item.roll} min={-180} max={180} step={rotationSnap || 1}
        markers={ZERO_MARK} onChange={setRoll} onCommit={settle} />
      <SizeSlider size={Math.round(item.scale * 100)} onChange={setSize} onCommit={settle} onType={typeSize} />
      <div className={ACTIONS}>
        <Button title={`Rotate ${rotationStep}° counterclockwise (Q)`}
          onClick={() => board.rotateBy(id, rotationStep)}>{ROTATE_CCW_ICON}</Button>
        <Button title={`Rotate ${rotationStep}° clockwise (E)`}
          onClick={() => board.rotateBy(id, -rotationStep)}>{ROTATE_CW_ICON}</Button>
        <Button title="Mirror (F)"
          onClick={() => { board.update(id, { flipped: !item.flipped }); board.settle(id); }}>{FLIP_ICON}</Button>
        <Button title="Duplicate" onClick={() => void board.duplicate(id)}>{DUPLICATE_ICON}</Button>
        <span className="flex-1" />
        <Button variant="danger" title="Remove (Delete)" onClick={() => board.remove(id)}>{REMOVE_ICON}</Button>
      </div>
    </Section>
  );
});

function shared<T>(values: readonly T[]): T | null {
  return values.length && values.every((value) => value === values[0]) ? values[0] : null;
}

export const MultiSection = memo(function MultiSection({ board, items, paintkits, wearNames, rotationSnap, rotationStep }: {
  board: ShowcaseBoard;
  items: readonly ShowcaseItem[];
  paintkits: readonly PaintkitEntry[];
  wearNames: readonly string[];
  rotationSnap: number;
  rotationStep: number;
}) {
  const [seedDraft, setSeedDraft] = useState<string | null>(null);
  const ids = items.map((item) => item.id);
  // Pictures only share the transform and actions: they have no paint, and lie flat.
  const weapons = items.filter((item) => !item.image);
  const weaponIds = weapons.map((item) => item.id);
  const kitOf = (item: ShowcaseItem) => paintkits.find((kit) => kit.id === item.paint.kitId);
  // Wear and team only reach the weapons whose paint varies by them, as on a single weapon.
  const byWear = items.filter((item) => kitOf(item)?.perWear);
  const byTeam = items.filter((item) => kitOf(item)?.hasTeamTextures);
  const wear = shared(byWear.map((item) => item.paint.wearIndex));
  const team = shared(byTeam.map((item) => item.paint.team));
  const seed = shared(weapons.map((item) => item.paint.seed));
  const roll = shared(items.map((item) => item.roll));
  const tilt = shared(weapons.map((item) => item.tilt));
  const turn = shared(weapons.map((item) => item.turn));
  const size = shared(items.map((item) => Math.round(item.scale * 100)));
  const settle = () => board.settleMany(ids);
  // Esc blurs the input before the cleared draft renders, so the blur has to be told not to commit.
  const seedCancelled = useRef(false);
  const commitSeed = () => {
    const typed = (seedDraft ?? '').trim();
    setSeedDraft(null);
    if (seedCancelled.current) {
      seedCancelled.current = false;
      return;
    }
    if (/^\d+$/.test(typed) && BigInt(typed) < 2n ** 64n) board.setPaintMany(weaponIds, { seed: BigInt(typed).toString() });
  };
  return (
    <Section icon={Boxes} title={weapons.length === items.length ? `${items.length} weapons` : `${items.length} selected`} onClose={() => board.select(null)}>
      {byWear.length > 0 && (
        <SliderRow label="Wear" value={wear === null ? 'Mixed' : wearNames[wear]}>
          <WearSliderField value={wear ?? byWear[0].paint.wearIndex} names={wearNames}
            onChange={(wearIndex) => board.setPaintMany(byWear.map((item) => item.id), { wearIndex })} />
        </SliderRow>
      )}
      {byTeam.length > 0 && (
        <SliderRow label="Team" value={team === null ? 'Mixed' : null}>
          <TeamToggle team={team ?? byTeam[0].paint.team} onChange={(next) => board.setPaintMany(byTeam.map((item) => item.id), { team: next })} />
        </SliderRow>
      )}
      {weapons.length > 0 && <Control group label="Seed">
        <SeedInput
          aria-label="Pattern seed for all selected"
          placeholder="Mixed"
          randomizeLabel="A random seed for each"
          onRandomize={() => board.setPaintMany(weaponIds, () => ({ seed: randomSeed() }))}
          value={seedDraft ?? seed ?? ''}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setSeedDraft(event.currentTarget.value.replace(/\D/g, ''))}
          onBlur={commitSeed}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') {
              seedCancelled.current = true;
              event.currentTarget.blur();
            }
          }}
        />
      </Control>}
      <div className={SUBHEADING}>Transform</div>
      <ValueSlider label="Roll" display={roll === null ? 'Mixed' : `${roll}°`} value={roll ?? items[0].roll} min={-180} max={180} step={rotationSnap || 1}
        markers={ZERO_MARK} onChange={(value) => board.updateMany(ids, { roll: value })} onCommit={settle} />
      {weapons.length > 0 && (
        <>
          <ValueSlider label="Tilt" display={tilt === null ? 'Mixed' : `${tilt}°`} value={tilt ?? weapons[0].tilt} min={-TILT_LIMIT} max={TILT_LIMIT} step={1}
            markers={ZERO_MARK} onChange={(value) => board.updateMany(weaponIds, { tilt: value })} onCommit={settle} />
          <ValueSlider label="Turn" display={turn === null ? 'Mixed' : `${turn}°`} value={turn ?? weapons[0].turn} min={-TILT_LIMIT} max={TILT_LIMIT} step={1}
            markers={ZERO_MARK} onChange={(value) => board.updateMany(weaponIds, { turn: value })} onCommit={settle} />
        </>
      )}
      <ValueSlider label="Size" display={size === null ? 'Mixed' : `${size}%`}
        value={Math.min(SIZE_SLIDER.max, Math.max(SIZE_SLIDER.min, size ?? Math.round(items[0].scale * 100)))} min={SIZE_SLIDER.min} max={SIZE_SLIDER.max} step={5}
        markers={HUNDRED_MARK} onChange={(value) => board.updateMany(ids, { scale: value / 100 })} onCommit={settle} />
      <div className={ACTIONS}>
        <Button title={`Rotate each ${rotationStep}° counterclockwise (Q)`}
          onClick={() => board.rotateMany(ids, rotationStep)}>{ROTATE_CCW_ICON}</Button>
        <Button title={`Rotate each ${rotationStep}° clockwise (E)`}
          onClick={() => board.rotateMany(ids, -rotationStep)}>{ROTATE_CW_ICON}</Button>
        <Button title="Show the other side of each (F)" onClick={() => board.flipMany(ids)}>{FLIP_ICON}</Button>
        <Button title="Hide them" onClick={() => board.setHiddenMany(ids, true)}>{EYE_OFF_ICON}</Button>
        <span className="flex-1" />
        <Button variant="danger" title="Remove them (Delete)" onClick={() => board.removeMany(ids)}>{REMOVE_ICON}</Button>
      </div>
    </Section>
  );
});

/** Wear, team and pattern seed of one weapon; only the ones its paint varies by. */
const PaintRows = memo(function PaintRows({ board, id, paint, kit, wearNames }: {
  board: ShowcaseBoard;
  id: string;
  paint: ShowcasePaint;
  kit: PaintkitEntry | null;
  wearNames: readonly string[];
}) {
  const [seedDraft, setSeedDraft] = useState<string | null>(null);
  const commitSeed = () => {
    const seed = (seedDraft ?? '').trim();
    setSeedDraft(null);
    // Seeds are unsigned 64-bit integers, as in the viewer.
    if (/^\d+$/.test(seed) && BigInt(seed) < 2n ** 64n && seed !== paint.seed) board.setPaint(id, { seed: BigInt(seed).toString() });
  };
  return (
    <>
      {kit?.perWear && (
        <SliderRow label="Wear" value={wearNames[paint.wearIndex]}>
          <WearSliderField value={paint.wearIndex} names={wearNames}
            onChange={(wearIndex) => { if (wearIndex !== paint.wearIndex) board.setPaint(id, { wearIndex }); }} />
        </SliderRow>
      )}
      {kit?.hasTeamTextures && (
        <SliderRow label="Team" value={null}>
          <TeamToggle team={paint.team} onChange={(team) => { if (team !== paint.team) board.setPaint(id, { team }); }} />
        </SliderRow>
      )}
      <Control group label="Seed">
        <SeedInput
          aria-label="Pattern seed"
          randomizeLabel="Random seed"
          onRandomize={() => board.setPaint(id, { seed: randomSeed() })}
          value={seedDraft ?? paint.seed}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setSeedDraft(event.currentTarget.value.replace(/\D/g, ''))}
          onBlur={commitSeed}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') {
              setSeedDraft(null);
              event.currentTarget.blur();
            }
          }}
        />
      </Control>
    </>
  );
});

const SizeSlider = memo(function SizeSlider({ size, onChange, onCommit, onType }: {
  size: number;
  onChange: (value: number) => void;
  onCommit: () => void;
  onType: (value: number) => void;
}) {
  return (
    <SliderRow label="Size" value={<PercentInput value={size} min={SIZE_TYPED.min} max={SIZE_TYPED.max} label="Size in percent" onCommit={onType} />}>
      <Slider value={Math.min(SIZE_SLIDER.max, Math.max(SIZE_SLIDER.min, size))} min={SIZE_SLIDER.min} max={SIZE_SLIDER.max}
        step={5} ariaLabel="Size" markers={HUNDRED_MARK} onChange={onChange} onCommit={onCommit} />
    </SliderRow>
  );
});

const PoseSlider = memo(function PoseSlider({ control, value, onPose, onCommit }: {
  control: PoseControl;
  value: number;
  onPose: (key: string, value: number) => void;
  onCommit: () => void;
}) {
  const onChange = useCallback((next: number) => onPose(control.id, snapPose(control, next)), [control, onPose]);
  const marks = useMemo(() => snapMarks(control), [control]);
  return (
    <ValueSlider label={control.label} display={`${value}${control.unit}`} value={value} min={control.min} max={control.max}
      step={control.step} markers={marks} onChange={onChange} onCommit={onCommit} />
  );
});
