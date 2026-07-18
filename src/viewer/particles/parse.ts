import * as THREE from 'three';
import { colorFromArray, numOr, warnOnce } from './util';

export interface UnusualFunctionEntry {
  functionName: string;
  params: Record<string, unknown>;
}

export interface UnusualSystemDef {
  attributes: Record<string, unknown>;
  children: string[];
  initializers: UnusualFunctionEntry[];
  operators: UnusualFunctionEntry[];
  emitters: UnusualFunctionEntry[];
  renderers: UnusualFunctionEntry[];
  constraints?: UnusualFunctionEntry[];
}

function normalizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) out[k.trim().toLowerCase().replace(/\s+/g, '_')] = v;
  return out;
}

function normName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function boolOr(v: unknown, def: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return def;
}

function arrOr3(v: unknown, def: [number, number, number]): [number, number, number] {
  if (Array.isArray(v) && v.length >= 3 && v.every((n) => typeof n === 'number')) {
    return [v[0], v[1], v[2]];
  }
  return def;
}

// Source WORLD-space vectors (gravity, non-local bias directions) are Z-up;
// the scene is Y-up, so (x, y, z) -> (x, z, y), matching the original gravity
// mapping in this file.
function swizzleSourceWorld(v: [number, number, number]): THREE.Vector3 {
  return new THREE.Vector3(v[0], v[2], v[1]);
}

// ---------------------------------------------------------------------------
// Parsed system configuration
// ---------------------------------------------------------------------------

export interface SphereInit {
  cp: number;
  distMin: number;
  distMax: number;
  bias: [number, number, number];
  biasAbs: [number, number, number];
  localBias: boolean;
  speedMin: number;
  speedMax: number;
  speedExp: number;
  localSpeedMin: [number, number, number] | null;
  localSpeedMax: [number, number, number] | null;
}

export interface ParsedInit {
  kind: 'sphere' | 'offset' | 'lifetime' | 'alpha' | 'radius' | 'colorRandom' | 'rotationRandom'
      | 'yawFlip' | 'remapScalar' | 'velocityNoise' | 'velocityInherit' | 'velocityRandom' | 'sequence';
  sphere?: SphereInit;
  offset?: { cp: number; min: [number, number, number]; max: [number, number, number]; local: boolean };
  range?: { min: number; max: number; exp: number };
  colors?: { c1: THREE.Color; c2: THREE.Color };
  rotation?: { initial: number; offMin: number; offMax: number; exp: number };
  flipPercent?: number;
  remap?: { inMin: number; inMax: number; outMin: number; outMax: number; scalar: boolean };
  noise?: { min: [number, number, number]; max: [number, number, number]; local: boolean; cp: number };
  inherit?: { cp: number; scale: number };
  sequenceRange?: { min: number; max: number };
}

export interface ParsedConstraint {
  kind: 'pathBetweenCps';
  path?: {
    startCp: number;
    endCp: number;
    travelTime: number;
    minDistance: number;
    maxDistance: number;
    maxDistanceMiddle: number;
    maxDistanceEnd: number;
    midPointPosition: number;
  };
}

export interface ParsedOp {
  kind: 'movement' | 'lifespanDecay' | 'fadeAndKill' | 'fadeIn' | 'fadeOut' | 'radiusScale'
      | 'colorFade' | 'spin' | 'lock' | 'rotAxis' | 'oscillate' | 'maintainPath'
      | 'setChildCps' | 'setCpPositions';
  movement?: { gravity: THREE.Vector3; drag: number };
  // All four fade times are fractions of the particle's lifetime (compared
  // against age/lifetime directly, the same way C_OP_FadeAndKill's doOperate
  // does: o = currentTime/timeToLive), not absolute seconds.
  fadeAndKill?: { startFadeIn: number; endFadeIn: number; startFadeOut: number; endFadeOut: number; startAlphaFactor: number; endAlphaFactor: number };
  fade?: { min: number; max: number; proportional: boolean; ease: boolean };
  radiusScale?: { start: number; end: number; startTime: number; endTime: number; bias: number; ease: boolean };
  colorFade?: { color: THREE.Color; start: number; end: number; ease: boolean };
  spin?: { rate: number; stopTime: number; rateMin: number };
  lock?: { cp: number; startMin: number; startMax: number; endMin: number; endMax: number; lockRot: boolean };
  rotAxis?: { axis: [number, number, number]; rate: number; cp: number; local: boolean };
  oscillate?: { field: number; rateMin: [number, number, number]; rateMax: [number, number, number]; freqMin: [number, number, number]; freqMax: [number, number, number]; multiplier: number; startPhase: number };
  maintainPath?: { startCp: number; endCp: number; count: number; cohesion: number };
  setChildCps?: { firstCp: number; count: number; firstParticle: number };
  setCpPositions?: { entries: Array<{ cp: number; location: [number, number, number] }>; worldSpace: boolean; offsetFromCp: number };
}

export interface EmitterConfig {
  mode: 'continuous' | 'instant';
  rate: number;
  duration: number;
  startTime: number;
  count: number;
}

export function parseInitializers(list: UnusualFunctionEntry[]): ParsedInit[] {
  const out: ParsedInit[] = [];
  for (const entry of list) {
    const p = normalizeParams(entry.params);
    switch (normName(entry.functionName)) {
      case 'positionwithinsphererandom':
        out.push({
          kind: 'sphere',
          sphere: {
            cp: numOr(p.control_point_number, 0),
            distMin: numOr(p.distance_min, 0),
            distMax: numOr(p.distance_max, numOr(p.distance_min, 0)),
            bias: arrOr3(p.distance_bias, [1, 1, 1]),
            biasAbs: arrOr3(p.distance_bias_absolute_value, [0, 0, 0]),
            localBias: boolOr(p.bias_in_local_system, false),
            speedMin: numOr(p.speed_min, 0),
            speedMax: numOr(p.speed_max, numOr(p.speed_min, 0)),
            speedExp: numOr(p.speed_random_exponent, 1),
            localSpeedMin: Array.isArray(p.speed_in_local_coordinate_system_min)
              ? arrOr3(p.speed_in_local_coordinate_system_min, [0, 0, 0]) : null,
            localSpeedMax: Array.isArray(p.speed_in_local_coordinate_system_max)
              ? arrOr3(p.speed_in_local_coordinate_system_max, [0, 0, 0]) : null,
          },
        });
        break;
      case 'positionmodifyoffsetrandom':
        out.push({
          kind: 'offset',
          offset: {
            cp: numOr(p.control_point_number, 0),
            min: arrOr3(p.offset_min, [0, 0, 0]),
            max: arrOr3(p.offset_max, [0, 0, 0]),
            local: boolOr(p['offset_in_local_space_0/1'], false),
          },
        });
        break;
      case 'lifetimerandom':
        out.push({ kind: 'lifetime', range: { min: numOr(p.lifetime_min, 1), max: numOr(p.lifetime_max, numOr(p.lifetime_min, 1)), exp: numOr(p.lifetime_random_exponent, 1) } });
        break;
      case 'alpharandom':
        out.push({ kind: 'alpha', range: { min: numOr(p.alpha_min, 255), max: numOr(p.alpha_max, 255), exp: numOr(p.alpha_random_exponent, 1) } });
        break;
      case 'radiusrandom':
        out.push({ kind: 'radius', range: { min: numOr(p.radius_min, 1), max: numOr(p.radius_max, numOr(p.radius_min, 1)), exp: numOr(p.radius_random_exponent, 1) } });
        break;
      case 'colorrandom': {
        const c1 = colorFromArray(p.color1);
        const c2 = colorFromArray(p.color2);
        if (c1 && c2) out.push({ kind: 'colorRandom', colors: { c1, c2 } });
        break;
      }
      case 'rotationrandom':
        out.push({ kind: 'rotationRandom', rotation: { initial: numOr(p.rotation_initial, 0), offMin: numOr(p.rotation_offset_min, 0), offMax: numOr(p.rotation_offset_max, 0), exp: numOr(p.rotation_random_exponent, 1) } });
        break;
      case 'rotationyawrandom':
        // YAW (attribute 12) only affects oriented sprite renderers; the
        // screen-aligned Points path ignores it like frame 0 of
        // render_animated_sprites with orientation 0 would.
        break;
      case 'rotationyawfliprandom':
        // Yaw flip mirrors the sprite; approximate with a 180 degree roll.
        out.push({ kind: 'yawFlip', flipPercent: numOr(p.flip_percentage, 0.5) });
        break;
      case 'sequencerandom':
        out.push({
          kind: 'sequence',
          sequenceRange: { min: numOr(p.sequence_min, 0), max: numOr(p.sequence_max, numOr(p.sequence_min, 0)) },
        });
        break;
      case 'remapinitialscalar': {
        const inField = numOr(p.input_field, -1);
        const outField = numOr(p.output_field, -1);
        // The only combination in these files: CREATION_TIME (8) remapped
        // onto ROTATION (4), in degrees (particles.h attribute ids).
        if (inField === 8 && outField === 4) {
          out.push({
            kind: 'remapScalar',
            remap: {
              inMin: numOr(p.input_minimum, 0),
              inMax: numOr(p.input_maximum, 1),
              outMin: numOr(p.output_minimum, 0),
              outMax: numOr(p.output_maximum, 0),
              scalar: boolOr(p.output_is_scalar_of_initial_random_range, false),
            },
          });
        } else {
          warnOnce(`remap-${inField}-${outField}`, `remap initial scalar with unhandled fields ${inField} -> ${outField}`);
        }
        break;
      }
      case 'velocitynoise':
        // The SDK samples curl noise; a per-particle random draw inside the
        // same output box keeps the population statistics without the noise
        // field itself.
        out.push({
          kind: 'velocityNoise',
          noise: {
            min: arrOr3(p.output_minimum, [0, 0, 0]),
            max: arrOr3(p.output_maximum, [0, 0, 0]),
            local: boolOr(p['apply_velocity_in_local_space_(0/1)'], false),
            cp: numOr(p.control_point_number, 0),
          },
        });
        break;
      case 'velocityinheritfromcontrolpoint':
        out.push({ kind: 'velocityInherit', inherit: { cp: numOr(p.control_point_number, 0), scale: numOr(p.velocity_scale, 1) } });
        break;
      case 'velocityrandom':
        out.push({
          kind: 'velocityRandom',
          sphere: {
            cp: numOr(p.control_point_number, 0),
            distMin: 0, distMax: 0, bias: [1, 1, 1], biasAbs: [0, 0, 0], localBias: false,
            speedMin: numOr(p.random_speed_min, 0),
            speedMax: numOr(p.random_speed_max, numOr(p.random_speed_min, 0)),
            speedExp: 1,
            localSpeedMin: Array.isArray(p.speed_in_local_coordinate_system_min)
              ? arrOr3(p.speed_in_local_coordinate_system_min, [0, 0, 0]) : null,
            localSpeedMax: Array.isArray(p.speed_in_local_coordinate_system_max)
              ? arrOr3(p.speed_in_local_coordinate_system_max, [0, 0, 0]) : null,
          },
        });
        break;
      default:
        break;
    }
  }
  return out;
}

export function parseOperators(list: UnusualFunctionEntry[]): ParsedOp[] {
  const out: ParsedOp[] = [];
  for (const entry of list) {
    const p = normalizeParams(entry.params);
    switch (normName(entry.functionName)) {
      case 'movementbasic': {
        const g = arrOr3(p.gravity, [0, 0, 0]);
        out.push({ kind: 'movement', movement: { gravity: swizzleSourceWorld(g), drag: numOr(p.drag, 0) } });
        break;
      }
      case 'lifespandecay':
        out.push({ kind: 'lifespanDecay' });
        break;
      case 'alphafadeanddecay':
      case 'fadeandkill':
        // C_OP_FadeAndKill (aka "Alpha Fade and Decay"): verified against
        // loadout.tf's reimplementation. doOperate computes o =
        // currentTime/timeToLive (a FRACTION of lifetime, not absolute
        // seconds) and compares the four fade times against that fraction
        // directly; the death check is the same one Lifespan Decay uses
        // (timeToLive < currentTime), independent of the fade-out window. So
        // when start/end fade-out are authored as values >1 (energy orb uses
        // 2.5/3.0 against a 2.1s lifetime, i.e. o never gets there), that
        // half of the operator simply never fires and the particle just
        // holds at full alpha until Alpha Fade Out Random (a separate,
        // proportional op) fades it, or its lifetime runs out.
        out.push({
          kind: 'fadeAndKill',
          fadeAndKill: {
            startFadeIn: numOr(p.start_fade_in_time, 0),
            endFadeIn: numOr(p.end_fade_in_time, 0.5),
            startFadeOut: numOr(p.start_fade_out_time, 0.5),
            endFadeOut: numOr(p.end_fade_out_time, 1),
            startAlphaFactor: numOr(p.start_alpha, 1),
            endAlphaFactor: numOr(p.end_alpha, 0),
          },
        });
        break;
      case 'alphafadeinrandom':
        out.push({
          kind: 'fadeIn',
          fade: {
            min: numOr(p.fade_in_time_min, 0),
            max: numOr(p.fade_in_time_max, numOr(p.fade_in_time_min, 0)),
            proportional: boolOr(p['proportional_0/1'], true),
            ease: false,
          },
        });
        break;
      case 'alphafadeoutrandom':
        out.push({
          kind: 'fadeOut',
          fade: {
            min: numOr(p.fade_out_time_min, 0),
            max: numOr(p.fade_out_time_max, numOr(p.fade_out_time_min, 0)),
            proportional: boolOr(p['proportional_0/1'], true),
            ease: boolOr(p.ease_in_and_out, false),
          },
        });
        break;
      case 'radiusscale':
        out.push({
          kind: 'radiusScale',
          radiusScale: {
            start: numOr(p.radius_start_scale, 1),
            end: numOr(p.radius_end_scale, 1),
            startTime: numOr(p.start_time, 0),
            endTime: numOr(p.end_time, 1),
            bias: numOr(p.scale_bias, 0.5),
            ease: boolOr(p.ease_in_and_out, false),
          },
        });
        break;
      case 'colorfade': {
        const c = colorFromArray(p.color_fade);
        if (c) {
          out.push({
            kind: 'colorFade',
            colorFade: { color: c, start: numOr(p.fade_start_time, 0), end: numOr(p.fade_end_time, 1), ease: boolOr(p.ease_in_and_out, false) },
          });
        }
        break;
      }
      case 'rotationspinroll':
        out.push({ kind: 'spin', spin: { rate: numOr(p.spin_rate_degrees, 0), stopTime: numOr(p.spin_stop_time, 0), rateMin: numOr(p.spin_rate_min, 0) } });
        break;
      case 'movementlocktocontrolpoint':
        out.push({
          kind: 'lock',
          lock: {
            cp: numOr(p.control_point_number, 0),
            startMin: numOr(p.start_fadeout_min, 1),
            startMax: numOr(p.start_fadeout_max, numOr(p.start_fadeout_min, 1)),
            endMin: numOr(p.end_fadeout_min, 1),
            endMax: numOr(p.end_fadeout_max, numOr(p.end_fadeout_min, 1)),
            lockRot: boolOr(p.lock_rotation, false),
          },
        });
        break;
      case 'movementrotateparticlearoundaxis':
        out.push({
          kind: 'rotAxis',
          rotAxis: {
            axis: arrOr3(p.rotation_axis, [0, 0, 1]),
            rate: numOr(p.rotation_rate, 0),
            cp: numOr(p.control_point, 0),
            local: boolOr(p.use_local_space, false),
          },
        });
        break;
      case 'oscillatevector':
        out.push({
          kind: 'oscillate',
          oscillate: {
            field: numOr(p.oscillation_field, 0),
            rateMin: arrOr3(p.oscillation_rate_min, [0, 0, 0]),
            rateMax: arrOr3(p.oscillation_rate_max, [0, 0, 0]),
            freqMin: arrOr3(p.oscillation_frequency_min, [1, 1, 1]),
            freqMax: arrOr3(p.oscillation_frequency_max, [1, 1, 1]),
            multiplier: numOr(p.oscillation_multiplier, 1),
            startPhase: numOr(p.oscillation_start_phase, 0),
          },
        });
        break;
      case 'movementmaintainpositionalongpath':
        out.push({
          kind: 'maintainPath',
          maintainPath: {
            startCp: numOr(p.start_control_point_number, 0),
            endCp: numOr(p.end_control_point_number, 0),
            count: Math.max(1, Math.round(numOr(p.particles_to_map_from_start_to_end, 1))),
            cohesion: numOr(p.cohesion_strength, 1),
          },
        });
        break;
      case 'setchildcontrolpointsfromparticlepositions':
        out.push({
          kind: 'setChildCps',
          setChildCps: {
            firstCp: numOr(p.first_control_point_to_set, 0),
            count: Math.max(1, Math.round(numOr(p['#_of_control_points_to_set'], 1))),
            firstParticle: Math.max(0, Math.round(numOr(p.first_particle_to_copy, 0))),
          },
        });
        break;
      case 'setcontrolpointpositions': {
        const entries: Array<{ cp: number; location: [number, number, number] }> = [];
        for (const ord of ['first', 'second', 'third', 'fourth']) {
          const cp = p[`${ord}_control_point_number`];
          const loc = p[`${ord}_control_point_location`];
          if (typeof cp === 'number' && Array.isArray(loc)) {
            entries.push({ cp, location: arrOr3(loc, [0, 0, 0]) });
          }
        }
        out.push({
          kind: 'setCpPositions',
          setCpPositions: {
            entries,
            worldSpace: boolOr(p.set_positions_in_world_space, false),
            offsetFromCp: numOr(p.control_point_to_offset_positions_from, 0),
          },
        });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

// C_OP_ConstrainDistanceToPath: the entire motion model for the energy orb
// (a particle streams from a start CP to an end CP over "travel time"), and
// for isotope's glow children and cool's barrel systems. Unrecognized
// constraints are ignored silently, matching how unrecognized operators are
// handled above.
export function parseConstraints(list: UnusualFunctionEntry[]): ParsedConstraint[] {
  const out: ParsedConstraint[] = [];
  for (const entry of list) {
    const p = normalizeParams(entry.params);
    switch (normName(entry.functionName)) {
      case 'constraindistancetopathbetweentwocontrolpoints':
        out.push({
          kind: 'pathBetweenCps',
          path: {
            startCp: numOr(p.start_control_point_number, 0),
            endCp: numOr(p.end_control_point_number, 0),
            travelTime: Math.max(1e-4, numOr(p.travel_time, 1)),
            minDistance: numOr(p.minimum_distance, 0),
            maxDistance: numOr(p.maximum_distance, 100),
            maxDistanceMiddle: numOr(p.maximum_distance_middle, -1),
            maxDistanceEnd: numOr(p.maximum_distance_end, -1),
            midPointPosition: numOr(p.mid_point_position, 0.5),
          },
        });
        break;
      default:
        break;
    }
  }
  return out;
}

export function parseEmitters(list: UnusualFunctionEntry[]): EmitterConfig[] {
  const out: EmitterConfig[] = [];
  for (const entry of list) {
    const p = normalizeParams(entry.params);
    const name = normName(entry.functionName);
    if (name === 'emitcontinuously') {
      out.push({
        mode: 'continuous',
        rate: Math.max(0, numOr(p.emission_rate, 0)),
        duration: numOr(p.emission_duration, 0),
        startTime: numOr(p.emission_start_time, 0),
        count: 0,
      });
    } else if (name === 'emitinstantaneously') {
      out.push({
        mode: 'instant',
        rate: 0,
        duration: 0,
        startTime: numOr(p.emission_start_time, 0),
        count: Math.max(0, Math.round(numOr(p.num_to_emit, 0))),
      });
    }
  }
  return out;
}
