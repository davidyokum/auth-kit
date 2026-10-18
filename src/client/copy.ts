/**
 * Every word on the sign-in, sign-up, request, and help screens (REPORT §4, Card Studio v4; ADR
 * 0024), in one place so the screens can't drift from the approved copy and tests can read it. Pure:
 * no React. The same on every site except the placeholders: the site's name, the address typed, the
 * code lifetime, and the family's help route (who's named, the help mailbox, the IT desk).
 *
 * House style: the Oxford comma in every series (register P8); clock times; second person; no blame.
 * Field errors are imperatives without a full stop ("Enter your email address"), as GOV.UK writes them.
 */
import type { AuthTheme } from '../themes/index.js';

/** What the words depend on. */
export interface CopyContext {
  siteName: string;
  theme: AuthTheme;
  /** The emailed code's lifetime (the pool's sign-in session). */
  codeLifetimeMinutes: number;
  /** The help mailbox in effect (the family's, the site's, or a Super admin's override). */
  helpAddress: string;
  /** The person who looks after the site, named when the family names owners (`theme.help.named`). */
  ownerName?: string;
}

/** "Jordan Lee", or "the Example Reports team" (Card Studio's `team`). */
export function team(c: CopyContext): string {
  return c.theme.help.named && c.ownerName ? c.ownerName : `the ${c.siteName} team`;
}

/** The same, at the start of a sentence (Card Studio's `Team`). */
export function Team(c: CopyContext): string {
  const t = team(c);
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const minutes = (c: CopyContext) => `${c.codeLifetimeMinutes} minutes`;

/** A line with emphasized parts: strings, and `{ strong }` for words to stress (the links named in steps). */
export type Rich = readonly (string | { strong: string })[];

/** Plain text of a rich line (for tests and screen-reader-only text). */
export function plain(line: Rich): string {
  return line.map((p) => (typeof p === 'string' ? p : p.strong)).join('');
}

// ---- Sign in ---------------------------------------------------------------------------------------

export const SIGN_IN = {
  heading: (c: CopyContext) => `Sign in to ${c.siteName}`,
  reauthHeading: 'Confirm it’s you',
  reauthNote: 'For your security, sign in again to continue.',
  emailLabel: 'Email address',
  continue: 'Continue',
  signIn: 'Sign in',
  tryAgain: 'Try again',
  change: 'Change',
  usePassword: 'Use a password instead',
  emailCode: 'Email me a code instead',
  usePasskey: 'Use a passkey instead',
  sendNewCode: 'Send a new code',
  differentEmail: 'Use a different email address',
  forgotPassword: 'Forgot your password?',
  lostAuthenticator: 'Lost your authenticator app?',
  trouble: 'Trouble signing in?',
  backToSignIn: 'Back to sign in',
  back: 'Back',
  startAgain: 'Start again',

  passkeyHeading: 'Use your passkey',
  passkeySub: 'Confirm with your face, fingerprint, or device PIN when your browser asks.',
  signingInAs: 'Signing in as',
  waitingForPasskey: 'Waiting for your passkey…',
  passkeyOnPhone: 'Passkey on your phone? Choose the phone option in the window that opens.',

  passwordHeading: 'Enter your password',
  passwordFor: 'for',
  passwordLabel: 'Password',
  show: 'Show',
  hide: 'Hide',

  totpHeading: 'Enter your authenticator code',
  totpSub: (c: CopyContext) => `Open your authenticator app or password manager and enter the 6-digit code for ${c.siteName}.`,
  totpLabel: '6-digit code',

  codeHeading: 'Check your email',
  codeSub: (c: CopyContext, email: string) => `If ${email} has an account here, we’ve emailed it an 8-digit code. It works for ${minutes(c)}.`,
  codeLabel: '8-digit code',
  codeResent: (at: string) => `We sent a new code at ${at}. Use the newest one.`,
  codeHelp: 'No email after a minute? Check your junk folder, then send a new code. Accounts with an authenticator app can’t get emailed codes. Use your password or passkey instead.',

  newPasswordHeading: 'Choose a new password',
  newPasswordIntro: 'Your temporary password worked. Now choose your own.',

  resetCodeHeading: 'Check your email',
  resetCodeSub: (email: string) => `If ${email} has an account here, we’ve emailed it a code to reset your password. It works for 1 hour.`,
  resetCodeLabel: 'Reset code',
  resetAfter: 'Next, you’ll enter your authenticator code as usual.',

  finishing: 'Signing you in…',
  signedInOneMoment: 'Signed in. One moment…',

  mustChooseNewPassword: 'You need to choose a new password before signing in. We can email you a code to do that.',

  offerPasskeyHeading: 'Create a passkey on this device?',
  offerPasskeySub: 'Next time, sign in with your face, fingerprint, or device PIN. Nothing to remember or type.',
  notNow: 'Not now',
} as const;

/** The card's account-creation line (Card Studio's ACCESSLINE; register D1). */
export const ACCESS_LINE = {
  request: 'Need access? Request it.',
  newHere: 'New here?',
  createAccount: 'Create an account',
  inviteOnly: (c: CopyContext) => `New to ${c.siteName}? It’s invite-only.`,
  needAccess: 'Need access?',
  askToBeAdded: 'Ask the person who runs it to add you.',
} as const;

// ---- First visit: choose, create, add, done ---------------------------------------------------

export const FIRST_VISIT = {
  chooseHeading: 'Choose how you’ll sign in next time',
  chooseSub: 'A passkey is quickest. You can add another way later under My account.',
  passkeyOption: 'Passkey',
  recommended: '(recommended)',
  passkeyOptionText: 'Use your face, fingerprint, or device PIN. Nothing to remember or type.',
  createPasskey: 'Create a passkey',
  passwordOption: 'Password and authenticator app',
  passwordOptionText: 'A password plus a 6-digit code from an app like Microsoft Authenticator or your password manager.',
  sharedComputer: 'Don’t create a passkey on a shared computer.',

  createPasskeyHeading: 'Create a passkey',
  createPasskeySub: 'Confirm with your face, fingerprint, or device PIN when your browser asks. Nothing to remember or type.',
  waitingForDevice: 'Waiting for your device…',
  passkeyOnPhone: 'Want the passkey on your phone? Choose the phone option in the window that opens.',

  createPasswordHeading: 'Create a password',
  createPasswordSub: 'At least 15 characters. A few words make a good one, or let your password manager create it.',
  newPasswordLabel: 'New password',

  addTotpHeading: 'Add an authenticator app',
  addTotpSub: 'Scan the code with your app or password manager, then enter the 6-digit code it shows.',
  /** Cognito asks for an authenticator during sign-in (MFA_SETUP). */
  addTotpRequired: 'This account needs an authenticator app. Add it now to finish signing in.',
  /** The enrollment step after a password sign-in with no authenticator yet. */
  addTotpAfterPassword: 'You sign in with a password, so this site also asks for a code from an authenticator app. It only takes a minute.',
  addTotpSubNoQr: 'Add this setup key to your authenticator app or password manager, then enter the 6-digit code it shows.',
  cantScan: 'Can’t scan it? Enter this setup key in your app instead.',
  setupKeyLabel: 'Setup key',
  copy: 'Copy',
  copied: 'Setup key copied.',
  copyFailed: 'Couldn’t copy here. Select the key and copy it instead.',
  openSetupLink: 'On this device? Open the setup link.',

  doneHeading: 'You’re set up',
  donePasskey: (c: CopyContext) => `Next time, choose your passkey when you sign in to ${c.siteName}.`,
  donePassword: 'Next time, sign in with your password and a code from your authenticator app.',
  emailedNote: 'We’ve emailed you a note about this.',
  continueTo: (c: CopyContext) => `Continue to ${c.siteName}`,
} as const;

// ---- Trouble signing in (Card Studio's TRIAGE and HELP) -------------------------------------

export type HelpTopic = 'passkey' | 'password' | 'totp' | 'code' | 'email' | 'else';

export const TROUBLE = {
  heading: 'Trouble signing in?',
  sub: 'Choose what’s happening and we’ll show you what to do.',
  rows: [
    ['passkey', 'I can’t use my passkey'],
    ['password', 'I forgot my password'],
    ['totp', 'I lost my authenticator app'],
    ['code', 'I didn’t get a code'],
    ['email', 'I can’t get into my email'],
    ['else', 'Something else'],
  ] as const satisfies readonly (readonly [HelpTopic, string])[],
} as const;

/** One help screen: a heading, what to do, and the contact box (every one has it). */
export interface HelpScreen {
  heading: string;
  intro?: string;
  steps?: readonly Rich[];
  after?: string;
  /** The screen's one action, when it has one. */
  button?: { label: string; action: 'email-code' | 'reset-code' | 'resend-code' };
  /** Offer the Teams check in the contact box (OSBM). */
  teams?: boolean;
}

/** The help screens (Card Studio v4's HELP; David, 2026-10-18: the site helps only with the account on this site). */
export function helpScreen(topic: HelpTopic, c: CopyContext, options: { securityNotices?: boolean } = {}): HelpScreen {
  const itDesk = c.theme.help.itDesk;
  const site = c.siteName;
  switch (topic) {
    case 'passkey':
      return {
        heading: 'Can’t use your passkey?',
        intro: 'You can still get in with an emailed code, then make a new passkey on this device.',
        steps: [['Go back and choose ', { strong: 'Email me a code instead' }, '.'], ['Enter the 8-digit code we email you.'], ['When asked, create a new passkey.']],
        after: `Your old passkey stays on your account until you remove it under My account. If your device or browser itself isn’t working, ${itDesk} can help with that part. Use an authenticator app? Codes can’t be emailed to you, so use your password and authenticator code instead.`,
        button: { label: 'Email me a code', action: 'email-code' },
      };
    case 'password':
      return {
        heading: 'Forgot your password?',
        intro: 'We’ll email you a code so you can choose a new one.',
        steps: [['Choose ', { strong: 'Send a reset code' }, '.'], ['Enter the code from the email, then choose a new password.'], ['Enter your authenticator code as usual.']],
        // Said only where the site really sends a password-changed notice (REPORT §5.2f).
        ...(options.securityNotices === true && { after: 'We’ll email you a note when your password changes.' }),
        button: { label: 'Send a reset code', action: 'reset-code' },
      };
    case 'totp':
      return {
        heading: 'Lost your authenticator app?',
        intro: `Codes can’t be emailed to accounts that use an authenticator app, so ${team(c)} has to reset it on your ${site} account. Then you can set up a new one.`,
        steps: [
          [`Email ${c.helpAddress} from the address you sign in with, and say you’ve lost your authenticator app.`],
          [`${Team(c)} will confirm it’s you ${c.theme.help.verify}, then reset it on your account.`],
          ['Sign in with your password, then set up a new authenticator app, or a passkey instead.'],
        ],
        after: `We can reset your ${site} account, but we can’t help with the app itself. For that, try the app’s own help, or ${itDesk}. Saved a passkey? You can still sign in with it.`,
      };
    case 'code':
      return {
        heading: 'Didn’t get a code?',
        steps: [
          [`Wait a minute.${c.theme.family === 'osbm' ? ' State email screens messages, which can add a short delay.' : ''}`],
          [`Check your junk or quarantine folder for an email from ${site}.${c.theme.family === 'personal' ? '' : ` If it’s held in quarantine, ${itDesk} can release it.`}`],
          [`Send a new code and use the newest one. It works for ${minutes(c)}.`],
        ],
        after: 'Accounts with an authenticator app can’t get emailed codes. Use your password and authenticator code, or your passkey.',
        button: { label: 'Send a new code', action: 'resend-code' },
      };
    case 'email':
      return {
        heading: 'Can’t get into your email?',
        intro: `We can’t help you get back into your email. For that, contact ${itDesk}.`,
        steps: [
          [`Have your passkey, or your password and authenticator app? You can still sign in to ${site}. Go back and use one of those.`],
          [`Moved to a new email address for good? Email ${c.helpAddress} from the new address. After confirming it’s you, ${team(c)} will move your account to it.`],
        ],
      };
    case 'else':
      return {
        heading: 'Something else?',
        intro: `Email us and say what’s happening, and what you see on the screen. We can help with your ${site} account, but not with your email, device, or apps.`,
        teams: true,
      };
  }
}

/** The words every contact box shares. */
export const CONTACT = {
  /** Before the help address: "Email apps-help@…." */
  email: 'Email',
  /** "Jordan Lee looks after Example Reports.", in families that name owners. */
  looksAfter: (c: CopyContext) => (c.theme.help.named && c.ownerName ? `${c.ownerName} looks after ${c.siteName}.` : null),
  neverSend: 'Never send a password or code.',
} as const;

/** The contact box at the foot of every help screen (Card Studio v4's CONTACT). */
export function contactLines(c: CopyContext, options: { teams?: boolean } = {}): { lead: string; address: string; lines: string[] } {
  const named = CONTACT.looksAfter(c);
  return {
    lead: `Need help with your ${c.siteName} account?`,
    address: c.helpAddress,
    lines: [
      ...(named ? [named] : []),
      ...(options.teams === true && c.theme.help.teamsCheck ? [`Not sure an email is really from us? Ask ${team(c)} on Teams.`] : []),
      CONTACT.neverSend,
    ],
  };
}

/** "Need access to {Site}?" for invite-only sites with the link variant (Card Studio's scAccessHelp). */
export const ACCESS_HELP = {
  heading: (c: CopyContext) => `Need access to ${c.siteName}?`,
  sub: (c: CopyContext) => `${c.siteName} is invite-only. ${Team(c)} adds people and sends each one an email invitation.`,
  alreadyInvited: (c: CopyContext) => `Already invited? Find the email from ${c.siteName}, then sign in with the address it was sent to.`,
  askLead: 'Ask for an invitation',
} as const;

// ---- Sign-up and request access ----------------------------------------------------------------

const SHARED_OPTIONAL = '(optional)';

export const SIGN_UP = {
  heading: 'Create your account',
  openSub: 'You’ll confirm your address with a code.',
  domainHint: (list: string) => `Use your ${list} email address`,
  askForAccessInstead: 'Ask for access instead',
  privacyDomains: (c: CopyContext) => ['Privacy notice', `: what ${c.siteName} keeps about you, and why.`] as const,
  termsOpen: (c: CopyContext) => [`By creating an account you agree to the ${c.siteName} `, 'terms', ' and ', 'privacy notice', '.'] as const,
  botNote: 'Protected against automated sign-ups.',
  alreadyHaveAccount: 'Already have an account?',
  signIn: 'Sign in',

  codeHeading: 'Check your email',
  codeSub: (c: CopyContext, email: string) => `We’ve emailed ${email}. Enter the 8-digit code from that email. It works for ${minutes(c)} and confirms the address is yours.`,
  codeExisting: 'Already have an account? The email explains how to sign in instead.',
  verify: 'Verify',
  codeHelp: 'No email after a minute? Check your junk folder, then send a new code.',

  nameHeading: 'Your name',
  nameSub: (c: CopyContext) => `This is how you’ll appear on ${c.siteName}.`,
  firstName: 'First name',
  lastName: 'Last name',
  createAccount: 'Create account',
  finish: 'Finish',

  doneSub: (c: CopyContext) => `Your account starts as a member of ${c.siteName}. ${Team(c)} can give you more access if you need it.`,
  doneEmailed: 'We’ve emailed you a note about how you’ll sign in next time.',
} as const;

export const REQUEST = {
  heading: (c: CopyContext) => `Request access to ${c.siteName}`,
  sub: (c: CopyContext) => `${Team(c)} reviews requests. If they approve, you’ll get an email invitation.`,
  nameLabel: 'Name',
  reasonLabel: 'What do you need it for?',
  optional: SHARED_OPTIONAL,
  privacy: ['We use this only to decide on your request. ', 'Privacy notice'] as const,
  send: 'Send request',
  sentHeading: 'Request sent',
  sentSub: 'Thanks. If an admin approves, you’ll get an email invitation. If you already have an account, just sign in.',
} as const;

/** My account on sign-up sites (register D4, REPORT §3.1e). */
export const SELF_SERVICE = {
  changeEmail: 'Change email',
  changeEmailHeading: 'Change your email address',
  changeEmailSub: 'We’ll email a code to the new address. The change happens once you enter it.',
  newEmailLabel: 'New email address',
  sendCode: 'Send a code',
  codeLabel: 'Code from the email',
  confirm: 'Change email address',
  askAdmin: 'To change it, ask the site’s admin.',
  deleteHeading: 'Delete your account',
  deleteIntro: 'Delete your account and the access that comes with it. You can’t undo this.',
  deleteButton: 'Delete my account',
  /** Without the site's name, "Delete your account?" (never "Delete your this site account?"). */
  deleteConfirmHeading: (c: Partial<Pick<CopyContext, 'siteName'>>) => (c.siteName ? `Delete your ${c.siteName} account?` : 'Delete your account?'),
  deleteConfirmSub: 'This deletes your account and signs you out everywhere.',
  deleteConfirmLabel: 'Type your email address to confirm',
  keep: 'Keep my account',
  cancel: 'Cancel',
  signInAgain: 'Sign in again to confirm',
} as const;

export const SIGNED_OUT = {
  heading: 'You’re signed out everywhere',
  sub: (c: Pick<CopyContext, 'siteName'>) => `You’ve been signed out of ${c.siteName} on all your devices.`,
  signInAgain: 'Sign in again',
} as const;

/** My account (`MyAccount`, `PasswordForm`, `TOTPEnrollmentGate`). */
export const MY_ACCOUNT = {
  heading: 'My account',
  loading: 'Loading…',
  couldntLoad: (message: string) => `Couldn’t load this. ${message}`,
  unreachable: 'We couldn’t reach the site just now. Try again in a moment.',

  emailHeading: 'Email',
  noEmail: 'No email address on this account.',

  passkeysHeading: 'Passkeys',
  passkeysIntro: 'Sign in with Face ID, Touch ID, your device PIN, or your password manager. Nobody else can see or remove these.',
  loadingPasskeys: 'Loading your passkeys…',
  noPasskeys: 'No passkeys yet.',
  /** A passkey with no name of its own. */
  passkeyName: 'Passkey',
  addPasskey: 'Add a passkey',
  remove: 'Remove',
  removeLabel: (name: string) => `Remove ${name}`,
  removeQuestion: (name: string) => `Remove ${name}?`,
  removeConfirm: (name: string) => `Remove ${name}? You won’t be able to sign in with it.`,
  removePasskey: 'Remove passkey',
  keepIt: 'Keep it',
  cantRemove: 'This passkey can’t be removed right now.',

  authenticatorHeading: 'Authenticator app',
  setUpHeading: 'Set up your authenticator',
  replaceHeading: 'Replace your authenticator',
  nowAddHeading: 'Now add your authenticator',
  nowAddIntro: 'You sign in with a password now, so this site also asks for a code from an authenticator app.',
  totpOn: 'On. Sign-in with your password also asks for a 6-digit code from it.',
  totpOffNeeded: 'Off. You sign in with a password, so set one up now.',
  totpOff: 'Off. You only need one if you sign in with a password.',
  setUp: 'Set up authenticator',
  replace: 'Replace authenticator',
  gateChecking: 'Checking your account…',
  gateCheckFailed: (message: string) => `We couldn’t check your sign-in settings. ${message}`,
  gateIntro: (issuer: string) => `You sign in with a password, so ${issuer} also needs a code from an authenticator app. Set it up to continue.`,

  passwordHeading: 'Password',
  hasPassword: 'You have a password.',
  noPassword: 'You don’t have a password. You don’t need one if you use a passkey.',
  changePassword: 'Change password',
  changePasswordHeading: 'Change your password',
  setPassword: 'Set a password',
  setPasswordIntro: 'After this you’ll add an authenticator app: sign-in with a password always asks for its code too.',
  savePassword: 'Save password',
  currentPasswordLabel: 'Current password',
  newPasswordLabel: 'New password',
  newPasswordHint: (minLength: number) => `At least ${minLength} characters. Your password manager can make one.`,

  signOutHeading: 'Sign out everywhere',
  signOutIntro: 'Ends your sessions on every device, including this one. Pages already open elsewhere can keep working for up to an hour.',
  signOut: 'Sign out everywhere',
} as const;

/** Words the shared pieces use. Screen-reader-only parts start with a space ("Show" + " password"). */
export const SHARED = {
  optional: SHARED_OPTIONAL,
  errorPrefix: 'Error: ',
  passwordSr: ' password',
  changeEmailSr: ' email address',
  setupKeySr: ' setup key',
  cancel: 'Cancel',
} as const;

/** Progress and confirmations for the polite live region (never errors). */
export const STATUS = {
  sendingCode: 'Sending a code…',
  sendingRequest: 'Sending your request…',
  checkingPassword: 'Checking the password…',
  checkingCode: 'Checking the code…',
  saving: 'Saving…',
  preparingSetupKey: 'Preparing your setup key…',
  waitingForPasskey: 'Waiting for your passkey…',
  passkeySaved: 'Passkey saved.',
  removingPasskey: 'Removing the passkey…',
  passkeyRemoved: 'Passkey removed.',
  authenticatorOn: 'Your authenticator is on.',
  passwordSaved: 'Password saved.',
  passwordChanged: 'Password changed.',
  signingOutEverywhere: 'Signing out everywhere…',
} as const;

// ---- Errors and status (REPORT §4.4, Card Studio's states) -------------------------------------

export const ERRORS = {
  emptyEmail: 'Enter your email address',
  badEmail: (hint: string) => `Enter an email address like ${hint}`,
  emptyPassword: 'Enter your password',
  emptyName: 'Enter your name',
  codeTooShort: 'Enter the 8-digit code from the email',
  totpTooShort: 'Enter the 6-digit code from your authenticator app',
  resetCodeEmpty: 'Enter the code from the email',
  passwordTooShort: 'Choose a password with at least 15 characters',
  passwordTooLong: 'Choose a password with at most 256 characters',
  passkeyCancelled: 'We didn’t get a passkey. Try again, or use another way below.',
  passkeyRejected: 'We couldn’t sign you in with that passkey. Try again or use another way below.',
  passkeyCreateFailed: 'We couldn’t create your passkey. Try again, or continue without one.',
  passkeyUnsupported: 'This browser can’t use passkeys here. Use another way below.',
  methodUnavailable: 'That way of signing in isn’t available here. Use another way below.',
  emptyCurrentPassword: 'Enter your current password',
  wrongCurrentPassword: 'Your current password isn’t right.',
  passkeyRemovalUnconfirmed: 'We couldn’t confirm you have another way to sign in, so this passkey stays for now. Try again in a moment.',
  wrongPassword: 'That email address and password don’t match. Try again, or use another way to sign in.',
  wrongTotp: 'That code didn’t work. Codes change every 30 seconds, so enter the newest one.',
  wrongEmailCode: (c: Pick<CopyContext, 'siteName'>) => `That code didn’t work. Check it against the newest email from ${c.siteName}.`,
  expiredCode: 'That code has expired. Ask for a new one.',
  sessionExpired: (c: Pick<CopyContext, 'codeLifetimeMinutes'>) => `That took longer than ${c.codeLifetimeMinutes} minutes, so we stopped the sign-in to keep your account safe. Start again.`,
  rateLimited: 'Too many attempts from this network. Wait 5 minutes, then try again.',
  breached: 'This password has appeared in a data breach, so it isn’t safe to use. Choose a different one.',
  network: (c: Pick<CopyContext, 'helpAddress'> | undefined) =>
    `We couldn’t reach the sign-in service. Check your connection and try again.${c?.helpAddress ? ` If it keeps happening, email ${c.helpAddress}.` : ''}`,
  unknown: 'Something went wrong. Try again in a moment.',
} as const;
