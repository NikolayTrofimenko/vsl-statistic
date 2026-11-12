/**
 * Watched-seconds bitmaps.
 *
 * Bit N (LSB-first within each byte) is set when the viewer actually played
 * through second N of the video. Unlike `currentTime`, this survives seeking:
 * jumping to the end sets no bits in between, rewinding re-sets ones already
 * set. 1 bit per second keeps a 50-minute VSL at ~375 bytes.
 */

/** Longest video we keep bits for — 4 hours. */
export const MAX_SECONDS = 4 * 60 * 60;

export function decodeBits(base64: string): Uint8Array {
  const buf = Buffer.from(base64, 'base64');
  return new Uint8Array(buf.subarray(0, Math.ceil(MAX_SECONDS / 8)));
}

/** Bitwise OR, sized to the longer input. */
export function mergeBits(a: Uint8Array | null, b: Uint8Array): Uint8Array {
  if (!a || a.length === 0) return b;
  const out = new Uint8Array(Math.max(a.length, b.length));
  out.set(a);
  for (let i = 0; i < b.length; i++) out[i]! |= b[i]!;
  return out;
}

const POPCOUNT = new Uint8Array(256).map((_, i) => {
  let n = 0;
  for (let v = i; v; v >>= 1) n += v & 1;
  return n;
});

export function countBits(bits: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < bits.length; i++) n += POPCOUNT[bits[i]!]!;
  return n;
}

export function hasBit(bits: Uint8Array, sec: number): boolean {
  const byte = sec >> 3;
  return byte < bits.length && (bits[byte]! & (1 << (sec & 7))) !== 0;
}

/** Add 1 to `counts[sec]` for every set bit below `counts.length`. */
export function accumulate(bits: Uint8Array, counts: Uint32Array): void {
  const limit = Math.min(bits.length, Math.ceil(counts.length / 8));
  for (let byte = 0; byte < limit; byte++) {
    let v = bits[byte]!;
    if (!v) continue;
    const base = byte << 3;
    for (let bit = 0; v; bit++, v >>= 1) {
      if (v & 1 && base + bit < counts.length) counts[base + bit]!++;
    }
  }
}
