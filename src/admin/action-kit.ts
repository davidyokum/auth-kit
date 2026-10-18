/**
 * Pieces every audited server action shares (the People actions and the resource access actions):
 * input checks for untrusted input, the failure shape, how auth errors read on screen, and the
 * request context the audit log records. Internal: not a public export.
 */
import { nextHeadersContext } from '../server/context.js';
import {
  AuthUnavailableError,
  ForbiddenError,
  MfaEnrollmentRequiredError,
  NotFoundError,
  StepUpRequiredError,
  UnauthenticatedError,
} from '../server/errors.js';
import type { ActionResult, AuditRequestContext } from './types.js';

// ---- Input checks (server actions receive untrusted input) -----------------------------------

const SUB_RE = /^[A-Za-z0-9-]{1,128}$/;
const EMAIL_RE = /^[^\s@"\\<>(),;:[\]]+@[^\s@"\\<>(),;:[\]]+\.[^\s@"\\<>(),;:[\]]+$/;

export class InputError extends Error {}

export function record(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new InputError('Expected an object.');
  return input as Record<string, unknown>;
}

/** Trims and drops control characters. */
export function text(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new InputError(`${field} must be text.`);
  const clean = [...value]
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c >= 32 && c !== 127;
    })
    .join('')
    .trim();
  if (clean.length > max) throw new InputError(`${field} is too long (at most ${max} characters).`);
  return clean === '' ? undefined : clean;
}

export function subOf(value: unknown): string {
  if (typeof value !== 'string' || !SUB_RE.test(value)) throw new InputError('That person ID is invalid.');
  return value;
}

export function emailOf(value: unknown): string {
  const email = text(value, 'Email', 254)?.toLowerCase();
  if (!email || !EMAIL_RE.test(email)) throw new InputError('Enter a full email address.');
  return email;
}

/** A checkbox, a boolean, or the string "true". */
export function checked(value: unknown): boolean {
  return value === true || value === 'on' || value === 'true';
}

/** True when the address is outside the usual invite domains (an empty list means "no list"). */
export function outsideDomains(email: string, domains: readonly string[]): boolean {
  const domain = email.slice(email.lastIndexOf('@') + 1);
  return domains.length > 0 && !domains.includes(domain);
}

// ---- Results ------------------------------------------------------------------------------------

export type Fail = Extract<ActionResult, { ok: false }>;

export function fail(code: Fail['code'], error: string, extra: Partial<Omit<Fail, 'ok' | 'code' | 'error'>> = {}): Fail {
  return { ok: false, code, error, changed: 'nothing', ...extra };
}

/** An auth error as the screen says it, or null for anything else. */
export function authFailure(error: unknown): Fail | null {
  if (error instanceof StepUpRequiredError) {
    return fail('step_up_required', 'Please sign in again to confirm this action.', { maxAgeSeconds: error.maxAgeSeconds });
  }
  if (error instanceof MfaEnrollmentRequiredError) return fail('forbidden', error.message);
  if (error instanceof UnauthenticatedError) return fail('unauthenticated', error.message);
  if (error instanceof ForbiddenError) return fail('forbidden', error.message);
  if (error instanceof NotFoundError) return fail('not_found', error.message);
  if (error instanceof AuthUnavailableError) return fail('unavailable', error.message);
  return null;
}

// ---- Request context ----------------------------------------------------------------------------

export async function defaultRequestContext(): Promise<AuditRequestContext> {
  try {
    const { headers } = await nextHeadersContext();
    const ip = headers.get('x-forwarded-for') ?? headers.get('x-real-ip') ?? undefined;
    const userAgent = headers.get('user-agent') ?? undefined;
    const requestId = headers.get('x-amzn-trace-id') ?? headers.get('x-request-id') ?? undefined;
    return { ...(ip && { ip }), ...(userAgent && { userAgent }), ...(requestId && { requestId }) };
  } catch {
    return {};
  }
}

/** The audit row's `requestId` and `context` from a request context. */
export function contextOf(request: AuditRequestContext): { requestId?: string; context?: { ip?: string; userAgent?: string } } {
  return {
    ...(request.requestId !== undefined && { requestId: request.requestId }),
    ...((request.ip ?? request.userAgent) !== undefined && {
      context: { ...(request.ip !== undefined && { ip: request.ip }), ...(request.userAgent !== undefined && { userAgent: request.userAgent }) },
    }),
  };
}
