'use client';
/**
 * `auth-kit/dev/menu`: the "Sign in as…" menu (primer Chapter 8, Figure 8.1). **Dev only**: import it
 * from the module your `@/dev` alias swaps out of builds (see `withDevKit`), never from code that
 * ships. It carries the dev sign-in marker, so `check-prod-build` fails if it reaches a build.
 *
 * It asks the dev route for the personas when it mounts. If the route answers 404 (absent, or a
 * gate refused) the menu renders nothing; the dev server's console says which gate.
 */
import { type CSSProperties, type ReactElement, useCallback, useEffect, useId, useRef, useState } from 'react';
import { DEV_SIGN_IN_ROUTE, DEV_SIGNIN_MARKER } from './marker.js';

interface MenuPersona {
  key: string;
  label: string;
  email: string;
  groups: string[];
}

interface MenuData {
  personas: MenuPersona[];
  current: string | null;
  pool: string;
}

export interface PersonaMenuProps {
  /** Default `/api/dev/sign-in`. */
  route?: string;
  /** After a sign-in or sign-out succeeds. Default: reload the page, so every component sees the new session. */
  onChange?: (persona: string | null) => void;
  /** Default "Sign in as…". */
  label?: string;
  className?: string;
}

const BUTTON: CSSProperties = {
  font: 'inherit',
  fontWeight: 600,
  color: 'inherit',
  background: 'rgba(255,255,255,0.16)',
  border: '1px solid rgba(255,255,255,0.5)',
  borderRadius: 4,
  padding: '1px 8px',
  cursor: 'pointer',
};

const PANEL: CSSProperties = {
  position: 'absolute',
  right: 0,
  top: 'calc(100% + 4px)',
  minWidth: 260,
  zIndex: 2_147_483_001,
  background: '#fff',
  color: '#111827',
  border: '1px solid #d1d5db',
  borderRadius: 8,
  boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
  padding: 6,
  font: '13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif',
  textAlign: 'left',
};

const ITEM: CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  font: 'inherit',
  color: 'inherit',
  background: 'transparent',
  border: 0,
  borderRadius: 6,
  padding: '6px 8px',
  cursor: 'pointer',
};

/** Lists the personas and signs one in through the dev route. */
export function PersonaMenu(props: PersonaMenuProps): ReactElement | null {
  const route = props.route ?? DEV_SIGN_IN_ROUTE;
  const [data, setData] = useState<MenuData | 'loading' | 'absent'>('loading');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    let cancelled = false;
    fetch(route, { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } })
      .then(async (res) => (res.ok ? ((await res.json()) as MenuData) : null))
      .then((body) => {
        if (!cancelled) setData(body && Array.isArray(body.personas) ? body : 'absent');
      })
      .catch(() => {
        if (!cancelled) setData('absent');
      });
    return () => {
      cancelled = true;
    };
  }, [route]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !event.composedPath().includes(rootRef.current)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  const done = useCallback(
    (persona: string | null) => {
      if (props.onChange) props.onChange(persona);
      else window.location.reload();
    },
    [props],
  );

  const choose = useCallback(
    async (persona: string | null) => {
      setBusy(persona ?? 'out');
      setError(null);
      try {
        const res = await fetch(route, {
          method: persona === null ? 'DELETE' : 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          ...(persona !== null && { body: JSON.stringify({ persona }) }),
        });
        if (res.ok) {
          setOpen(false);
          done(persona);
          return;
        }
        let detail = '';
        try {
          detail = ((await res.json()) as { detail?: string }).detail ?? '';
        } catch {
          detail = res.status === 404 ? 'refused; the dev server log says why' : '';
        }
        setError(`${res.status}${detail ? `: ${detail}` : ''}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [route, done],
  );

  if (data === 'loading' || data === 'absent') return null;

  return (
    <span
      ref={rootRef}
      data-auth-kit-dev={DEV_SIGNIN_MARKER}
      className={props.className}
      style={{ position: 'relative', display: 'inline-block' }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          setOpen(false);
          buttonRef.current?.focus();
        }
      }}
    >
      <button ref={buttonRef} type="button" aria-expanded={open} aria-controls={panelId} style={BUTTON} onClick={() => setOpen((o) => !o)}>
        {props.label ?? 'Sign in as…'}
      </button>
      <div id={panelId} role="group" aria-label="Sign in as a test account" hidden={!open} style={PANEL}>
        <div style={{ padding: '4px 8px 6px', fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: '#6b7280' }}>
          Sign in as (sandbox only)
        </div>
        {data.personas.map((p) => (
          <button
            key={p.key}
            type="button"
            aria-pressed={data.current === p.key}
            disabled={busy !== null}
            onClick={() => void choose(p.key)}
            style={{ ...ITEM, background: data.current === p.key ? '#eff6ff' : 'transparent' }}
          >
            <span style={{ fontWeight: 600 }}>
              {p.label} (test)
              {p.groups.length === 0 ? ' · no group' : ''}
              {busy === p.key ? ' …' : ''}
            </span>
            <span style={{ display: 'block', fontSize: 12, color: '#6b7280' }}>{p.email}</span>
          </button>
        ))}
        <button type="button" disabled={busy !== null} onClick={() => void choose(null)} style={{ ...ITEM, borderTop: '1px solid #e5e7eb', borderRadius: 0 }}>
          Sign out{busy === 'out' ? ' …' : ''}
        </button>
        {error !== null && (
          <p role="alert" style={{ margin: '6px 8px', color: '#b91c1c', fontSize: 12 }}>
            {error}
          </p>
        )}
        <p style={{ margin: '6px 8px 2px', fontSize: 11, color: '#6b7280' }}>Test accounts from personas.json, pool {data.pool}. Only under next dev.</p>
      </div>
    </span>
  );
}
