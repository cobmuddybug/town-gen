// Seeded randomness. Every stream is derived from a string key, so the order
// in which entities are generated never changes what any of them get.
//
// The generator is SFC32 (Chris Doty-Humphrey's Small Fast Counting RNG, from
// PractRand, public domain). The string hash below is our own: four FNV-1a
// lanes with different offsets, each finished with the murmur3 32-bit mixer.

function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function hash128(s: string): [number, number, number, number] {
  let a = 0x811c9dc5, b = 0x050c5d1f, c = 0x6c62272e, d = 0x2f2ad3b5;
  for (let i = 0; i < s.length; i++) {
    const k = s.charCodeAt(i);
    a = Math.imul(a ^ k, 0x01000193);
    b = Math.imul(b ^ k, 0x01000193) + i;
    c = Math.imul(c ^ (k + 0x9e), 0x01000193);
    d = Math.imul(d ^ k, 0x01000193) ^ (i << 7);
  }
  return [fmix32(a ^ s.length), fmix32(b + a), fmix32(c ^ b), fmix32(d + c)];
}

export function hashHex(s: string, chars = 4): string {
  return hash128(s)[0].toString(16).padStart(8, "0").slice(0, chars);
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(key: string) {
    [this.a, this.b, this.c, this.d] = hash128(key);
    for (let i = 0; i < 12; i++) this.u32();
  }

  u32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.u32() / 4294967296;
  }

  /** Uniform float in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** Uniform integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick from empty list");
    return items[Math.floor(this.next() * items.length)];
  }

  weighted<T>(items: readonly T[], weight: (t: T) => number): T {
    // Each weight is worked out once: some are dear (a clash check, a phrase agreed with its subject).
    const ws = new Array<number>(items.length);
    let total = 0;
    for (let i = 0; i < items.length; i++) total += ws[i] = Math.max(0, weight(items[i]));
    if (total <= 0) return this.pick(items);
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= ws[i];
      if (r < 0) return items[i];
    }
    return items[items.length - 1];
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  /** Roughly normal (sum of three uniforms), mean 0, sd ~1. */
  gauss(): number {
    return (this.next() + this.next() + this.next() - 1.5) * 2;
  }
}
