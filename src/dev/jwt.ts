/**
 * Reads a JWT's claims without verifying it. Only for display and cookie naming in the dev kit:
 * every token the app trusts is verified by `auth-kit/server`.
 */
export function decodeJwtPayload(token: string | undefined): Record<string, unknown> | undefined {
  const part = token?.split('.')[1];
  if (!part) return undefined;
  try {
    const json: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** A string claim, or undefined. */
export function stringClaim(claims: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = claims?.[name];
  return typeof value === 'string' ? value : undefined;
}
