/**
 * What the standalone preview bundle has instead of `src/client/api.ts` (ADR 0025): the live driver's
 * Amplify calls, each refusing. With it, neither Amplify nor the direct Cognito calls (`cognito.ts`) are
 * in the file at all. The preview's driver never calls these.
 */
import type { AuthenticatorEnrollment } from '../../client/api.js';
import type { ClientAuthFactors } from '../../client/ladder.js';
import type { SignInStep } from '../../client/steps.js';

export type { AuthenticatorEnrollment };

function refused(): Promise<never> {
  return Promise.reject(new Error('auth-kit preview: no Cognito calls'));
}

export const signInWithPasskey: (email: string) => Promise<SignInStep> = refused;
export const signInWithPassword: (email: string, password: string) => Promise<SignInStep> = refused;
export const requestEmailCode: (email: string) => Promise<SignInStep> = refused;
export const confirmPassword: (password: string) => Promise<SignInStep> = refused;
export const confirmCode: (code: string) => Promise<SignInStep> = refused;
export const completeNewPassword: (password: string) => Promise<SignInStep> = refused;
export const requestPasswordReset: (email: string) => Promise<{ destination?: string }> = refused;
export const confirmPasswordReset: (email: string, code: string, newPassword: string) => Promise<void> = refused;
export const currentUser: () => Promise<{ userId: string; loginId?: string } | null> = refused;
export const fetchAuthFactors: () => Promise<ClientAuthFactors> = refused;
export const registerPasskey: () => Promise<void> = refused;
export const setFirstPassword: (password: string) => Promise<void> = refused;
export const enrollAuthenticator: (input: { issuer: string; accountName?: string; deviceName?: string }) => Promise<AuthenticatorEnrollment> = refused;
export const fetchAccountEmail: () => Promise<string | undefined> = refused;
export const saveName: (input: { givenName: string; familyName: string }) => Promise<void> = refused;
