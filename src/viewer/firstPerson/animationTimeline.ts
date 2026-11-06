/** Clips that play one after another, addressed by one position in seconds. */
export interface AnimationTimeline {
  readonly durations: readonly number[];
  readonly total: number;
  /** The stretch that repeats while looping: a sequence's middle clip, or all of a single clip. */
  readonly loopStart: number;
  readonly loopEnd: number;
}

// Source fades a new sequence in over its fadein, 0.2 s by default, and that hides clips whose ends do not
// meet: a Wrench's Inspect loop ends with the left hand 54 degrees from where Inspect End begins.
const SEAM_BLEND_SECONDS = 0.2;

export function createTimeline(durations: readonly number[], loopIndex = 0): AnimationTimeline {
  const sum = (lengths: readonly number[]) => lengths.reduce((total, duration) => total + duration, 0);
  const loopStart = sum(durations.slice(0, loopIndex));
  return { durations, total: sum(durations), loopStart, loopEnd: loopStart + (durations[loopIndex] ?? 0) };
}

/** Where each clip after the first begins: the points of interest along a sequence. */
export function timelineBoundaries({ durations }: AnimationTimeline): number[] {
  let start = 0;
  return durations.slice(0, -1).map(duration => (start += duration));
}

/** `blend` is how far the clip has faded in over the end pose of the one before it. */
export function locateOnTimeline({ durations, total }: AnimationTimeline, position: number): { index: number; local: number; blend: number } {
  const clamped = Math.min(Math.max(position, 0), total);
  let start = 0;
  for (let index = 0; index < durations.length; index++) {
    const duration = durations[index];
    if (clamped < start + duration || index === durations.length - 1) {
      const local = clamped - start;
      const window = Math.min(SEAM_BLEND_SECONDS, duration);
      return { index, local, blend: index === 0 || window === 0 ? 1 : Math.min(1, local / window) };
    }
    start += duration;
  }
  return { index: 0, local: 0, blend: 1 };
}

/**
 * Looping holds the loop, as holding the inspect key does in the game. Scrubbed past it, the outro plays out before the
 * loop takes over again. With looping off it plays through and stops on the last frame. Standing still changes nothing,
 * so that a position scrubbed to the very end stays there.
 */
export function advanceTimeline({ total, loopStart, loopEnd }: AnimationTimeline, position: number, delta: number, looping = true): { position: number; wraps: number; ended: boolean } {
  if (delta <= 0 || total <= 0) return { position, wraps: 0, ended: false };
  const next = position + delta;
  if (!looping) return next >= total ? { position: total, wraps: 0, ended: true } : { position: next, wraps: 0, ended: false };
  const limit = position < loopEnd ? loopEnd : total;
  if (next < limit) return { position: next, wraps: 0, ended: false };
  const length = loopEnd - loopStart;
  if (length <= 0) return { position: loopStart, wraps: 0, ended: false };
  const over = next - limit;
  return { position: loopStart + over % length, wraps: 1 + Math.floor(over / length), ended: false };
}
