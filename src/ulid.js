/**
 * Minimal ULID generator — zero dependencies.
 * Time-sortable, 26 chars, Crockford Base32.
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(now, len) {
  let str = '';
  for (let i = len; i > 0; i--) {
    str = ENCODING[now % 32] + str;
    now = Math.floor(now / 32);
  }
  return str;
}

function encodeRandom(len) {
  let str = '';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  for (let i = 0; i < len; i++) {
    str += ENCODING[bytes[i] % 32];
  }
  return str;
}

export function ulid() {
  return encodeTime(Date.now(), 10) + encodeRandom(16);
}
