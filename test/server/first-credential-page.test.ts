/**
 * The page guards send an account with only emailed codes to the chooser (M2, register A1): the
 * redirect a page gets for 403 first_credential_required.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const redirect = vi.fn((url: string) => {
  throw Object.assign(new Error(`NEXT_REDIRECT ${url}`), { digest: `NEXT_REDIRECT;${url}` });
});
vi.mock('next/navigation.js', () => ({ redirect, notFound: vi.fn(), forbidden: vi.fn() }));

const { FirstCredentialRequiredError, MfaEnrollmentRequiredError, handlePageAuthError } = await import('../../src/server/index.js');

afterEach(() => redirect.mockClear());

describe('page guards and the first credential (M2)', () => {
  it('redirect an account with only emailed codes to the chooser, by default /account/sign-in-method', async () => {
    await expect(handlePageAuthError(new FirstCredentialRequiredError())).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirect).toHaveBeenCalledWith('/account/sign-in-method');
  });

  it('use the site’s chooser path, made safe', async () => {
    await expect(handlePageAuthError(new FirstCredentialRequiredError(), { firstCredentialPath: '/welcome/choose' })).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirect).toHaveBeenLastCalledWith('/welcome/choose');
    await expect(handlePageAuthError(new FirstCredentialRequiredError(), { firstCredentialPath: 'https://evil.example/' })).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirect).toHaveBeenLastCalledWith('/account/sign-in-method');
  });

  it('keep the authenticator page for a password user without TOTP', async () => {
    await expect(handlePageAuthError(new MfaEnrollmentRequiredError())).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirect).toHaveBeenLastCalledWith('/account/authenticator');
  });
});
