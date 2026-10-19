// @vitest-environment jsdom
/**
 * The standalone chooser (`/account/sign-in-method`, where the page guards send an account with only
 * emailed codes): a new passkey sets this browser's passkey hint (register A5a), and the hint helpers
 * are exported for sites building their own screens.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '../../src/client/index.js';
import { ChooseFirstCredential } from '../../src/client/index.js';
import { auth, resetAmplifyMocks } from './amplify-mock.js';

vi.mock('aws-amplify', async () => (await import('./amplify-mock.js')).amplifyModule);
vi.mock('aws-amplify/auth', async () => (await import('./amplify-mock.js')).authModule);
vi.mock('aws-amplify/auth/cognito', async () => (await import('./amplify-mock.js')).cognitoModule);
vi.mock('aws-amplify/utils', async () => (await import('./amplify-mock.js')).utilsModule);

beforeEach(() => {
  resetAmplifyMocks();
  window.localStorage.clear();
});
afterEach(() => cleanup());

function chooser(accountName?: string) {
  const onDone = vi.fn<(how: client.FirstCredential) => void>();
  render(createElement(ChooseFirstCredential, { passkeysEnabled: true, issuer: 'Example Reports', ...(accountName !== undefined && { accountName }), onDone, checkBreachedPassword: false }));
  return { onDone, user: userEvent.setup() };
}

describe('ChooseFirstCredential on a page of its own', () => {
  it('a new passkey sets the hint for accountName before onDone, so the next Continue opens the passkey prompt', async () => {
    let hintedWhenDone: boolean | undefined;
    const { onDone, user } = chooser(' Ada@Example.org ');
    onDone.mockImplementation(() => void client.hasPasskeyHint('ada@example.org').then((h) => (hintedWhenDone = h)));
    await user.click(screen.getByRole('button', { name: 'Create a passkey' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('passkey'));
    expect(auth.associateWebAuthnCredential).toHaveBeenCalled();
    await waitFor(() => expect(hintedWhenDone).toBe(true));
    expect(await client.hasPasskeyHint('grace@example.org')).toBe(false);
  });

  it('without accountName it can’t know the address: no hint, and onDone still runs', async () => {
    const { onDone, user } = chooser();
    await user.click(screen.getByRole('button', { name: 'Create a passkey' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('passkey'));
    expect(window.localStorage.getItem('auth-kit:passkey-hint:v1')).toBeNull();
  });
});

describe('the passkey hint helpers are exported from auth-kit/client', () => {
  it('rememberPasskey, hasPasskeyHint, forgetPasskey, passkeyHintSkipped, PASSKEY_HINT_SKIPS', async () => {
    expect(client.PASSKEY_HINT_SKIPS).toBe(2);
    await client.rememberPasskey('ada@example.org');
    expect(await client.hasPasskeyHint('ada@example.org')).toBe(true);
    await client.passkeyHintSkipped('ada@example.org');
    expect(await client.hasPasskeyHint('ada@example.org')).toBe(true);
    await client.passkeyHintSkipped('ada@example.org');
    expect(await client.hasPasskeyHint('ada@example.org')).toBe(false);
    await client.rememberPasskey('ada@example.org');
    await client.forgetPasskey('ada@example.org');
    expect(await client.hasPasskeyHint('ada@example.org')).toBe(false);
  });
});
