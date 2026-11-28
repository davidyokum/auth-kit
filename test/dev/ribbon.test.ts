// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { PersonaMenu, postSignInDestination } from '../../src/dev/menu.js';
import {
  EnvironmentRibbon,
  environmentBadgeModel,
  environmentFavicon,
  environmentMetadata,
  environmentRibbonModel,
  RIBBON_PIN_STORAGE_KEY,
  resolveEnvironment,
  ViewAsBanner,
  viewAsMetadata,
} from '../../src/dev/ribbon.js';
import { POOL_ID } from '../helpers.js';

const ROOT = join(import.meta.dirname, '..', '..');

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(RIBBON_PIN_STORAGE_KEY);
  document.documentElement.style.removeProperty('--ak-ribbon-height');
  document.body.innerHTML = '';
});

describe('environment ribbon model', () => {
  it('hides on the live site and shows elsewhere', () => {
    expect(environmentRibbonModel({ environment: 'production', poolId: 'p', poolIsSandbox: false })).toMatchObject({ show: false, tone: 'none', titlePrefix: '' });
    expect(environmentBadgeModel({ environment: 'production', poolId: 'p', poolIsSandbox: false })).toBeNull();
    expect(environmentRibbonModel({ environment: 'preview', poolId: POOL_ID, poolIsSandbox: null, branch: 'pr-12' })).toEqual({
      show: true,
      tone: 'preview',
      heading: 'PREVIEW',
      details: ['branch pr-12', `pool ${POOL_ID}`, 'production build'],
      label: `PREVIEW · branch pr-12 · pool ${POOL_ID} · production build`,
      titlePrefix: '[PREVIEW] ',
    });
    expect(environmentBadgeModel({ environment: 'preview', poolId: POOL_ID, poolIsSandbox: null, branch: 'pr-12' })).toMatchObject({
      letter: 'P',
      barVariant: 'preview',
      frame: 'none',
    });
  });

  it('names the pool and persona locally, and treats placeholder outputs calmly ("no sandbox yet")', () => {
    expect(environmentRibbonModel({ environment: 'local', poolId: POOL_ID, poolIsSandbox: true, persona: 'Admin – content only' }).label).toBe(
      `LOCAL · sandbox pool ${POOL_ID} · signed in as Admin – content only (test)`,
    );
    expect(environmentRibbonModel({ environment: 'local', poolId: POOL_ID, poolIsSandbox: true }).label).toBe(`LOCAL · sandbox pool ${POOL_ID} · signed out`);
    expect(environmentRibbonModel({ environment: 'local', poolId: POOL_ID, poolIsSandbox: true, signedInAs: 'me@example.org (not a persona)' }).label).toMatch(
      /signed in as me@example\.org \(not a persona\)$/,
    );
    expect(environmentBadgeModel({ environment: 'local', poolId: POOL_ID, poolIsSandbox: true })).toMatchObject({
      letter: 'L',
      barVariant: 'sandbox',
      tooltip: 'Local: Your sandbox',
      frame: 'none',
    });

    const placeholder = environmentRibbonModel({ environment: 'local', poolId: 'us-east-1_PlaceholderPool', poolIsSandbox: null });
    expect(placeholder).toMatchObject({ tone: 'local', heading: 'LOCAL', details: ['no sandbox yet', 'dev sign-in off'] });
    expect(environmentBadgeModel({ environment: 'local', poolId: 'us-east-1_PlaceholderPool', poolIsSandbox: null })).toMatchObject({
      letter: 'L',
      barVariant: 'calm',
      tooltip: 'Local: No sandbox yet',
      frame: 'none',
    });
  });

  it('distinguishes danger (!) for a non-sandbox pool from caution (?) when the check could not run', () => {
    const notSandbox = environmentRibbonModel({ environment: 'local', poolId: POOL_ID, poolIsSandbox: false });
    expect(notSandbox).toMatchObject({ tone: 'danger', heading: 'LOCAL · NOT A SANDBOX POOL', titlePrefix: '[DEV] ' });
    expect(notSandbox.details).toContain('dev sign-in off');
    expect(environmentBadgeModel({ environment: 'local', poolId: POOL_ID, poolIsSandbox: false })).toMatchObject({
      letter: '!',
      barVariant: 'danger',
      frame: 'danger',
    });

    const unknown = environmentRibbonModel({ environment: 'local', poolId: POOL_ID, poolIsSandbox: null, poolCheckError: 'no AWS credentials' });
    expect(unknown.tone).toBe('caution');
    expect(unknown.label).toContain("couldn't confirm it's a sandbox (no AWS credentials)");
    expect(environmentBadgeModel({ environment: 'local', poolId: POOL_ID, poolIsSandbox: null, poolCheckError: 'no AWS credentials' })).toMatchObject({
      letter: '?',
      barVariant: 'caution',
      frame: 'caution',
    });
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
    expect(decodeURIComponent(environmentFavicon('caution'))).toMatch(/^data:image\/svg\+xml,<svg .*#d97706.*>\?<\/text><\/svg>$/);
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

describe('components (server-rendered and interactive badge slot)', () => {
  it('EnvironmentRibbon renders a 28 px labeled region per tone, window frames for caution/danger, and nothing on the live site', () => {
    const html = renderToStaticMarkup(createElement(EnvironmentRibbon, { environment: 'local', poolId: POOL_ID, poolIsSandbox: true, persona: 'Admin – content only' }));
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Environment"');
    expect(html).toContain('data-auth-kit-ribbon="local"');
    expect(html).toContain('min-height:28px');
    expect(html).toContain('<strong style="font-weight:700">LOCAL</strong>');
    expect(html).toContain('signed in as Admin – content only (test)');

    const dangerHtml = renderToStaticMarkup(createElement(EnvironmentRibbon, { environment: 'local', poolId: 'p', poolIsSandbox: false }));
    expect(dangerHtml).toContain('data-auth-kit-ribbon="danger"');
    expect(dangerHtml).toContain('data-auth-kit-env-frame="danger"');

    const cautionHtml = renderToStaticMarkup(createElement(EnvironmentRibbon, { environment: 'local', poolId: POOL_ID, poolIsSandbox: null }));
    expect(cautionHtml).toContain('data-auth-kit-ribbon="caution"');
    expect(cautionHtml).toContain('data-auth-kit-env-frame="caution"');

    expect(renderToStaticMarkup(createElement(EnvironmentRibbon, { environment: 'production', poolId: 'p', poolIsSandbox: null }))).toBe('');
  });

  it('EnvironmentRibbon has room for the dev menu', () => {
    const html = renderToStaticMarkup(createElement(EnvironmentRibbon, { environment: 'local', poolId: 'p', poolIsSandbox: true }, createElement('button', null, 'Sign in as…')));
    expect(html).toContain('<button>Sign in as…</button>');
  });

  it('pins with --ak-ribbon-height: 28px on <html>, mounts an 18 px badge into [data-env-badge-slot] when collapsed/scrolled, and opens details', () => {
    const launcherSlot = document.createElement('span');
    launcherSlot.setAttribute('data-env-badge-slot', '');
    document.body.appendChild(launcherSlot);

    const { container } = render(
      createElement(EnvironmentRibbon, {
        environment: 'local',
        poolId: 'us-east-1_PlaceholderPool',
        poolIsSandbox: null,
      }),
    );

    const pinBtn = container.querySelector('[data-auth-kit-pin]') as HTMLButtonElement;
    expect(pinBtn).not.toBeNull();
    expect(document.documentElement.style.getPropertyValue('--ak-ribbon-height')).toBe('');

    fireEvent.click(pinBtn);
    expect(document.documentElement.style.getPropertyValue('--ak-ribbon-height')).toBe('28px');
    expect(window.localStorage.getItem(RIBBON_PIN_STORAGE_KEY)).toBe('1');

    // Collapsing the bar unsets --ak-ribbon-height and mounts the 18 px 'L' badge into [data-env-badge-slot].
    const collapseBtn = container.querySelector('[data-auth-kit-collapse]') as HTMLButtonElement;
    fireEvent.click(collapseBtn);
    expect(document.documentElement.style.getPropertyValue('--ak-ribbon-height')).toBe('');

    const slotBadge = launcherSlot.querySelector('button[data-auth-kit-env-badge="L"]') as HTMLButtonElement;
    expect(slotBadge).not.toBeNull();
    expect(slotBadge.getAttribute('data-auth-kit-ui')).toBe('true');
    expect(slotBadge.style.width).toBe('18px');
    expect(container.querySelector('[data-auth-kit-env-fallback]')).toBeNull();

    // Clicking the slot badge opens the Environment details panel; Escape closes it.
    fireEvent.click(slotBadge);
    const detailsDialog = container.querySelector('[data-auth-kit-env-details]') as HTMLElement;
    expect(detailsDialog).not.toBeNull();
    expect(detailsDialog.textContent).toContain('Local · No sandbox yet');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(container.querySelector('[data-auth-kit-env-details]')).toBeNull();
  });

  it('renders a 24 px standalone fallback badge in the bottom-left corner when [data-env-badge-slot] is absent', () => {
    const { container } = render(
      createElement(EnvironmentRibbon, {
        environment: 'preview',
        poolId: POOL_ID,
        poolIsSandbox: null,
        branch: 'feat-ui',
      }),
    );

    fireEvent.click(container.querySelector('[data-auth-kit-collapse]') as HTMLButtonElement);
    const fallbackBadge = container.querySelector('button[data-auth-kit-env-fallback]') as HTMLButtonElement;
    expect(fallbackBadge).not.toBeNull();
    expect(fallbackBadge.textContent).toBe('P');
    expect(fallbackBadge.style.width).toBe('24px');
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

  it('postSignInDestination leaves /sign-in for safe next (or /) on persona sign-in, and reloads elsewhere', () => {
    expect(postSignInDestination('analyst', { pathname: '/sign-in', search: '?next=%2F%3Ftab%3Dlibrary%26cycle%3D2027-29' })).toBe(
      '/?tab=library&cycle=2027-29',
    );
    expect(postSignInDestination('analyst', { pathname: '/sign-in', search: '' })).toBe('/');
    expect(postSignInDestination('analyst', { pathname: '/sign-in/', search: '?next=%2Fadmin' })).toBe('/admin');
    expect(postSignInDestination('analyst', { pathname: '/signed-out', search: '' })).toBe('/');
    expect(postSignInDestination('analyst', { pathname: '/sign-up', search: '?next=%2Fdashboard' })).toBe('/dashboard');
    // Rejects open redirects and sign-in loops.
    expect(postSignInDestination('analyst', { pathname: '/sign-in', search: '?next=https%3A%2F%2Fevil.example' })).toBe('/');
    expect(postSignInDestination('analyst', { pathname: '/sign-in', search: '?next=%2F%2Fevil.example' })).toBe('/');
    expect(postSignInDestination('analyst', { pathname: '/sign-in', search: '?next=%2Fsign-in%3Ffoo%3D1' })).toBe('/');
    // Reloads in place when signing out or already on an app page.
    expect(postSignInDestination(null, { pathname: '/sign-in', search: '?next=%2Fadmin' })).toBeNull();
    expect(postSignInDestination('analyst', { pathname: '/workbench', search: '?tab=desk' })).toBeNull();
  });
});

describe('module boundaries: what ships cannot carry dev sign-in', () => {
  const importsOf = (file: string) =>
    [...readFileSync(join(ROOT, file), 'utf8').matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? '');

  it('auth-kit/ribbon imports only the pure model, its client ribbon module, and React', () => {
    expect(importsOf('src/dev/ribbon.tsx')).toEqual(['react', './ribbon-model.js', './ribbon-client.js', './ribbon-model.js']);
    expect(importsOf('src/dev/ribbon-client.tsx')).toEqual(['react', './ribbon-model.js']);
    expect(importsOf('src/dev/ribbon-model.ts')).toEqual([]);
  });

  it('the marker lives only in dev-only modules, and only ribbon-client carries use client', () => {
    for (const file of ['src/dev/ribbon.tsx', 'src/dev/ribbon-client.tsx', 'src/dev/ribbon-model.ts']) {
      expect(readFileSync(join(ROOT, file), 'utf8')).not.toMatch(/auth-kit-dev-sign-in|marker\.js|DEV_SIGNIN_MARKER/);
    }
    expect(readFileSync(join(ROOT, 'src/dev/menu.tsx'), 'utf8').startsWith("'use client';")).toBe(true);
    expect(readFileSync(join(ROOT, 'src/dev/ribbon-client.tsx'), 'utf8').startsWith("'use client';")).toBe(true);
    expect(readFileSync(join(ROOT, 'src/dev/ribbon.tsx'), 'utf8').startsWith("'use client';")).toBe(false);
  });
});
