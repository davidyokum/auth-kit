'use client';
/**
 * `auth-kit/backdrops/picker`: DEV ONLY. A page for choosing a site's backdrop: nine variations
 * behind the site's real sign-in card, shuffled on demand, with a family preview, a phone or
 * desktop frame, and a large view whose "Use this one" hands the choice to the site (which writes it
 * into its config, locked).
 *
 * It carries the backdrop picker marker, so `npx auth-kit check-prod-build` fails any production
 * build that bundles it. Import it only from a dev-only page (site-auth-kit-template:
 * `app/dev/backdrops/page.dev.tsx`, a route only under `next dev`).
 */
import { createContext, type ReactNode, type RefObject, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { BACKDROP_PICKER_MARKER } from '../dev/marker.js';
import { BACKDROP_FAMILIES, BACKDROP_FAMILY_IDS } from './families.js';
import { describeChoice, lockStatus, PREVIEW_FRAMES, type PreviewFrame, sameChoice, type StoredBackdrop, upgradeOffer } from './picker-model.js';
import { Backdrop } from './react.js';
import { type BackdropStyleId, backdropStyle, offeredStyles } from './styles/registry.js';
import type { BackdropFamily } from './types.js';
import { type BackdropChoice, backdropVariations, randomSalt } from './variations.js';

export interface BackdropPickerResult {
  /** One line for the person ("Saved. site.config.ts now has …"). */
  message: string;
  /** Optional detail shown in monospace (the change, the backup's path). */
  detail?: string;
}

export interface BackdropPickerProps {
  siteName: string;
  /** The site's family: the preview's default. */
  family: BackdropFamily;
  /** Labels for the family preview. Default: each family's label. */
  familyLabels?: Partial<Record<BackdropFamily, string>>;
  /** What the site stores now (null: nothing chosen). */
  current: StoredBackdrop | null;
  /** What the site draws now if it isn't locked (the name-derived proposal). */
  proposed?: BackdropChoice | null;
  /** The site's real sign-in card for a family. Rendered inert inside previews; mark it `data-backdrop-card`. */
  renderCard: (family: BackdropFamily) => ReactNode;
  /** Saves a choice (locked). Resolve with what to tell the person; throw to show an error. */
  onUse: (choice: BackdropChoice) => Promise<BackdropPickerResult>;
  /** Shown when the site's backdrop isn't locked (what that means for its builds). */
  unlockedHelp?: ReactNode;
  /** The first salt (tests). Default: random. */
  initialSalt?: string;
}

type StyleFilter = 'mix' | BackdropStyleId;

interface Viewing {
  /** The list the arrows move through. */
  list: BackdropChoice[];
  index: number;
  /** A heading for the list ("Variation 3 of 9", "Your current backdrop"). */
  kind: 'variation' | 'current' | 'upgrade';
}

function useElementWidth(ref: RefObject<HTMLElement | null>, key: unknown = null): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, key]);
  return width;
}

function devicePixelRatio(): number {
  return typeof window === 'undefined' ? 1 : Math.min(2, window.devicePixelRatio || 1);
}

/** The site's name, for styles that letter it (Yokum magnetic), in every preview. */
const SiteNameContext = createContext<string | undefined>(undefined);

/** A scaled preview: the site's card at real size over a backdrop, in a virtual viewport. */
function Scene(props: {
  choice: BackdropChoice;
  family: BackdropFamily;
  frame: PreviewFrame;
  displayWidth: number;
  renderCard: (family: BackdropFamily) => ReactNode;
  paused?: boolean;
  maxFps?: number;
}) {
  const view = PREVIEW_FRAMES[props.frame];
  const siteName = useContext(SiteNameContext);
  // Previews show the subject of the day: browsing variations never advances this browser's tour.
  const hasSubjects = backdropStyle(props.choice.style)?.subjects !== undefined;
  const scale = props.displayWidth > 0 ? props.displayWidth / view.width : 0;
  if (!(scale > 0)) return <div className="akp-scene-placeholder" />;
  return (
    <div className="akp-scene-clip" style={{ width: props.displayWidth, height: Math.round(view.height * scale) }}>
      <div className="akp-scene" style={{ width: view.width, height: view.height, transform: `scale(${scale})` }}>
        <Backdrop
          style={props.choice.style}
          seed={props.choice.seed}
          styleVersion={props.choice.styleVersion}
          family={props.family}
          {...(siteName !== undefined && { siteName })}
          {...(hasSubjects && { subject: { rotation: 'day' as const } })}
          pixelRatio={devicePixelRatio() * scale}
          {...(props.maxFps !== undefined && { maxFps: props.maxFps })}
          {...(props.paused !== undefined && { paused: props.paused })}
          className="akp-backdrop"
          contentClassName="akp-backdrop-content"
        >
          <div className={`akp-card-wrap akp-card-wrap-${props.frame}`}>
            <div inert className="akp-card-inert">
              {props.renderCard(props.family)}
            </div>
          </div>
        </Backdrop>
      </div>
    </div>
  );
}

function Tile(props: {
  index: number;
  choice: BackdropChoice;
  family: BackdropFamily;
  frame: PreviewFrame;
  isCurrent: boolean;
  paused: boolean;
  renderCard: (family: BackdropFamily) => ReactNode;
  onOpen: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);
  const label = backdropStyle(props.choice.style)?.label ?? props.choice.style;
  return (
    <figure className={`akp-tile akp-tile-${props.frame}`}>
      <div ref={ref} className="akp-frame">
        <Scene choice={props.choice} family={props.family} frame={props.frame} displayWidth={width} renderCard={props.renderCard} paused={props.paused} maxFps={20} />
        <button type="button" className="akp-open" onClick={props.onOpen} aria-label={`Variation ${props.index + 1}: ${label}, seed ${props.choice.seed}. Open it large.`} />
      </div>
      <figcaption className="akp-caption">
        <span className="akp-caption-style">
          {label} <span className="akp-pill">v{props.choice.styleVersion}</span>
          {props.isCurrent ? <span className="akp-badge akp-badge-ok">Current</span> : null}
        </span>
        <code className="akp-seed">{props.choice.seed}</code>
      </figcaption>
    </figure>
  );
}

function Segmented<T extends string>(props: { label: string; value: T; options: readonly { value: T; label: string }[]; onChange: (value: T) => void }) {
  return (
    <div className="akp-field" role="radiogroup" aria-label={props.label}>
      <span className="akp-field-label">{props.label}</span>
      <div className="akp-segmented">
        {props.options.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={o.value === props.value} className="akp-segment" onClick={() => props.onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function BackdropPicker(props: BackdropPickerProps) {
  const { siteName, family: siteFamily, current, renderCard, onUse } = props;
  const [salt, setSalt] = useState(() => props.initialSalt ?? randomSalt());
  const [filter, setFilter] = useState<StyleFilter>('mix');
  const [family, setFamily] = useState<BackdropFamily>(siteFamily);
  const [frame, setFrame] = useState<PreviewFrame>('desktop');
  const [viewing, setViewing] = useState<Viewing | null>(null);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error' | 'busy'; message: string; detail?: string } | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [viewingKey, setViewingKey] = useState(0);
  const stageWidth = useElementWidth(stageRef, viewingKey);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const variations = useMemo<BackdropChoice[]>(
    () =>
      backdropVariations({ family, salt, count: 9, ...(filter !== 'mix' && { style: filter }) }).map((v) => ({ style: v.style, seed: v.seed, styleVersion: v.styleVersion })),
    [family, salt, filter],
  );
  const locked = lockStatus(current) === 'locked';
  const offer = upgradeOffer(current);
  const shown: BackdropChoice | null = locked && current ? { style: current.style as BackdropStyleId, seed: String(current.seed), styleVersion: current.styleVersion as number } : (props.proposed ?? null);
  const labels = useCallback((f: BackdropFamily) => props.familyLabels?.[f] ?? BACKDROP_FAMILIES[f].label, [props.familyLabels]);

  const shuffle = useCallback(() => {
    setHistory((h) => [...h, salt].slice(-20));
    setSalt(randomSalt());
  }, [salt]);
  const back = useCallback(() => {
    setHistory((h) => {
      const previous = h[h.length - 1];
      if (previous !== undefined) setSalt(previous);
      return h.slice(0, -1);
    });
  }, []);

  const open = useCallback((next: Viewing) => {
    setStatus(null);
    setViewing(next);
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (viewing && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      setViewingKey((k) => k + 1);
    }
    if (!viewing && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
  }, [viewing]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (viewing) {
        if (event.key === 'ArrowRight' && viewing.list.length > 1) setViewing({ ...viewing, index: (viewing.index + 1) % viewing.list.length });
        if (event.key === 'ArrowLeft' && viewing.list.length > 1) setViewing({ ...viewing, index: (viewing.index + viewing.list.length - 1) % viewing.list.length });
        return;
      }
      if (event.key === 's' || event.key === 'S') shuffle();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewing, shuffle]);

  const chosen = viewing ? (viewing.list[viewing.index] as BackdropChoice) : null;
  const chosenIsCurrent = chosen ? locked && sameChoice(chosen, current) : false;

  async function use(choice: BackdropChoice) {
    setStatus({ kind: 'busy', message: 'Saving…' });
    try {
      const result = await onUse(choice);
      setStatus({ kind: 'ok', message: result.message, ...(result.detail !== undefined && { detail: result.detail }) });
    } catch (error) {
      setStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  const view = PREVIEW_FRAMES[frame];
  const stageHeight = typeof window === 'undefined' ? 600 : Math.max(240, window.innerHeight - 340);
  const stageDisplay = Math.max(0, Math.min(stageWidth, Math.round((stageHeight * view.width) / view.height)));

  return (
    <SiteNameContext.Provider value={siteName}>
    <div className="akp" data-auth-kit-backdrop-picker={BACKDROP_PICKER_MARKER}>
      <style>{PICKER_CSS}</style>
      <header className="akp-header">
        <div className="akp-heading">
          <p className="akp-eyebrow">Backdrop picker · local development only</p>
          <h1 className="akp-title">Choose a backdrop for {siteName}</h1>
          <p className="akp-lede">
            Nine variations behind the real sign-in card. Shuffle for nine more, then open one to see it large and choose it. Your choice is saved locked: it never changes unless you choose again here.
          </p>
        </div>
        <div className="akp-current">
          <div className="akp-current-row">
            <span className="akp-current-label">{locked ? 'Current backdrop' : 'Drawn now (not locked)'}</span>
            <span className={`akp-badge ${locked ? 'akp-badge-ok' : 'akp-badge-warn'}`}>{locked ? 'Locked' : 'Not locked'}</span>
          </div>
          {shown ? (
            // A div with a covering button: the preview holds the real card, whose own buttons can't sit inside a button.
            <div className="akp-current-open">
              <span className="akp-current-thumb">{mounted ? <Scene choice={shown} family={siteFamily} frame="desktop" displayWidth={152} renderCard={renderCard} maxFps={15} paused={viewing !== null} /> : null}</span>
              <span className="akp-current-text">
                {describeChoice(shown)}
                <span className="akp-current-sub">{locked ? `${labels(siteFamily)} · open` : 'Proposed from the site’s name'}</span>
              </span>
              <button type="button" className="akp-open" onClick={() => open({ list: [shown], index: 0, kind: 'current' })} aria-label={`${describeChoice(shown)}. Open it large.`} />
            </div>
          ) : (
            <p className="akp-current-sub">Nothing chosen yet.</p>
          )}
        </div>
      </header>

      {!locked ? <div className="akp-notice akp-notice-warn">{props.unlockedHelp ?? 'This site’s backdrop isn’t locked yet: it’s proposed from the site’s name, so renaming the site would change it. Choose one below to lock it.'}</div> : null}
      {offer ? (
        <div className="akp-notice">
          {backdropStyle(offer.current.style)?.label} has a newer version (v{offer.upgrade.styleVersion}) that draws the same seed differently. Your site keeps v{offer.current.styleVersion} until you choose otherwise.{' '}
          <button type="button" className="akp-link" onClick={() => open({ list: [offer.current, offer.upgrade], index: 1, kind: 'upgrade' })}>
            Compare v{offer.current.styleVersion} and v{offer.upgrade.styleVersion}
          </button>
        </div>
      ) : null}

      <div className="akp-toolbar">
        <label className="akp-field">
          <span className="akp-field-label">Style</span>
          <select className="akp-select" value={filter} onChange={(e) => setFilter(e.target.value as StyleFilter)}>
            <option value="mix">Mix all styles</option>
            {offeredStyles().map((id) => (
              <option key={id} value={id}>
                {backdropStyle(id)?.label ?? id}
              </option>
            ))}
          </select>
        </label>
        <Segmented
          label="Family preview"
          value={family}
          options={BACKDROP_FAMILY_IDS.map((f) => ({ value: f, label: f === siteFamily ? `${labels(f)} (this site)` : labels(f) }))}
          onChange={setFamily}
        />
        <Segmented label="Frame" value={frame} options={[{ value: 'desktop', label: 'Desktop' }, { value: 'phone', label: 'Phone' }]} onChange={setFrame} />
        <div className="akp-toolbar-actions">
          <button type="button" className="akp-button" onClick={back} disabled={history.length === 0}>
            Previous nine
          </button>
          <button type="button" className="akp-button akp-button-primary" onClick={shuffle}>
            Shuffle <kbd className="akp-kbd">S</kbd>
          </button>
        </div>
      </div>
      {family !== siteFamily ? (
        <p className="akp-hint">
          Previewing {labels(family)} colors. The family is part of the site’s identity, set in its config; choosing a backdrop here saves only the style and seed.
        </p>
      ) : null}

      <div className={`akp-grid akp-grid-${frame}`}>
        {mounted
          ? variations.map((choice, i) => (
              <Tile
                key={`${salt}-${filter}-${i}`}
                index={i}
                choice={choice}
                family={family}
                frame={frame}
                isCurrent={locked && sameChoice(choice, current)}
                paused={viewing !== null}
                renderCard={renderCard}
                onOpen={() => open({ list: variations, index: i, kind: 'variation' })}
              />
            ))
          : null}
      </div>

      <dialog ref={dialogRef} className="akp-dialog" onClose={() => setViewing(null)} aria-label="Backdrop, large">
        {viewing && chosen ? (
          <div className="akp-dialog-body">
            <div className="akp-dialog-top">
              <div>
                <p className="akp-eyebrow">
                  {viewing.kind === 'variation' ? `Variation ${viewing.index + 1} of ${viewing.list.length}` : viewing.kind === 'upgrade' ? (viewing.index === 0 ? 'Your site now' : 'The same seed, newest version') : locked ? 'Your current backdrop' : 'Proposed from the site’s name'}
                </p>
                <h2 className="akp-dialog-title">
                  {backdropStyle(chosen.style)?.label} <span className="akp-pill">v{chosen.styleVersion}</span>
                </h2>
                <p className="akp-dialog-desc">
                  {backdropStyle(chosen.style)?.description} Seed <code className="akp-seed">{chosen.seed}</code> · {labels(family)} colors.
                </p>
              </div>
              <button type="button" className="akp-button" onClick={() => setViewing(null)}>
                Back to the grid
              </button>
            </div>
            <div ref={stageRef} className={`akp-stage akp-stage-${frame}`}>
              <div className={`akp-frame akp-frame-large akp-tile-${frame}`} style={{ width: stageDisplay || undefined }}>
                <Scene key={`${chosen.style}-${chosen.seed}-${chosen.styleVersion}-${family}-${frame}`} choice={chosen} family={family} frame={frame} displayWidth={stageDisplay} renderCard={renderCard} />
              </div>
            </div>
            <div className="akp-dialog-actions">
              {viewing.list.length > 1 ? (
                <div className="akp-nav">
                  <button type="button" className="akp-button" onClick={() => setViewing({ ...viewing, index: (viewing.index + viewing.list.length - 1) % viewing.list.length })} aria-label="Previous">
                    ←
                  </button>
                  <button type="button" className="akp-button" onClick={() => setViewing({ ...viewing, index: (viewing.index + 1) % viewing.list.length })} aria-label="Next">
                    →
                  </button>
                </div>
              ) : (
                <span />
              )}
              <div className="akp-use">
                {status ? (
                  <div className={`akp-status akp-status-${status.kind}`} role={status.kind === 'error' ? 'alert' : 'status'}>
                    <span>{status.message}</span>
                    {status.detail ? <pre className="akp-detail">{status.detail}</pre> : null}
                  </div>
                ) : null}
                {chosenIsCurrent ? (
                  <span className="akp-badge akp-badge-ok">This is the site’s backdrop</span>
                ) : (
                  <button type="button" className="akp-button akp-button-primary akp-button-large" disabled={status?.kind === 'busy'} onClick={() => void use(chosen)}>
                    Use this one
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </dialog>
    </div>
    </SiteNameContext.Provider>
  );
}

const PICKER_CSS = `
.akp { --akp-ink: #15181e; --akp-muted: #5a6170; --akp-line: #e2e5ea; --akp-bg: #f4f5f7; --akp-surface: #fff; --akp-accent: #15181e; --akp-ok: #1d7a3a; --akp-warn: #8a5a00;
  color-scheme: light; background: var(--akp-bg); color: var(--akp-ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; min-height: 100vh; padding: 28px clamp(16px, 3vw, 40px) 64px; box-sizing: border-box; }
.akp *, .akp *::before, .akp *::after { box-sizing: border-box; }
.akp-header { display: flex; flex-wrap: wrap; gap: 20px 40px; align-items: flex-start; justify-content: space-between; max-width: 1480px; margin: 0 auto 18px; }
.akp-heading { flex: 1 1 520px; min-width: 0; }
.akp-eyebrow { margin: 0 0 6px; font-size: 12px; font-weight: 650; letter-spacing: 0.08em; text-transform: uppercase; color: var(--akp-muted); }
.akp-title { margin: 0 0 8px; font-size: clamp(24px, 2.4vw, 32px); line-height: 1.15; letter-spacing: -0.015em; font-weight: 700; }
.akp-lede { margin: 0; color: var(--akp-muted); max-width: 68ch; }
.akp-current { flex: 0 1 360px; background: var(--akp-surface); border: 1px solid var(--akp-line); border-radius: 14px; padding: 12px 14px; box-shadow: 0 1px 2px rgba(16,24,40,.04); }
.akp-current-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 10px; }
.akp-current-label { font-size: 12px; font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase; color: var(--akp-muted); }
.akp-current-open { position: relative; display: flex; gap: 12px; align-items: center; width: 100%; border-radius: 8px; }
.akp-current-thumb { flex: none; width: 152px; height: 95px; border-radius: 8px; overflow: hidden; background: #e9ecf0; box-shadow: 0 0 0 1px rgba(16,24,40,.08); }
.akp-current-text { display: grid; gap: 2px; font-weight: 600; font-size: 14px; min-width: 0; overflow-wrap: anywhere; }
.akp-current-sub { font-weight: 400; color: var(--akp-muted); font-size: 13px; margin: 0; }
.akp-notice { max-width: 1480px; margin: 0 auto 14px; padding: 10px 14px; border-radius: 10px; background: #eef4fb; border: 1px solid #d6e4f5; color: #1c3550; }
.akp-notice-warn { background: #fdf6e7; border-color: #f1e0b8; color: #5c4200; }
.akp-link { font: inherit; color: inherit; background: none; border: 0; padding: 0; text-decoration: underline; font-weight: 600; cursor: pointer; }
.akp-toolbar { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; gap: 14px 22px; align-items: flex-end; max-width: 1480px; margin: 0 auto; padding: 12px 0 14px; background: linear-gradient(var(--akp-bg) 85%, rgba(244,245,247,0)); }
.akp-field { display: grid; gap: 6px; }
.akp-field-label { font-size: 12px; font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase; color: var(--akp-muted); }
.akp-select { font: inherit; height: 38px; padding: 0 34px 0 12px; border-radius: 10px; border: 1px solid var(--akp-line); background: var(--akp-surface); color: inherit; }
.akp-segmented { display: inline-flex; padding: 3px; gap: 2px; border-radius: 11px; background: #e7e9ed; }
.akp-segment { font: inherit; font-size: 14px; height: 32px; padding: 0 12px; border: 0; border-radius: 8px; background: transparent; color: var(--akp-muted); cursor: pointer; white-space: nowrap; }
.akp-segment[aria-checked="true"] { background: var(--akp-surface); color: var(--akp-ink); font-weight: 600; box-shadow: 0 1px 2px rgba(16,24,40,.12); }
.akp-segment:focus-visible, .akp-button:focus-visible, .akp-select:focus-visible, .akp-open:focus-visible, .akp-link:focus-visible { outline: 3px solid #3892e1; outline-offset: 2px; }
.akp-toolbar-actions { margin-left: auto; display: flex; gap: 10px; }
.akp-button { font: inherit; font-weight: 600; font-size: 14px; height: 38px; padding: 0 14px; border-radius: 10px; border: 1px solid var(--akp-line); background: var(--akp-surface); color: var(--akp-ink); cursor: pointer; display: inline-flex; align-items: center; gap: 8px; }
.akp-button:disabled { opacity: .45; cursor: default; }
.akp-button-primary { background: var(--akp-accent); border-color: var(--akp-accent); color: #fff; }
.akp-button-large { height: 46px; padding: 0 22px; font-size: 15px; }
.akp-kbd { font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 3px 5px; border-radius: 5px; background: rgba(255,255,255,.18); }
.akp-hint { max-width: 1480px; margin: 0 auto 10px; color: var(--akp-muted); font-size: 14px; }
.akp-grid { display: grid; gap: 28px 24px; max-width: 1480px; margin: 8px auto 0; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.akp-grid-phone { grid-template-columns: repeat(3, minmax(0, 300px)); justify-content: center; gap: 28px 48px; }
@media (max-width: 860px) { .akp-grid, .akp-grid-phone { grid-template-columns: minmax(0, 1fr); } }
.akp-tile { margin: 0; display: grid; gap: 10px; }
.akp-frame { position: relative; border-radius: 12px; overflow: hidden; background: #e9ecf0; box-shadow: 0 1px 2px rgba(16,24,40,.06), 0 0 0 1px rgba(16,24,40,.07); transition: transform .18s ease, box-shadow .18s ease; }
.akp-tile-phone .akp-frame, .akp-frame.akp-tile-phone { border-radius: 30px; box-shadow: 0 0 0 7px #1f2329, 0 18px 40px -18px rgba(16,24,40,.45); }
.akp-tile:hover .akp-frame { transform: translateY(-2px); box-shadow: 0 2px 4px rgba(16,24,40,.06), 0 16px 32px -16px rgba(16,24,40,.35), 0 0 0 1px rgba(16,24,40,.08); }
.akp-tile-phone:hover .akp-frame { box-shadow: 0 0 0 7px #1f2329, 0 22px 44px -18px rgba(16,24,40,.5); }
.akp-open { position: absolute; inset: 0; z-index: 2; width: 100%; height: 100%; border: 0; padding: 0; background: transparent; cursor: zoom-in; border-radius: inherit; }
.akp-caption { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; padding: 0 2px; }
.akp-caption-style { font-weight: 650; display: inline-flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.akp-pill { font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 3px 6px; border-radius: 6px; background: #e7e9ed; color: var(--akp-muted); vertical-align: middle; }
.akp-seed { font: 12px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--akp-muted); }
.akp-badge { font-size: 12px; font-weight: 650; padding: 3px 8px; border-radius: 999px; white-space: nowrap; }
.akp-badge-ok { background: #e3f3e8; color: var(--akp-ok); }
.akp-badge-warn { background: #fbefd4; color: var(--akp-warn); }
.akp-scene-clip { position: relative; overflow: hidden; }
.akp-scene { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.akp-scene-placeholder { aspect-ratio: 16 / 10; }
.akp-backdrop { width: 100%; height: 100%; }
.akp-backdrop-content { width: 100%; height: 100%; }
.akp-card-wrap { width: 100%; height: 100%; display: grid; place-items: center; padding: 24px; }
.akp-card-wrap-phone { padding: 16px; align-items: start; padding-top: 72px; }
.akp-card-inert { display: contents; }
.akp-dialog { width: min(1280px, 96vw); max-width: none; max-height: 96vh; padding: 0; border: 0; border-radius: 18px; background: var(--akp-surface); color: var(--akp-ink); box-shadow: 0 30px 80px -20px rgba(10,14,20,.5); }
.akp-dialog::backdrop { background: rgba(14,17,23,.55); backdrop-filter: blur(6px); }
.akp-dialog-body { display: grid; gap: 16px; padding: 22px 24px 22px; }
.akp-dialog-top { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
.akp-dialog-title { margin: 0 0 4px; font-size: 24px; letter-spacing: -0.01em; display: flex; align-items: center; gap: 10px; }
.akp-dialog-desc { margin: 0; color: var(--akp-muted); max-width: 80ch; }
.akp-stage { display: grid; place-items: center; min-height: 240px; padding: 8px 0; }
.akp-frame-large { border-radius: 14px; }
.akp-dialog-actions { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
.akp-nav { display: flex; gap: 8px; }
.akp-use { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; justify-content: flex-end; margin-left: auto; }
.akp-status { display: grid; gap: 6px; font-size: 14px; max-width: 640px; }
.akp-status-ok { color: var(--akp-ok); }
.akp-status-error { color: #b3261e; font-weight: 600; }
.akp-status-busy { color: var(--akp-muted); }
.akp-detail { margin: 0; padding: 8px 10px; border-radius: 8px; background: #f3f5f7; color: #2a2f37; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
`;
