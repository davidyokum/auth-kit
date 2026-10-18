import { describe, expect, it } from 'vitest';
import {
  INVITE_ONLY,
  allowsSelfSignUp,
  emailDomainAllowed,
  listInWords,
  mayCreateOwnAccount,
  normalizeAccountCreation,
  takesAccessRequests,
} from '../../src/shared/account-creation.js';

describe('accountCreation (register D1)', () => {
  it('defaults to invite only', () => {
    expect(normalizeAccountCreation(undefined)).toBe(INVITE_ONLY);
    expect(normalizeAccountCreation({ mode: 'invite' })).toEqual({ mode: 'invite', domains: [], requestsAlso: false });
  });

  it('normalizes the domain list: lowercase, no leading @ or dot, no repeats, bare top-level domains allowed', () => {
    expect(normalizeAccountCreation({ mode: 'domains', domains: ['@NC.gov', '.edu', 'nc.gov'] }).domains).toEqual(['nc.gov', 'edu']);
  });

  it.each([
    [{ mode: 'domains' }, /at least one domain/],
    [{ mode: 'domains', domains: ['a b'] }, /isn't a domain/],
    [{ mode: 'open', domains: ['x.org'] }, /only to mode 'domains'/],
    [{ mode: 'invite', requestsAlso: true }, /requestsAlso applies only/],
    [{ mode: 'everyone' }, /mode must be/],
    [{ mode: 'open', extra: 1 }, /no option "extra"/],
    [{ mode: 'domains', domains: ['x.org'], requestsAlso: 'yes' }, /true or false/],
  ] as const)('refuses %j', (input, message) => {
    expect(() => normalizeAccountCreation(input as never)).toThrow(message);
  });

  it('matches a domain and its subdomains on a label boundary only', () => {
    expect(emailDomainAllowed('a@nc.gov', ['nc.gov'])).toBe(true);
    expect(emailDomainAllowed('a@osbm.nc.gov', ['nc.gov'])).toBe(true);
    expect(emailDomainAllowed('a@OSBM.NC.GOV', ['nc.gov'])).toBe(true);
    expect(emailDomainAllowed('a@evilnc.gov', ['nc.gov'])).toBe(false);
    expect(emailDomainAllowed('a@nc.gov.evil.org', ['nc.gov'])).toBe(false);
    expect(emailDomainAllowed('a@school.edu', ['edu'])).toBe(true);
    expect(emailDomainAllowed('nc.gov', ['nc.gov'])).toBe(false);
  });

  it('says which modes sign up, which take requests, and who may make their own account', () => {
    const domains = normalizeAccountCreation({ mode: 'domains', domains: ['nc.gov'] });
    const domainsAndRequests = normalizeAccountCreation({ mode: 'domains', domains: ['nc.gov'], requestsAlso: true });
    const open = normalizeAccountCreation({ mode: 'open' });
    const request = normalizeAccountCreation({ mode: 'request' });
    expect([INVITE_ONLY, request, domains, open].map(allowsSelfSignUp)).toEqual([false, false, true, true]);
    expect([INVITE_ONLY, request, domains, domainsAndRequests, open].map(takesAccessRequests)).toEqual([false, true, false, true, false]);
    expect(mayCreateOwnAccount('a@osbm.nc.gov', domains)).toBe(true);
    expect(mayCreateOwnAccount('a@gmail.example', domains)).toBe(false);
    expect(mayCreateOwnAccount('a@gmail.example', open)).toBe(true);
    expect(mayCreateOwnAccount('a@nc.gov', request)).toBe(false);
  });

  it('lists in words with the Oxford comma (P8)', () => {
    expect(listInWords(['nc.gov'])).toBe('nc.gov');
    expect(listInWords(['nc.gov', 'unc.edu'])).toBe('nc.gov or unc.edu');
    expect(listInWords(['a', 'b', 'c'])).toBe('a, b, or c');
    expect(listInWords(['a', 'b', 'c'], 'and')).toBe('a, b, and c');
  });
});
