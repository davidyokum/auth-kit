import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PersonaMenu } from '../../src/dev/menu.js';
import {
  EnvironmentRibbon,
  environmentFavicon,
  environmentMetadata,
  environmentRibbonModel,
  resolveEnvironment,
  ViewAsBanner,
  viewAsMetadata,
} from '../../src/dev/ribbon.js';
import { POOL_ID } from '../helpers.js';

const ROOT = join(import.meta.dirname, '..', '..');

describe('environment ribbon model', () => {
  it('hides on the live site and shows elsewhere', () => {
    expect(environmentRibbonModel({ environment: 'production', poolId: 'p', poolIsSandbox: false })).toMatchObject({ show: false, tone: 'none', titlePrefix: '' });
    expect(environmentRibbonModel({ environment: 'preview', poolId: POOL_ID, poolIsSandbox: null, branch: 'pr-12' })).toEqual({
      show: true,
      tone: 'preview',
      heading: 'PREVIEW',
      details: ['branch pr-12', `pool ${POOL_ID}`, 'production build'],
      label: `PREVIEW · branch pr-12 · pool ${POOL_ID} · production build`,
      titlePrefix: '[PREVIEW] ',
    });
  });

  it('names the pool and persona locally', () => {
    expect(environmentRibbonModel({ environment: 'local', poolId: POOL_ID, poolIsSandbox: true, persona: 'Admin – content only' }).label).toBe(
      `LOCAL · sandbox pool ${POOL_ID} · signed in as Admin – content only (test)`,
    );
    expect(environmentRibbonModel({ environment: 'local', poolId: POOL_ID, poolIsSandbox: true }).label).toBe(`LOCAL · sandbox pool ${POOL_ID} · signed out`);
    expect(environmentRibbonModel({ environment: 'local', poolId: POOL_ID, poolIsSandbox: true, signedInAs: 'me@example.org (not a persona)' }).label).toMatch(
      /signed in as me@example\.org \(not a persona\)$/,
    );
  });

  it('turns red for a pool that is not a sandbox, and for one nobody could check', () => {
    const notSandbox = environmentRibbonModel({ environment: 'local', poolId: POOL_ID, poolIsSandbox: false });
    expect(notSandbox).toMatchObject({ tone: 'danger', heading: 'LOCAL · NOT A SANDBOX POOL', titlePrefix: '[DEV] ' });
    expect(notSandbox.details).toContain('dev sign-in off');
    const unknown = environmentRibbonModel({ environment: 'local', poolId: POOL_ID, poolIsSandbox: null, poolCheckError: 'no AWS credentials' });
    expect(unknown.tone).toBe('danger');
    expect(unknown.label).toContain("couldn't confirm it's a sandbox (no AWS credentials)");
  });

  it('resolves the environment from NODE_ENV and the branch', () => {
    expect(resolveEnvironment({ nodeEnv: 'development' })).toBe('local');
    expect(resolveEnvironment({ nodeEnv: 'production', branch: 'main' })).toBe('production');
    expect(resolveEnvironment({ nodeEnv: 'production', branch: 'pr-12' })).toBe('preview');
    expect(resolveEnvironment({ nodeEnv: 'production', branch: 'release', liveBranches: ['release'] })).toBe('production');
    expect(resolveEnvironment({ nodeEnv: 'production', branch: undefined })).toBe('production');
  });
});

describe('tab title and favicon', () => {
  it('prefixes the title template and swaps the favicon outside production', () => {
    const local = environmentMetadata(environmentRibbonModel({ environment: 'local', poolId: 'p', poolIsSandbox: true }), { template: '%s · Orchard', default: 'Orchard' });
    expect(local.title).toEqual({ template: '[DEV] %s · Orchard', default: '[DEV] Orchard' });
    expect(local.icons?.icon[0]).toEqual({ url: environmentFavicon('local'), type: 'image/svg+xml' });
    expect(decodeURIComponent(environmentFavicon('danger'))).toMatch(/^data:image\/svg\+xml,<svg .*#b91c1c.*>!<\/text><\/svg>$/);
    const preview = environmentMetadata(environmentRibbonModel({ environment: 'preview', poolId: 'p', poolIsSandbox: null }), 'Orchard');
    expect(preview.title).toEqual({ template: '[PREVIEW] %s', default: '[PREVIEW] Orchard' });
  });

  it('leaves the live site untouched', () => {
    expect(environmentMetadata(environmentRibbonModel({ environment: 'production', poolId: 'p', poolIsSandbox: null }), { template: '%s · Orchard', default: 'Orchard' })).toEqual({
      title: { template: '%s · Orchard', default: 'Orchard' },
    });
  });

  it('marks View as in the tab', () => {
    expect(viewAsMetadata('Admin – content only', 'Orchard').title).toEqual({ template: 'Viewing as Admin – content only · %s', default: 'Viewing as Admin – content only · Orchard' });
  });
});

describe('components (server-rendered)', () => {
  it('EnvironmentRibbon renders a labeled region per tone, and nothing on the live site', () => {
    const html = renderToStaticMarkup(createElement(EnvironmentRibbon, { environment: 'local', poolId: POOL_ID, poolIsSandbox: true, persona: 'Admin – content only' }));
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Environment"');
    expect(html).toContain('data-auth-kit-ribbon="local"');
    expect(html).toContain('<strong style="font-weight:700">LOCAL</strong>');
    expect(html).toContain('signed in as Admin – content only (test)');
    expect(renderToStaticMarkup(createElement(EnvironmentRibbon, { environment: 'local', poolId: 'p', poolIsSandbox: false }))).toContain('data-auth-kit-ribbon="danger"');
    expect(renderToStaticMarkup(createElement(EnvironmentRibbon, { environment: 'production', poolId: 'p', poolIsSandbox: null }))).toBe('');
  });

  it('EnvironmentRibbon has room for the dev menu', () => {
    const html = renderToStaticMarkup(createElement(EnvironmentRibbon, { environment: 'local', poolId: 'p', poolIsSandbox: true }, createElement('button', null, 'Sign in as…')));
    expect(html).toContain('<button>Sign in as…</button>');
  });

  it('ViewAsBanner draws the hatched border and a sticky read-only bar with Exit', () => {
    const html = renderToStaticMarkup(createElement(ViewAsBanner, { viewingAs: 'Admin – content only', exitAction: '/admin/view-as/exit' }));
    expect(html).toContain('data-auth-kit-view-as-border=""');
    expect(html).toContain('repeating-linear-gradient(45deg');
    expect(html).toMatch(/Viewing as <strong[^>]*>Admin – content only<\/strong>.*read-only/);
    expect(html).toMatch(/<form [^>]*action="\/admin\/view-as\/exit" method="post"/);
    expect(html).toContain('>Exit</button>');
  });

  it('PersonaMenu renders nothing until the dev route answers', () => {
    expect(renderToStaticMarkup(createElement(PersonaMenu))).toBe('');
  });
});

describe('module boundaries: what ships cannot carry dev sign-in', () => {
  const importsOf = (file: string) =>
    [...readFileSync(join(ROOT, file), 'utf8').matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? '');

  it('auth-kit/ribbon imports only the pure model and React types', () => {
    expect(importsOf('src/dev/ribbon.tsx')).toEqual(['react', './ribbon-model.js', './ribbon-model.js']);
    expect(importsOf('src/dev/ribbon-model.ts')).toEqual([]);
  });

  it('the marker lives only in dev-only modules', () => {
    for (const file of ['src/dev/ribbon.tsx', 'src/dev/ribbon-model.ts']) {
      expect(readFileSync(join(ROOT, file), 'utf8')).not.toMatch(/auth-kit-dev-sign-in|marker\.js|DEV_SIGNIN_MARKER/);
    }
    expect(readFileSync(join(ROOT, 'src/dev/menu.tsx'), 'utf8').startsWith("'use client';")).toBe(true);
  });
});
