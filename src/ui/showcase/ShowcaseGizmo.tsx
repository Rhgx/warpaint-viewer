import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { TILT_LIMIT, type ShowcaseBoard } from '../../showcase/ShowcaseBoard';
import type { ShowcaseItem } from '../../showcase/showcaseTypes';
import { POSE_RIGS, snapPose } from '../../showcase/poseRigs';

type Handle = 'roll' | 'tilt' | 'turn';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const wrap = (degrees: number) => ((((degrees + 180) % 360) + 360) % 360) - 180;
const DRAG_DEGREES_PER_PX = 0.35;

const LABELS: Record<Handle, string> = { roll: 'Roll', tilt: 'Tilt', turn: 'Turn' };

/** Rotate gizmo: the flat ring rolls the weapon; the two ellipses follow its roll and tilt or turn it around its own axes. */
export function ShowcaseGizmo({ board, item, snap }: { board: ShowcaseBoard; item: ShowcaseItem; snap: number }) {
  const [active, setActive] = useState<Handle | null>(null);
  const [hover, setHover] = useState<Handle | null>(null);
  const start = useRef({ x: 0, y: 0, roll: 0, tilt: 0, turn: 0, angle: 0 });
  const info = board.screenInfo(item.id);
  if (!info) return null;
  const { x, y } = info;
  const radius = Math.max(info.radius, 40);
  const depth = radius * 0.32;
  const rollRad = (-item.roll * Math.PI) / 180;
  const knob = { x: x + Math.cos(rollRad) * radius, y: y + Math.sin(rollRad) * radius };

  const angleAt = (event: ReactPointerEvent<SVGElement>) => {
    const svg = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    return Math.atan2(event.clientY - (svg?.top ?? 0) - y, event.clientX - (svg?.left ?? 0) - x);
  };

  const begin = (handle: Handle) => (event: ReactPointerEvent<SVGElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { x: event.clientX, y: event.clientY, roll: item.roll, tilt: item.tilt, turn: item.turn, angle: angleAt(event) };
    setActive(handle);
  };

  const move = (event: ReactPointerEvent<SVGElement>) => {
    if (!active) return;
    const s = start.current;
    if (active === 'roll') {
      let roll = s.roll - ((angleAt(event) - s.angle) * 180) / Math.PI;
      if (snap > 0 && !event.shiftKey) roll = Math.round(roll / snap) * snap;
      board.update(item.id, { roll: wrap(Math.round(roll)) });
      return;
    }
    const dx = event.clientX - s.x;
    const dy = event.clientY - s.y;
    const cos = Math.cos(rollRad);
    const sin = Math.sin(rollRad);
    const along = dx * cos + dy * sin;
    const across = -dx * sin + dy * cos;
    if (active === 'tilt') {
      board.update(item.id, { tilt: clamp(Math.round(s.tilt - across * DRAG_DEGREES_PER_PX), -TILT_LIMIT, TILT_LIMIT) });
    } else {
      board.update(item.id, { turn: clamp(Math.round(s.turn + along * DRAG_DEGREES_PER_PX), -TILT_LIMIT, TILT_LIMIT) });
    }
  };

  const end = (event: ReactPointerEvent<SVGElement>) => {
    if (!active) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setActive(null);
    board.settle(item.id);
  };

  const handleProps = (handle: Handle) => ({
    onPointerDown: begin(handle),
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: end,
    onPointerEnter: () => setHover(handle),
    onPointerLeave: () => setHover((current) => (current === handle ? null : current)),
  });

  const state = (handle: Handle) => (active === handle ? 'active' : !active && hover === handle ? 'hover' : undefined);
  const shown = active ?? hover;
  const value = shown === 'roll' ? `${item.roll}°` : shown === 'tilt' ? `${item.tilt}°` : `${item.turn}°`;
  // Front halves are solid and back halves dashed, so the ellipses read as rings in depth.
  const halfArc = (rx: number, ry: number, front: 'right' | 'bottom') => front === 'right'
    ? { front: `M ${x} ${y - ry} A ${rx} ${ry} 0 0 1 ${x} ${y + ry}`, back: `M ${x} ${y + ry} A ${rx} ${ry} 0 0 1 ${x} ${y - ry}` }
    : { front: `M ${x - rx} ${y} A ${rx} ${ry} 0 0 0 ${x + rx} ${y}`, back: `M ${x + rx} ${y} A ${rx} ${ry} 0 0 0 ${x - rx} ${y}` };
  const tiltArcs = halfArc(depth, radius * 0.86, 'right');
  const turnArcs = halfArc(radius * 0.86, depth, 'bottom');

  return (
    <svg className="showcase-gizmo" aria-hidden="true">
      <g className="showcase-gizmo-axis" data-axis="roll" data-state={state('roll')}>
        <circle className="showcase-gizmo-line" cx={x} cy={y} r={radius} />
        <circle className="showcase-gizmo-hit" cx={x} cy={y} r={radius} {...handleProps('roll')} />
        <g transform={`translate(${knob.x} ${knob.y}) rotate(${-item.roll})`} {...handleProps('roll')} className="showcase-gizmo-knob">
          <circle r={9} />
          <path d="M -3.5 -3 A 4.5 4.5 0 1 1 -4 2.5" />
          <path className="showcase-gizmo-knob-tip" d="M -6.5 1 L -4 3.8 L -1.4 0.9 Z" />
        </g>
      </g>
      {!item.image && <g transform={`rotate(${-item.roll} ${x} ${y})`}>
        <g className="showcase-gizmo-axis" data-axis="tilt" data-state={state('tilt')}>
          <path className="showcase-gizmo-line showcase-gizmo-back" d={tiltArcs.back} />
          <path className="showcase-gizmo-line" d={tiltArcs.front} />
          <ellipse className="showcase-gizmo-hit" cx={x} cy={y} rx={depth} ry={radius * 0.86} {...handleProps('tilt')} />
        </g>
        <g className="showcase-gizmo-axis" data-axis="turn" data-state={state('turn')}>
          <path className="showcase-gizmo-line showcase-gizmo-back" d={turnArcs.back} />
          <path className="showcase-gizmo-line" d={turnArcs.front} />
          <ellipse className="showcase-gizmo-hit" cx={x} cy={y} rx={radius * 0.86} ry={depth} {...handleProps('turn')} />
        </g>
      </g>}
      {shown && (
        <g transform={`translate(${x} ${y + radius + 20})`}>
          <rect className="showcase-gizmo-readout-bg" x={-36} y={-12} width={72} height={24} rx={4} />
          <text className="showcase-gizmo-readout" y={4}>
            <tspan className="showcase-gizmo-readout-label" data-axis={shown}>{LABELS[shown]}</tspan>
            <tspan dx={6}>{value}</tspan>
          </text>
        </g>
      )}
    </svg>
  );
}

/** Drag handles on a weapon's posable parts, an alternative to the sliders; each moves its part along its control's path. */
export function ShowcasePoseHandles({ board, item }: { board: ShowcaseBoard; item: ShowcaseItem }) {
  const [active, setActive] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const path = useRef<{ values: number[]; points: { x: number; y: number }[] } | null>(null);
  const rig = item.part ? undefined : POSE_RIGS[item.weaponKey];
  if (!rig) return null;
  const handles = board.poseHandles(item.id);
  if (!handles.length) return null;

  const begin = (controlId: string) => (event: ReactPointerEvent<SVGElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const traced = board.poseHandlePath(item.id, controlId);
    if (!traced) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    path.current = traced;
    setActive(controlId);
  };

  const move = (event: ReactPointerEvent<SVGElement>) => {
    const traced = path.current;
    const control = rig.controls.find((entry) => entry.id === active);
    if (!traced || !control) return;
    const svg = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    const px = event.clientX - (svg?.left ?? 0);
    const py = event.clientY - (svg?.top ?? 0);
    // Nearest point on the traced path, interpolated between its samples.
    let best = { distance: Infinity, value: traced.values[0] };
    for (let index = 0; index + 1 < traced.points.length; index += 1) {
      const a = traced.points[index];
      const b = traced.points[index + 1];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const length = abx * abx + aby * aby;
      const t = length ? clamp(((px - a.x) * abx + (py - a.y) * aby) / length, 0, 1) : 0;
      const distance = (a.x + abx * t - px) ** 2 + (a.y + aby * t - py) ** 2;
      if (distance < best.distance) best = { distance, value: traced.values[index] + (traced.values[index + 1] - traced.values[index]) * t };
    }
    let value = Math.round(best.value / control.step) * control.step;
    if (!event.shiftKey) value = snapPose(control, value);
    if (value !== item.pose[control.id]) board.update(item.id, { pose: { ...item.pose, [control.id]: value } });
  };

  const end = (event: ReactPointerEvent<SVGElement>) => {
    if (!active) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    path.current = null;
    setActive(null);
    board.settle(item.id);
  };

  const shown = rig.controls.find((control) => control.id === (active ?? hover));
  const shownHandle = handles.find((handle) => handle.controlId === shown?.id);
  return (
    <svg className="showcase-gizmo" aria-hidden="true">
      {handles.map((handle) => (
        <circle key={handle.controlId} className="showcase-pose-handle" cx={handle.x} cy={handle.y} r={6}
          data-state={active === handle.controlId ? 'active' : !active && hover === handle.controlId ? 'hover' : undefined}
          onPointerDown={begin(handle.controlId)} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
          onPointerEnter={() => setHover(handle.controlId)}
          onPointerLeave={() => setHover((current) => (current === handle.controlId ? null : current))} />
      ))}
      {shown && shownHandle && (
        <g transform={`translate(${shownHandle.x} ${shownHandle.y - 20})`}>
          <rect className="showcase-gizmo-readout-bg" x={-50} y={-12} width={100} height={24} rx={4} />
          <text className="showcase-gizmo-readout" y={4}>
            <tspan className="showcase-gizmo-readout-label">{shown.label}</tspan>
            <tspan dx={6}>{`${item.pose[shown.id] ?? shown.defaultValue}${shown.unit}`}</tspan>
          </text>
        </g>
      )}
    </svg>
  );
}
