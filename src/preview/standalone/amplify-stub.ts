/**
 * What the standalone preview bundle has instead of Amplify (ADR 0025): every name the card imports from
 * `aws-amplify`, each refusing. The preview's driver never calls them; with this, the bundle has no
 * Amplify code at all, so nothing in it can reach Cognito.
 */

function refused(): never {
  throw new Error('auth-kit preview: no Amplify (preview mode makes no Cognito calls)');
}

export const Amplify = Object.freeze({ configure: refused, getConfig: refused });
export const cognitoUserPoolsTokenProvider = Object.freeze({ setKeyValueStorage: refused });
export class CookieStorage {
  constructor() {
    refused();
  }
}
export const associateWebAuthnCredential = refused;
export const confirmResetPassword = refused;
export const confirmSignIn = refused;
export const deleteWebAuthnCredential = refused;
export const fetchAuthSession = refused;
export const fetchMFAPreference = refused;
export const fetchUserAttributes = refused;
export const getCurrentUser = refused;
export const listWebAuthnCredentials = refused;
export const resetPassword = refused;
export const setUpTOTP = refused;
export const signIn = refused;
export const signOut = refused;
export const updateMFAPreference = refused;
export const updatePassword = refused;
export const updateUserAttributes = refused;
export const verifyTOTPSetup = refused;
