import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CopyPlus, Dices, FlipHorizontal2, PackageOpen, RotateCcw, RotateCw, Trash2 } from 'lucide-react';

import type { PaintkitEntry } from '../../data/types';
import { TILT_LIMIT, type ShowcaseBoard } from '../../showcase/ShowcaseBoard';
import type { FitProblem, ShowcaseItem, ShowcasePaint } from '../../showcase/showcaseTypes';
import { restingRoll } from '../../showcase/weaponGeometry';
import { POSE_RIGS, WEAPON_PARTS, defaultPose, snapMarks, snapPose, type PoseControl } from '../../showcase/poseRigs';
import { randomSeed } from '../../hooks/useBootData';
import { SliderField, SwitchField, TeamToggle, WearSliderField } from '../common/controls';
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
  const changed = item.roll !== restRoll || item.tilt !== 0 || item.turn !== 0 || item.flipped || item.scale !== 1
    || JSON.stringify(item.pose) !== JSON.stringify(restPose);
  return (
    <Section
      // The header keeps the name in view when the layer list is collapsed or scrolled away.
      title={item.weaponName}
      onClose={() => board.select(null)}
      canReset={changed}
      onReset={() => {
        board.update(id, { roll: restRoll, tilt: 0, turn: 0, flipped: false, scale: 1, pose: restPose });
        board.settle(id);
      }}
    >
      {problem && <span className="showcase-fit">{describeProblem(problem)}</span>}
      <PaintRows board={board} id={id} paint={item.paint} kit={kit} wearNames={wearNames} />
      <div className="showcase-subheading">Transform</div>
      <ValueSlider label="Roll" display={`${item.roll}°`} value={item.roll} min={-180} max={180} step={rotationSnap || 1}
        markers={ZERO_MARK} onChange={setRoll} onCommit={settle} />
      <ValueSlider label="Tilt" display={`${item.tilt}°`} value={item.tilt} min={-TILT_LIMIT} max={TILT_LIMIT} step={1}
        markers={ZERO_MARK} onChange={setTilt} onCommit={settle} />
      <ValueSlider label="Turn" display={`${item.turn}°`} value={item.turn} min={-TILT_LIMIT} max={TILT_LIMIT} step={1}
        markers={ZERO_MARK} onChange={setTurn} onCommit={settle} />
      <SizeSlider size={size} onChange={setSize} onCommit={settle} onType={typeSize} />
      {rig && (
        <>
          <div className="showcase-subheading">Pose</div>
          {rig.controls.map((control) => (
            <PoseSlider key={control.id} control={control} value={item.pose[control.id] ?? control.defaultValue} onPose={setPose} onCommit={settle} />
          ))}
          {rig.controls.some((control) => control.handle) && (
            <Row label="Handles on the weapon">
              <SwitchField checked={poseHandles} onChange={onPoseHandlesChange} ariaLabel="Handles on the weapon" />
            </Row>
          )}
        </>
      )}
      {parts.length > 0 && (
        <>
          <div className="showcase-subheading">Parts</div>
          {parts.map((part) => {
            const shown = !part.loose && !item.hiddenParts.includes(part.id);
            return (
              <div key={part.id} className="showcase-part">
                <span className="showcase-part-name">{part.label}</span>
                {!part.loose && (
                  <button type="button" className="showcase-layer-eye" aria-pressed={shown}
                    title={shown ? `Leave the ${part.label.toLowerCase()} out` : `Put the ${part.label.toLowerCase()} back`}
                    onClick={() => board.setPartShown(id, part.id, !shown)}>
                    {shown ? EYE_ICON : EYE_OFF_ICON}
                  </button>
                )}
                <button type="button" className="showcase-btn" title={`Place the ${part.label.toLowerCase()} on the board by itself`}
                  onClick={() => void board.pullOutPart(id, part.id)}>
                  <PackageOpen size={13} /> Take out
                </button>
              </div>
            );
          })}
        </>
      )}
      <div className="showcase-actions">
        <button type="button" className="showcase-btn" title={`Rotate ${rotationStep}° counterclockwise (Q)`}
          onClick={() => board.rotateBy(id, rotationStep)}>{ROTATE_CCW_ICON}</button>
        <button type="button" className="showcase-btn" title={`Rotate ${rotationStep}° clockwise (E)`}
          onClick={() => board.rotateBy(id, -rotationStep)}>{ROTATE_CW_ICON}</button>
        <button type="button" className="showcase-btn" title="Show the other side (F)"
          onClick={() => { board.update(id, { flipped: !item.flipped }); board.settle(id); }}>{FLIP_ICON}</button>
        <button type="button" className="showcase-btn" title="Duplicate" onClick={() => void board.duplicate(id)}>{DUPLICATE_ICON}</button>
        <span className="showcase-actions-spacer" />
        <button type="button" className="showcase-btn showcase-btn-danger" title="Remove (Delete)" onClick={() => board.remove(id)}>{REMOVE_ICON}</button>
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
      <Row label="Seed">
        <span className="showcase-seed">
          <input
            className="ui-input showcase-seed-input"
            inputMode="numeric"
            aria-label="Pattern seed"
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
          <button type="button" className="showcase-btn" title="Random seed" aria-label="Random seed"
            onClick={() => board.setPaint(id, { seed: randomSeed() })}>
            <Dices size={13} />
          </button>
        </span>
      </Row>
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
      <SliderField value={Math.min(SIZE_SLIDER.max, Math.max(SIZE_SLIDER.min, size))} min={SIZE_SLIDER.min} max={SIZE_SLIDER.max}
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
