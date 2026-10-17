/**
 * Authenticator (TOTP) setup details. auth-kit builds the `otpauth://` link itself: Amplify's
 * `getSetupUri` doesn't encode its inputs, and `setUpTOTP` defaults the account label to the Cognito
 * username (a UUID in email-login pools), which tells nobody which account it is.
 */

/** The Key URI Format link authenticator apps and password managers open (`otpauth://totp/...`). */
export function buildOtpauthUri(input: { secret: string; issuer: string; accountName?: string }): string {
  const issuer = input.issuer.replace(/:/g, '').trim() || 'Sign-in';
  const label = input.accountName ? `${encodeURIComponent(issuer)}:${encodeURIComponent(input.accountName)}` : encodeURIComponent(issuer);
  const params = new URLSearchParams({ secret: input.secret.replace(/\s/g, ''), issuer });
  return `otpauth://totp/${label}?${params.toString().replace(/\+/g, '%20')}`;
}

/** Groups a setup key in fours so it's readable when typed by hand. */
export function formatSetupKey(secret: string): string {
  return (secret.replace(/\s/g, '').match(/.{1,4}/g) ?? []).join(' ');
}
