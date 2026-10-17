import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, totpCode, totpStep } from '../../src/dev/index.js';

// RFC 6238 Appendix B, SHA-1, secret "12345678901234567890", truncated to 6 digits.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP (RFC 6238)', () => {
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ])('T=%i -> %s', (seconds, code) => {
    expect(totpCode(RFC_SECRET, totpStep(seconds * 1000))).toBe(code);
  });

  it('round-trips base32 and ignores case, spaces, and padding', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq====').toString()).toBe('12345678901234567890');
    expect(() => base32Decode('not base32!')).toThrow(/base32/);
  });
});
