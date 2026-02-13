/** Constant-time string comparison to prevent timing attacks. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.length !== bufB.length) return false;
  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}

/** Check if value matches any item in a comma-separated list (constant-time per item). */
export function includesSafe(list, value) {
  const items = list.split(',').map(t => t.trim());
  let found = false;
  for (const item of items) {
    if (safeEqual(item, value)) found = true;
  }
  return found;
}
