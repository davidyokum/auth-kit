/**
 * Signing a persona in for real, and enrolling it in an authenticator.
 *
 * `AdminInitiateAuth` with `ADMIN_USER_PASSWORD_AUTH` exists only on sandbox app clients (the preset
 * adds it there and nowhere else). Personas are password users, and the standard requires an
 * authenticator of password users, so each persona is enrolled in TOTP and answers Cognito's code
 * challenge with a code computed from its secret, exactly as a person with an authenticator app
 * would. The tokens that come back are real, so every server check runs as in production.
 */
import {
  AdminInitiateAuthCommand,
  type AdminInitiateAuthCommandOutput,
  AdminRespondToAuthChallengeCommand,
  AdminSetUserMFAPreferenceCommand,
  AssociateSoftwareTokenCommand,
  type AuthenticationResultType,
  type CognitoIdentityProviderClient,
  VerifySoftwareTokenCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { decodeJwtPayload, stringClaim } from './jwt.js';
import { TOTP_STEP_SECONDS, totpCode, totpStep } from './totp.js';

export type PersonaSignInErrorCode =
  | 'wrong_password'
  | 'user_disabled'
  | 'flow_not_enabled'
  | 'needs_totp_secret'
  | 'needs_mfa_setup'
  | 'needs_seed'
  | 'totp_rejected'
  | 'unsupported_challenge'
  | 'aws_error';

const HINTS: Record<PersonaSignInErrorCode, string> = {
  wrong_password: "the password in .env.local doesn't match the pool. Run `npx auth-kit seed-personas` again.",
  user_disabled: 'the persona is disabled in the pool. Run `npx auth-kit seed-personas` again.',
  flow_not_enabled:
    "the app client doesn't allow ADMIN_USER_PASSWORD_AUTH. The preset enables it only on sandbox clients: is this pool a sandbox deployed with applyAuthStandard?",
  needs_totp_secret: 'the persona has an authenticator but .env.local has no PERSONA_TOTP_ secret for it. Run `npx auth-kit seed-personas` again.',
  needs_mfa_setup: 'the pool requires an authenticator and the persona has none. Run `npx auth-kit seed-personas` again.',
  needs_seed: 'the persona still has a temporary password. Run `npx auth-kit seed-personas` again.',
  totp_rejected: 'Cognito rejected the authenticator code twice. Check the computer clock, or run `npx auth-kit seed-personas` again.',
  unsupported_challenge: "Cognito asked for a step the dev kit doesn't answer.",
  aws_error: 'AWS refused the call.',
};

export class PersonaSignInError extends Error {
  readonly code: PersonaSignInErrorCode;
  constructor(code: PersonaSignInErrorCode, detail?: string, options?: { cause?: unknown }) {
    super(`auth-kit: persona sign-in failed: ${HINTS[code]}${detail ? ` (${detail})` : ''}`, options);
    this.name = 'PersonaSignInError';
    this.code = code;
  }
}

export interface PersonaAuthContext {
  client: CognitoIdentityProviderClient;
  userPoolId: string;
  clientId: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PersonaTokens {
  accessToken: string;
  idToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  /** The pool's own username for the persona (the access token's `username` claim). */
  username: string;
}

// ---- Shared state: codes already used, and one sign-in at a time per persona --------------------

interface SharedState {
  usedSteps: Map<string, number>;
  locks: Map<string, Promise<void>>;
}
const STATE = Symbol.for('auth-kit.dev.persona-auth');
function shared(): SharedState {
  const g = globalThis as { [STATE]?: SharedState };
  return (g[STATE] ??= { usedSteps: new Map(), locks: new Map() });
}

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const { locks } = shared();
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => mine);
  locks.set(key, chained);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === chained) locks.delete(key);
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The time step to answer with. Cognito won't accept a code twice, so if this step's code was
 * already used (a second click within 30 seconds), wait for the next step instead of reusing it.
 */
async function usableStep(key: string, now: () => number, sleep: (ms: number) => Promise<void>): Promise<number> {
  const current = totpStep(now());
  const last = shared().usedSteps.get(key);
  if (last === undefined || last < current) return current;
  const target = last + 1;
  const waitMs = target * TOTP_STEP_SECONDS * 1000 - now() + 250;
  if (waitMs > 0) await sleep(waitMs);
  return target;
}

function markUsed(key: string, step: number): void {
  const { usedSteps } = shared();
  usedSteps.set(key, Math.max(step, usedSteps.get(key) ?? step));
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

function mapError(error: unknown): PersonaSignInError {
  if (error instanceof PersonaSignInError) return error;
  const name = errorName(error);
  const message = error instanceof Error ? error.message : String(error);
  if (/flow not enabled/i.test(message)) return new PersonaSignInError('flow_not_enabled', `${name}: ${message}`, { cause: error });
  if (name === 'NotAuthorizedException' && /disabled/i.test(message)) return new PersonaSignInError('user_disabled', undefined, { cause: error });
  if (name === 'NotAuthorizedException' || name === 'UserNotFoundException') {
    return new PersonaSignInError('wrong_password', undefined, { cause: error });
  }
  if (name === 'PasswordResetRequiredException') return new PersonaSignInError('needs_seed', undefined, { cause: error });
  return new PersonaSignInError('aws_error', `${name || 'Error'}: ${message}`, { cause: error });
}

function isCodeRejection(error: unknown): boolean {
  const name = errorName(error);
  return name === 'CodeMismatchException' || name === 'ExpiredCodeException';
}

function tokensFrom(result: AuthenticationResultType): PersonaTokens {
  if (!result.AccessToken) throw new PersonaSignInError('aws_error', 'Cognito returned no access token');
  const username = stringClaim(decodeJwtPayload(result.AccessToken), 'username');
  if (!username) throw new PersonaSignInError('aws_error', 'the access token has no username claim');
  return {
    accessToken: result.AccessToken,
    ...(result.IdToken !== undefined && { idToken: result.IdToken }),
    ...(result.RefreshToken !== undefined && { refreshToken: result.RefreshToken }),
    ...(result.ExpiresIn !== undefined && { expiresIn: result.ExpiresIn }),
    username,
  };
}

function initiate(ctx: PersonaAuthContext, email: string, password: string): Promise<AdminInitiateAuthCommandOutput> {
  return ctx.client.send(
    new AdminInitiateAuthCommand({
      UserPoolId: ctx.userPoolId,
      ClientId: ctx.clientId,
      AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }),
  );
}

export interface SignInPersonaInput extends PersonaAuthContext {
  email: string;
  password: string;
  totpSecret?: string;
}

/** Signs a persona in and returns real tokens. Throws `PersonaSignInError` with a fix in its message. */
export async function signInPersona(input: SignInPersonaInput): Promise<PersonaTokens> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? defaultSleep;
  const key = `${input.userPoolId}|${input.email}`;
  return withLock(key, async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      let out: { ChallengeName?: string; Session?: string; ChallengeParameters?: Record<string, string>; AuthenticationResult?: AuthenticationResultType };
      try {
        out = await initiate(input, input.email, input.password);
        if (out.AuthenticationResult) return tokensFrom(out.AuthenticationResult);
        const username = out.ChallengeParameters?.USERNAME ?? input.email;
        if (out.ChallengeName === 'SELECT_MFA_TYPE') {
          out = await input.client.send(
            new AdminRespondToAuthChallengeCommand({
              UserPoolId: input.userPoolId,
              ClientId: input.clientId,
              ChallengeName: 'SELECT_MFA_TYPE',
              Session: out.Session,
              ChallengeResponses: { USERNAME: username, ANSWER: 'SOFTWARE_TOKEN_MFA' },
            }),
          );
          if (out.AuthenticationResult) return tokensFrom(out.AuthenticationResult);
        }
        if (out.ChallengeName === 'MFA_SETUP') throw new PersonaSignInError('needs_mfa_setup');
        if (out.ChallengeName === 'NEW_PASSWORD_REQUIRED') throw new PersonaSignInError('needs_seed');
        if (out.ChallengeName !== 'SOFTWARE_TOKEN_MFA') throw new PersonaSignInError('unsupported_challenge', out.ChallengeName ?? 'no challenge name');
        if (!input.totpSecret) throw new PersonaSignInError('needs_totp_secret');
      } catch (error) {
        throw mapError(error);
      }

      const step = await usableStep(key, now, sleep);
      try {
        const answer = await input.client.send(
          new AdminRespondToAuthChallengeCommand({
            UserPoolId: input.userPoolId,
            ClientId: input.clientId,
            ChallengeName: 'SOFTWARE_TOKEN_MFA',
            Session: out.Session,
            ChallengeResponses: {
              USERNAME: out.ChallengeParameters?.USERNAME ?? input.email,
              SOFTWARE_TOKEN_MFA_CODE: totpCode(input.totpSecret, step),
            },
          }),
        );
        markUsed(key, step);
        if (answer.AuthenticationResult) return tokensFrom(answer.AuthenticationResult);
        throw new PersonaSignInError('unsupported_challenge', answer.ChallengeName ?? 'no challenge name');
      } catch (error) {
        if (isCodeRejection(error)) {
          // Possibly reused in this window by another process (the seed script): try the next one.
          markUsed(key, step);
          continue;
        }
        throw mapError(error);
      }
    }
    throw new PersonaSignInError('totp_rejected');
  });
}

export interface EnrollTotpInput extends PersonaAuthContext {
  email: string;
  password: string;
}

/**
 * Gives a persona a new authenticator and returns its secret. Works whether the pool makes MFA
 * optional (enroll with the access token) or required (answer `MFA_SETUP`). A persona already
 * enrolled with a secret nobody kept has its authenticator switched off first, then re-enrolled.
 */
export async function enrollPersonaTotp(input: EnrollTotpInput): Promise<{ secret: string; username: string }> {
  const now = input.now ?? Date.now;
  const key = `${input.userPoolId}|${input.email}`;
  const preference = (username: string, enabled: boolean) =>
    input.client.send(
      new AdminSetUserMFAPreferenceCommand({
        UserPoolId: input.userPoolId,
        Username: username,
        SoftwareTokenMfaSettings: { Enabled: enabled, PreferredMfa: enabled },
      }),
    );

  return withLock(key, async () => {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const init = await initiate(input, input.email, input.password);
        const challengeUser = init.ChallengeParameters?.USERNAME ?? input.email;

        if (init.AuthenticationResult) {
          const accessToken = init.AuthenticationResult.AccessToken;
          if (!accessToken) throw new PersonaSignInError('aws_error', 'Cognito returned no access token');
          const username = tokensFrom(init.AuthenticationResult).username;
          const { SecretCode: secret } = await input.client.send(new AssociateSoftwareTokenCommand({ AccessToken: accessToken }));
          if (!secret) throw new PersonaSignInError('aws_error', 'AssociateSoftwareToken returned no secret');
          const step = totpStep(now());
          const verified = await input.client.send(
            new VerifySoftwareTokenCommand({ AccessToken: accessToken, UserCode: totpCode(secret, step), FriendlyDeviceName: 'auth-kit persona' }),
          );
          if (verified.Status !== 'SUCCESS') throw new PersonaSignInError('aws_error', `VerifySoftwareToken: ${verified.Status ?? 'no status'}`);
          markUsed(key, step);
          await preference(username, true);
          return { secret, username };
        }

        if (init.ChallengeName === 'MFA_SETUP') {
          const associated = await input.client.send(new AssociateSoftwareTokenCommand({ Session: init.Session }));
          const secret = associated.SecretCode;
          if (!secret) throw new PersonaSignInError('aws_error', 'AssociateSoftwareToken returned no secret');
          const step = totpStep(now());
          const verified = await input.client.send(
            new VerifySoftwareTokenCommand({ Session: associated.Session, UserCode: totpCode(secret, step), FriendlyDeviceName: 'auth-kit persona' }),
          );
          if (verified.Status !== 'SUCCESS') throw new PersonaSignInError('aws_error', `VerifySoftwareToken: ${verified.Status ?? 'no status'}`);
          markUsed(key, step);
          const done = await input.client.send(
            new AdminRespondToAuthChallengeCommand({
              UserPoolId: input.userPoolId,
              ClientId: input.clientId,
              ChallengeName: 'MFA_SETUP',
              Session: verified.Session,
              ChallengeResponses: { USERNAME: challengeUser },
            }),
          );
          const username = done.AuthenticationResult ? tokensFrom(done.AuthenticationResult).username : challengeUser;
          await preference(username, true);
          return { secret, username };
        }

        if (init.ChallengeName === 'SOFTWARE_TOKEN_MFA' || init.ChallengeName === 'SELECT_MFA_TYPE') {
          // Enrolled with a secret that isn't in .env.local: switch it off, then enroll again.
          await preference(challengeUser, false);
          continue;
        }
        if (init.ChallengeName === 'NEW_PASSWORD_REQUIRED') throw new PersonaSignInError('needs_seed');
        throw new PersonaSignInError('unsupported_challenge', init.ChallengeName ?? 'no challenge name');
      }
      throw new PersonaSignInError('aws_error', "the persona still asked for its old authenticator after it was switched off");
    } catch (error) {
      throw mapError(error);
    }
  });
}

/** Forgets which authenticator codes were used (tests). */
export function resetPersonaAuthState(): void {
  const s = shared();
  s.usedSteps.clear();
  s.locks.clear();
}
