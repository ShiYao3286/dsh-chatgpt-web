/**
 * SHA3-512 (Keccak-f[1600]) — 纯 BigInt 实现。
 *
 * 为什么要自己写：ChatGPT 网页端 PoW 用 SHA3-512，而 Node 的 crypto 只提供
 * 'sha3-512'（OpenSSL 支持），但**要在浏览器页面上下文里跑**（请求必须由真实页面发出，
 * 指纹才对得上），页面里没有 node:crypto。所以用纯 JS 实现，两端共用同一份。
 *
 * 自检向量：SHA3-512("abc") = b751850b1a57168a5693cd924b6b096e...
 * 见 tests/check-sha3.mjs。
 */

const MASK = (1n << 64n) - 1n;

const RC: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

const RHO: number[][] = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

function rotl(v: bigint, n: number): bigint {
  if (n === 0) return v & MASK;
  const b = BigInt(n);
  return ((v << b) | (v >> (64n - b))) & MASK;
}

function keccakF(A: bigint[]): void {
  const C = new Array<bigint>(5);
  const B = new Array<bigint>(25);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) {
      C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      const d = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) A[x + y] ^= d;
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], RHO[x][y]);
      }
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const i = x + 5 * y;
        A[i] = B[i] ^ ((~B[(x + 1) % 5 + 5 * y] & MASK) & B[(x + 2) % 5 + 5 * y]);
      }
    }
    A[0] ^= RC[round];
  }
}

/** SHA3-512 摘要，返回 64 字节。 */
export function sha3_512(bytes: Uint8Array): Uint8Array {
  const RATE = 72;
  const S = new Array<bigint>(25).fill(0n);
  const padLen = RATE - (bytes.length % RATE);
  const padded = new Uint8Array(bytes.length + padLen);
  padded.set(bytes);
  padded[bytes.length] ^= 0x06;
  padded[padded.length - 1] ^= 0x80;
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let b = 0; b < 8; b++) {
        lane |= BigInt(padded[off + i * 8 + b]) << BigInt(8 * b);
      }
      S[i] ^= lane;
    }
    keccakF(S);
  }
  const out = new Uint8Array(64);
  for (let i = 0; i < 8; i++) {
    let lane = S[i];
    for (let b = 0; b < 8; b++) {
      out[i * 8 + b] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

export function utf8(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
