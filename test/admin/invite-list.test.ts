import { describe, expect, it } from 'vitest';
import { INVITE_MANY_MAX_CHARS, parseInviteList } from '../../src/admin/invite-list.js';

describe('parseInviteList ("Add several at once", ADR 0029)', () => {
  it('reads commas, semicolons, new lines, spaces, and Name <address>', () => {
    expect(parseInviteList('Ada <ada@x.org>, grace@x.org;\n\nkat@x.org  dot@x.org').addresses).toEqual(['ada@x.org', 'grace@x.org', 'kat@x.org', 'dot@x.org']);
  });

  it('keeps a plain address that shares a line with a later Name <address>', () => {
    expect(parseInviteList('alice@x.org, Bob <bob@x.org>').addresses).toEqual(['alice@x.org', 'bob@x.org']);
    expect(parseInviteList('A <a@x.org>, c@x.org, D <d@x.org>').addresses).toEqual(['a@x.org', 'c@x.org', 'd@x.org']);
  });

  it('keeps a comma inside a quoted name', () => {
    expect(parseInviteList('"Lovelace, Ada" <ada@x.org>, "Hopper, Grace" <grace@x.org>')).toEqual({ addresses: ['ada@x.org', 'grace@x.org'], unreadable: [], tooLong: false });
  });

  it('refuses what it would have to guess at', () => {
    // A name that is a different address; two addresses in one bracketed entry; text after the bracket; an empty bracket.
    for (const entry of ['boss@x.org <someone@y.example>', 'a@x.org <b@x.org> c@x.org <d@x.org>', 'Ada <ada@x.org> extra', 'Ada <>']) {
      expect(parseInviteList(entry).unreadable).toEqual([entry]);
    }
    // A name that is the same address is fine.
    expect(parseInviteList('ada@x.org <Ada@x.org>').addresses).toEqual(['Ada@x.org']);
  });

  it('refuses a paste over the cap without reading it, and reads a long one in linear time', () => {
    expect(parseInviteList('a'.repeat(INVITE_MANY_MAX_CHARS + 1))).toEqual({ addresses: [], unreadable: [], tooLong: true });
    const started = performance.now();
    parseInviteList(`${'x'.repeat(INVITE_MANY_MAX_CHARS - 20)} <a@x.org>`);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
