// Valve's CUniformRandomStream (vstdlib/random.cpp), as used by TF2's texture
// compositor. Paint-kit seeds are split into two interleaved 32-bit streams;
// recipe stages alternate between them after resolving their own random fields.

const NTAB = 32;
const IA = 16807;
const IM = 2147483647;
const IQ = 127773;
const IR = 2836;
const NDIV = 1 + (IM - 1) / NTAB;
const AM = 1 / IM;
const RNMX = 1 - 1.2e-7;
const MAX_RANDOM_RANGE = 0x7fffffff;

export class UniformRandomStream {
  private idum = 0;
  private iy = 0;
  private iv = new Array<number>(NTAB).fill(0);

  constructor(seed: number) {
    this.setSeed(seed);
  }

  setSeed(seed: number) {
    const signed = seed | 0;
    this.idum = signed < 0 ? signed : -signed;
    this.iy = 0;
    this.iv.fill(0);
  }

  private generate(): number {
    let k: number;
    if (this.idum <= 0 || this.iy === 0) {
      this.idum = -this.idum < 1 ? 1 : -this.idum;
      for (let j = NTAB + 7; j >= 0; j--) {
        k = Math.trunc(this.idum / IQ);
        this.idum = Math.trunc(IA * (this.idum - k * IQ) - IR * k);
        if (this.idum < 0) this.idum += IM;
        if (j < NTAB) this.iv[j] = this.idum;
      }
      this.iy = this.iv[0];
    }
    k = Math.trunc(this.idum / IQ);
    this.idum = Math.trunc(IA * (this.idum - k * IQ) - IR * k);
    if (this.idum < 0) this.idum += IM;
    let j = Math.trunc(this.iy / NDIV);
    if (j < 0 || j >= NTAB) j &= NTAB - 1;
    this.iy = this.iv[j];
    this.iv[j] = this.idum;
    return this.iy;
  }

  randomFloat(low = 0, high = 1): number {
    const value = Math.min(AM * this.generate(), RNMX);
    return value * (high - low) + low;
  }

  randomInt(low: number, high: number): number {
    const range = high - low + 1;
    if (range <= 1 || MAX_RANDOM_RANGE < range - 1) return low;
    const maxAcceptable = MAX_RANDOM_RANGE - ((MAX_RANDOM_RANGE + 1) % range);
    let value: number;
    do value = this.generate(); while (value > maxAcceptable);
    return low + (value % range);
  }
}

export interface PaintkitRandomState {
  streams: [UniformRandomStream, UniformRandomStream];
  current: 0 | 1;
}

export function createPaintkitRandomState(seed: number): PaintkitRandomState {
  const source = BigInt(seed >>> 0);
  const split = [0n, 0n];
  for (let i = 0n; i < 32n; i++) {
    const sourceBit = 2n * i;
    for (let stream = 0n; stream < 2n; stream++) {
      split[Number(stream)] |= (source & (1n << (sourceBit + stream))) >> (i + stream);
    }
  }
  const lo = Number(BigInt.asIntN(32, split[0]));
  const hi = Number(BigInt.asIntN(32, split[1]));
  return { streams: [new UniformRandomStream(lo), new UniformRandomStream(hi)], current: 0 };
}

export function resolveRange(
  rng: UniformRandomStream,
  range: [number, number] | undefined,
  fallback: number,
): number {
  const [low, high] = range ?? [fallback, fallback];
  return rng.randomFloat(low, high);
}

export function advancePaintkitStream(state: PaintkitRandomState) {
  state.current = state.current === 0 ? 1 : 0;
}
