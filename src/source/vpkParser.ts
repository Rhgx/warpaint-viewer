const EMPTY_BYTES = new Uint8Array(0);

export class VpkTreeReader {
  #offset = 0;
  readonly #decoder = new TextDecoder('utf-8', { fatal: true });
  readonly #bytes: Uint8Array;
  readonly #invalid: (message: string) => Error;

  constructor(bytes: Uint8Array, invalid: (message: string) => Error) {
    this.#bytes = bytes;
    this.#invalid = invalid;
  }

  get done(): boolean {
    return this.#offset === this.#bytes.byteLength;
  }

  string(context: string): string {
    const start = this.#offset;
    while (this.#offset < this.#bytes.byteLength && this.#bytes[this.#offset] !== 0) this.#offset += 1;
    if (this.#offset === this.#bytes.byteLength) {
      throw this.#invalid(`VPK ${context} string is missing its null terminator.`);
    }
    let value: string;
    try {
      value = this.#decoder.decode(this.#bytes.subarray(start, this.#offset));
    } catch {
      throw this.#invalid(`VPK ${context} string is not valid UTF-8.`);
    }
    this.#offset += 1;
    return value;
  }

  uint16(context: string): number {
    this.#ensure(2, context);
    const value = this.#bytes[this.#offset] | (this.#bytes[this.#offset + 1] << 8);
    this.#offset += 2;
    return value;
  }

  uint32(context: string): number {
    this.#ensure(4, context);
    const value = (
      this.#bytes[this.#offset]
      | (this.#bytes[this.#offset + 1] << 8)
      | (this.#bytes[this.#offset + 2] << 16)
      | (this.#bytes[this.#offset + 3] << 24)
    ) >>> 0;
    this.#offset += 4;
    return value;
  }

  bytes(length: number, context: string): Uint8Array {
    this.#ensure(length, context);
    if (length === 0) return EMPTY_BYTES;
    const value = this.#bytes.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return value;
  }

  #ensure(length: number, context: string): void {
    if (this.#offset + length > this.#bytes.byteLength) {
      throw this.#invalid(`VPK tree is truncated while reading ${context}.`);
    }
  }
}
