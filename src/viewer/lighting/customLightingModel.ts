// The custom rig's constants, types and startup validation, kept free of three.js so the
// initial bundle can load a persisted rig. customLighting.ts builds the runtime lights.

/** The id used by the Lighting selector for a user-authored rig. */
export const CUSTOM_LIGHTING_ID = 'custom';
const CUSTOM_LIGHTING_VERSION = 1 as const;
export const MAX_CUSTOM_LIGHTS = 8;

/** Positions are authored in units of the model's largest framed dimension. */
export const CUSTOM_LIGHT_POSITION_LIMIT = 10;
const CUSTOM_LIGHT_INTENSITY_LIMIT = 20;
export const CUSTOM_LIGHT_RANGE_LIMIT = 20;
/** Validator bounds, shared with the lighting UI sliders so both enforce the same range. */
export const MIN_SPOT_ANGLE_DEGREES = 1;
// Leaves room for the Inspect preset's cone (about 116.6 degrees) so a reset rig survives validation.
export const MAX_SPOT_ANGLE_DEGREES = 120;
export const CUSTOM_DIRECTION_LIMIT = 1;
export const CUSTOM_AMBIENT_MAX = 1;
export const CUSTOM_EXPOSURE_MIN = 0.1;
export const CUSTOM_EXPOSURE_MAX = 4;
export const CUSTOM_SOFTNESS_MAX = 1;

export type CustomLightType = 'point' | 'spot' | 'directional';
export type FrameVector = readonly [number, number, number];

interface CustomLightBase {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  /** CSS-compatible sRGB hex colour. */
  readonly color: string;
  readonly intensity: number;
}

interface CustomPointLight extends CustomLightBase {
  readonly type: 'point';
  readonly position: FrameVector;
  /** Null means no distance cutoff. */
  readonly range: number | null;
}

interface CustomSpotLight extends CustomLightBase {
  readonly type: 'spot';
  readonly position: FrameVector;
  readonly target: FrameVector;
  readonly range: number | null;
  readonly angleDegrees: number;
  /** 0 is a hard edge and 1 is a fully soft edge. */
  readonly softness: number;
}

interface CustomDirectionalLight extends CustomLightBase {
  readonly type: 'directional';
  /** Unit light-ray vector from the source toward the illuminated point. */
  readonly direction: FrameVector;
}

export type CustomLight = CustomPointLight | CustomSpotLight | CustomDirectionalLight;

export interface CustomLightingRig {
  readonly version: typeof CUSTOM_LIGHTING_VERSION;
  readonly lights: readonly CustomLight[];
  /** Ambient cube strength used by the TF2 vertex-lit shader. */
  readonly ambient: number;
  readonly exposure: number;
  /** Preserve the material-authored, view-dependent TF2 rim highlight. */
  readonly cameraRimLight: boolean;
}

const DEFAULT_AMBIENT = 0.4;
const DEFAULT_EXPOSURE = 1;
const DEFAULT_POSITION: FrameVector = [0, 0, 0];
const DEFAULT_DIRECTION: FrameVector = [0, 0, 1];

// Same arithmetic as THREE.MathUtils.clamp, so validated values match the renderer's.
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return clamp(finiteNumber(value, fallback), min, max);
}

function readVector(value: unknown, fallback: FrameVector, limit = CUSTOM_LIGHT_POSITION_LIMIT): FrameVector {
  if (!Array.isArray(value) || value.length !== 3) return fallback;
  return [
    clampNumber(value[0], -limit, limit, fallback[0]),
    clampNumber(value[1], -limit, limit, fallback[1]),
    clampNumber(value[2], -limit, limit, fallback[2]),
  ];
}

function readDirection(value: unknown): FrameVector {
  const candidate = readVector(value, DEFAULT_DIRECTION, CUSTOM_DIRECTION_LIMIT);
  const length = Math.hypot(candidate[0], candidate[1], candidate[2]);
  if (length < 1e-5) return DEFAULT_DIRECTION;
  return [candidate[0] / length, candidate[1] / length, candidate[2] / length];
}

const WHITE = '#ffffff';
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

// The names THREE.Color.setStyle accepts. The canvas also knows 'transparent' and the system
// colours, which THREE rejects, so names are checked against this list before the canvas sees them.
const CSS_COLOR_NAMES = new Set<string>([
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black', 'blanchedalmond',
  'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse', 'chocolate', 'coral',
  'cornflowerblue', 'cornsilk', 'crimson', 'cyan', 'darkblue', 'darkcyan', 'darkgoldenrod', 'darkgray',
  'darkgreen', 'darkgrey', 'darkkhaki', 'darkmagenta', 'darkolivegreen', 'darkorange', 'darkorchid', 'darkred',
  'darksalmon', 'darkseagreen', 'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise',
  'darkviolet', 'deeppink', 'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue', 'firebrick', 'floralwhite',
  'forestgreen', 'fuchsia', 'gainsboro', 'ghostwhite', 'gold', 'goldenrod', 'gray', 'green', 'greenyellow',
  'grey', 'honeydew', 'hotpink', 'indianred', 'indigo', 'ivory', 'khaki', 'lavender', 'lavenderblush',
  'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan', 'lightgoldenrodyellow', 'lightgray',
  'lightgreen', 'lightgrey', 'lightpink', 'lightsalmon', 'lightseagreen', 'lightskyblue', 'lightslategray',
  'lightslategrey', 'lightsteelblue', 'lightyellow', 'lime', 'limegreen', 'linen', 'magenta', 'maroon',
  'mediumaquamarine', 'mediumblue', 'mediumorchid', 'mediumpurple', 'mediumseagreen', 'mediumslateblue',
  'mediumspringgreen', 'mediumturquoise', 'mediumvioletred', 'midnightblue', 'mintcream', 'mistyrose',
  'moccasin', 'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab', 'orange', 'orangered', 'orchid',
  'palegoldenrod', 'palegreen', 'paleturquoise', 'palevioletred', 'papayawhip', 'peachpuff', 'peru', 'pink',
  'plum', 'powderblue', 'purple', 'rebeccapurple', 'red', 'rosybrown', 'royalblue', 'saddlebrown', 'salmon',
  'sandybrown', 'seagreen', 'seashell', 'sienna', 'silver', 'skyblue', 'slateblue', 'slategray', 'slategrey',
  'snow', 'springgreen', 'steelblue', 'tan', 'teal', 'thistle', 'tomato', 'turquoise', 'violet', 'wheat',
  'white', 'whitesmoke', 'yellow', 'yellowgreen',
]);

// The same grammar THREE.Color.setStyle parses, so the same strings are accepted. Like THREE,
// text after the closing parenthesis is ignored and alpha is dropped.
const CSS_FUNCTION = /^(\w+)\(([^)]*)\)/;
const RGB_NUMBERS = /^\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*\d*\.?\d+\s*)?$/;
const RGB_PERCENTS = /^\s*(\d+)%\s*,\s*(\d+)%\s*,\s*(\d+)%\s*(?:,\s*\d*\.?\d+\s*)?$/;
const HSL_VALUES = /^\s*(\d*\.?\d+)\s*,\s*(\d*\.?\d+)%\s*,\s*(\d*\.?\d+)%\s*(?:,\s*\d*\.?\d+\s*)?$/;

/** Resolves a CSS colour string to '#rrggbb', or null when the browser cannot. */
type CssStyleResolver = (style: string) => string | null;

function expandHex(value: string): string {
  const digits = value.slice(1).toLowerCase();
  return digits.length === 3 ? `#${[...digits].map((digit) => digit + digit).join('')}` : `#${digits}`;
}

/** How a colour string resolves: hex computed here, or a CSS string the browser resolves. */
type ColorSource = { readonly hex: string } | { readonly css: string };

/**
 * Reads a string the way THREE.Color.setStyle does, or returns null when THREE rejects it.
 * Hex never reaches here; normaliseColorValue expands it first.
 */
function colorSourceFor(value: string): ColorSource | null {
  const fn = CSS_FUNCTION.exec(value);
  if (fn) {
    const [, name, body] = fn;
    if (name === 'rgb' || name === 'rgba') {
      const numbers = RGB_NUMBERS.exec(body);
      if (numbers) {
        const [r, g, b] = numbers.slice(1, 4).map((channel) => Math.min(255, parseInt(channel, 10)));
        return { css: `rgb(${r}, ${g}, ${b})` };
      }
      const percents = RGB_PERCENTS.exec(body);
      if (percents) {
        const [r, g, b] = percents.slice(1, 4).map((channel) => Math.min(100, parseInt(channel, 10)));
        return { css: `rgb(${r}%, ${g}%, ${b}%)` };
      }
      return null;
    }
    if (name === 'hsl' || name === 'hsla') {
      const hsl = HSL_VALUES.exec(body);
      if (!hsl) return null;
      return { hex: hslToHex(parseFloat(hsl[1]) / 360, parseFloat(hsl[2]) / 100, parseFloat(hsl[3]) / 100) };
    }
    return null;
  }
  if (value.startsWith('#')) return null;
  return CSS_COLOR_NAMES.has(value.toLowerCase()) ? { css: value } : null;
}

function hueToChannel(p: number, q: number, t: number): number {
  let hue = t;
  if (hue < 0) hue += 1;
  if (hue > 1) hue -= 1;
  if (hue < 1 / 6) return p + (q - p) * 6 * hue;
  if (hue < 1 / 2) return q;
  if (hue < 2 / 3) return p + (q - p) * 6 * (2 / 3 - hue);
  return p;
}

function srgbToLinear(channel: number): number {
  return channel < 0.04045 ? channel * 0.0773993808 : Math.pow(channel * 0.9478672986 + 0.0521327014, 2.4);
}

function linearToSrgb(channel: number): number {
  return channel < 0.0031308 ? channel * 12.92 : 1.055 * Math.pow(channel, 0.41666) - 0.055;
}

// Mirrors THREE.Color.setHSL and getHex: the channels round-trip through linear light before
// rounding, which the canvas does not do, so hsl() values can land a unit apart.
function hslToHex(hue: number, saturation: number, lightness: number): string {
  const h = ((hue % 1) + 1) % 1;
  const s = clamp(saturation, 0, 1);
  const l = clamp(lightness, 0, 1);
  let channels: readonly [number, number, number] = [l, l, l];
  if (s !== 0) {
    const p = l <= 0.5 ? l * (1 + s) : l + s - l * s;
    const q = 2 * l - p;
    channels = [hueToChannel(q, p, h + 1 / 3), hueToChannel(q, p, h), hueToChannel(q, p, h - 1 / 3)];
  }
  return '#' + channels
    .map((channel) => Math.round(clamp(linearToSrgb(srgbToLinear(channel)) * 255, 0, 255)).toString(16).padStart(2, '0'))
    .join('');
}

let styleContext: CanvasRenderingContext2D | null | undefined;

/** Reads a canvas fillStyle value as hex, dropping alpha. Null when it is not a colour. */
export function canvasOutputToHex(output: string): string | null {
  if (/^#[0-9a-f]{6}$/i.test(output)) return output.toLowerCase();
  const rgba = /^rgba?\((\d+), (\d+), (\d+)(?:, [\d.]+)?\)$/.exec(output);
  if (!rgba) return null;
  return `#${rgba.slice(1, 4).map((channel) => Number(channel).toString(16).padStart(2, '0')).join('')}`;
}

/** Lets the browser resolve a CSS colour. The canvas is created on first use and then reused. */
function canvasStyleToHex(style: string): string | null {
  if (styleContext === undefined) {
    styleContext = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  }
  if (!styleContext) return null;
  // The browser leaves fillStyle unchanged when it rejects a value. Two sentinels tell
  // that apart from a style that resolves to the first sentinel's colour.
  for (const sentinel of ['#000001', '#000002']) {
    styleContext.fillStyle = sentinel;
    styleContext.fillStyle = style;
    const output = styleContext.fillStyle;
    if (output !== sentinel) return typeof output === 'string' ? canvasOutputToHex(output) : null;
  }
  return null;
}

/**
 * Normalises a colour from an untrusted value to '#rrggbb', matching THREE.Color. Invalid
 * input becomes white, as THREE leaves a colour it cannot parse at white.
 */
export function normaliseColorValue(value: unknown, resolveStyle: CssStyleResolver = canvasStyleToHex): string {
  if (typeof value !== 'string') return WHITE;
  if (HEX_COLOR.test(value)) return expandHex(value);
  const source = colorSourceFor(value);
  if (source === null) return WHITE;
  return ('hex' in source ? source.hex : resolveStyle(source.css)) ?? WHITE;
}

function readString(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string') return fallback;
  const result = value.trim().slice(0, maxLength);
  return result || fallback;
}

function readRange(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return clamp(value, 0, CUSTOM_LIGHT_RANGE_LIMIT);
}

function readBase(value: Record<string, unknown>, index: number): CustomLightBase {
  return {
    id: readString(value.id, `light-${index + 1}`, 64),
    name: readString(value.name, `Light ${index + 1}`, 64),
    enabled: value.enabled !== false,
    color: normaliseColorValue(value.color),
    intensity: clampNumber(value.intensity, 0, CUSTOM_LIGHT_INTENSITY_LIMIT, 1),
  };
}

function readLight(value: unknown, index: number): CustomLight {
  const object = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const base = readBase(object, index);
  switch (object.type) {
    case 'spot':
      return {
        ...base,
        type: 'spot',
        position: readVector(object.position, DEFAULT_POSITION),
        target: readVector(object.target, DEFAULT_POSITION),
        range: readRange(object.range),
        // Three's spot attenuation is a smoothstep on cos(angle), so cones wider
        // than 90 degrees are valid; MAX_SPOT_ANGLE_DEGREES sets the upper bound.
        angleDegrees: clampNumber(object.angleDegrees, MIN_SPOT_ANGLE_DEGREES, MAX_SPOT_ANGLE_DEGREES, 45),
        softness: clampNumber(object.softness, 0, CUSTOM_SOFTNESS_MAX, 0.35),
      };
    case 'directional':
      return {
        ...base,
        type: 'directional',
        direction: readDirection(object.direction),
      };
    case 'point':
    default:
      return {
        ...base,
        type: 'point',
        position: readVector(object.position, DEFAULT_POSITION),
        range: readRange(object.range),
      };
  }
}

function uniqueLights(lights: readonly CustomLight[]): CustomLight[] {
  const ids = new Set<string>();
  return lights.map((light) => {
    let id = light.id;
    let suffix = 2;
    while (ids.has(id)) id = `${light.id}-${suffix++}`;
    ids.add(id);
    return id === light.id ? light : { ...light, id };
  });
}

/**
 * Sanitizes an unknown value at the persistence and import boundary, keeping as much
 * of a partly valid rig as possible so malformed state never reaches three.js.
 */
export function validateCustomLightingRig(value: unknown): CustomLightingRig {
  const object = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const sourceLights = Array.isArray(object.lights) ? object.lights.slice(0, MAX_CUSTOM_LIGHTS) : [];
  const lights = uniqueLights(sourceLights.map((light, index) => readLight(light, index)));
  return {
    version: CUSTOM_LIGHTING_VERSION,
    lights,
    ambient: clampNumber(object.ambient, 0, CUSTOM_AMBIENT_MAX, DEFAULT_AMBIENT),
    exposure: clampNumber(object.exposure, CUSTOM_EXPOSURE_MIN, CUSTOM_EXPOSURE_MAX, DEFAULT_EXPOSURE),
    cameraRimLight: object.cameraRimLight === true,
  };
}

export function createDefaultCustomLightingRig(): CustomLightingRig {
  return {
    version: CUSTOM_LIGHTING_VERSION,
    ambient: DEFAULT_AMBIENT,
    exposure: DEFAULT_EXPOSURE,
    cameraRimLight: true,
    lights: [
      {
        id: 'key', name: 'Key Light', type: 'directional', enabled: true, color: '#ffffff', intensity: 1,
        direction: [0, 1, 0],
      },
      {
        id: 'spot', name: 'Spot Light', type: 'spot', enabled: true, color: '#fff3f3', intensity: 1 / 4.5,
        position: [0, 1, 0], target: [0, 0, -2], range: null,
        // Same value as THREE.MathUtils.radToDeg, which is radians * 180 / PI.
        angleDegrees: Math.acos(Math.cos(90)) * (180 / Math.PI),
        softness: 1 - Math.acos(Math.cos(1)) / Math.acos(Math.cos(90)),
      },
      {
        id: 'point', name: 'Point Light', type: 'point', enabled: true, color: '#dae7ff', intensity: 1 / 15,
        position: [0.5, -2, -0.15], range: null,
      },
    ],
  };
}
