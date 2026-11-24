'use client';
/**
 * `auth-kit/ribbon`: the environment ribbon, its corner badge (`L`, `P`, `?`, `!`), and the View as
 * banner (primer Chapter 8, Figure 8.3; Chapter 7, View as).
 *
 * **Safe in production builds**, unlike `auth-kit/dev`: preview branches run production builds and
 * still show a ribbon, and View as runs on the live site. Nothing here signs anyone in, reads AWS,
 * or contains the dev sign-in marker. All styling uses React `style` props (`style-src-attr`), so
 * strict nonce CSPs need no `<style>` tag.
 *
 * Behavior:
 * - Renders a slim 28 px bar at the top of the page under `next dev` and on preview branches (never
 *   on the live site). By default it sits in normal document flow and scrolls away with the page;
 *   clicking `Pin` keeps it at `top: 0` and sets `--ak-ribbon-height: 28px` on `<html>`.
 * - Once the bar scrolls off screen (or is collapsed to badge mode), an 18 px environment badge
 *   mounts into `feedback-kit`'s `[data-env-badge-slot]` (or renders a 24 px standalone fallback at
 *   `bottom: 16px; left: 16px` on sites without `feedback-kit`). Clicking the badge opens the
 *   environment details panel above the bottom-left corner.
 */
import {
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import {
  type EnvironmentBadgeLetter,
  environmentBadgeModel,
  type EnvironmentRibbonInput,
  environmentRibbonModel,
  RIBBON_COLORS,
  type RibbonBarVariant,
} from './ribbon-model.js';

export {
  environmentRibbonModel,
  environmentBadgeModel,
  isPlaceholderPoolId,
  resolveEnvironment,
  environmentMetadata,
  viewAsMetadata,
  environmentFavicon,
  RIBBON_COLORS,
  type RibbonEnvironment,
  type RibbonTone,
  type RibbonBarVariant,
  type EnvironmentBadgeLetter,
  type EnvironmentBadgeModel,
  type EnvironmentRibbonInput,
  type EnvironmentRibbonModel,
  type ResolveEnvironmentInput,
  type TitleMetadata,
} from './ribbon-model.js';

/** Above app content and feedback overlays, below nothing. */
const Z_INDEX = 2_147_483_000;

export const RIBBON_PIN_STORAGE_KEY = 'auth-kit:ribbon-pinned';

const BAR_BASE: CSSProperties = {
  boxSizing: 'border-box',
  minHeight: 28,
  zIndex: Z_INDEX,
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '4px 8px',
  padding: '3px 12px',
  fontFamily: 'inherit',
  fontSize: 12,
  fontWeight: 500,
  lineHeight: 1.35,
  letterSpacing: '0.01em',
};

const BAR_PALETTE: Record<RibbonBarVariant, { background: string; color: string; chipBorder: string; chipBg: string }> = {
  calm: {
    background: RIBBON_COLORS.calm,
    color: '#ffffff',
    chipBorder: 'rgba(255, 255, 255, 0.34)',
    chipBg: 'rgba(255, 255, 255, 0.10)',
  },
  sandbox: {
    background: RIBBON_COLORS.local,
    color: '#ffffff',
    chipBorder: 'rgba(255, 255, 255, 0.42)',
    chipBg: 'rgba(255, 255, 255, 0.14)',
  },
  preview: {
    background: RIBBON_COLORS.preview,
    color: '#ffffff',
    chipBorder: 'rgba(255, 255, 255, 0.38)',
    chipBg: 'rgba(255, 255, 255, 0.12)',
  },
  caution: {
    background: '#fbd46a',
    color: '#1e293b',
    chipBorder: 'rgba(15, 23, 42, 0.28)',
    chipBg: 'rgba(255, 255, 255, 0.45)',
  },
  danger: {
    background: `repeating-linear-gradient(-45deg, ${RIBBON_COLORS.danger} 0 12px, #991b1b 12px 24px)`,
    color: '#ffffff',
    chipBorder: 'rgba(255, 255, 255, 0.50)',
    chipBg: 'rgba(15, 23, 42, 0.22)',
  },
};

function badgeInlineStyle(letter: EnvironmentBadgeLetter, diameterPx: 18 | 24): CSSProperties {
  const isAlert = letter === '?' || letter === '!';
  const size = isAlert && diameterPx === 18 ? 20 : diameterPx;
  const fontSize = diameterPx === 24 ? '11px' : '9.5px';
  return {
    boxSizing: 'border-box',
    width: `${String(size)}px`,
    height: `${String(size)}px`,
    minWidth: `${String(size)}px`,
    minHeight: `${String(size)}px`,
    padding: '0',
    margin: '0',
    borderRadius: '999px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    font: `700 ${fontSize}/1 system-ui, -apple-system, "Segoe UI", sans-serif`,
    background: letter === '!' ? '#b91c1c' : letter === '?' ? '#d97706' : '#ffffff',
    color: isAlert ? '#ffffff' : '#3d4250',
    border: isAlert ? '2px solid #ffffff' : '1px solid #cfd3da',
    boxShadow: isAlert ? '0 1px 4px rgba(15, 23, 42, 0.18)' : '0 1px 4px rgba(15, 23, 42, 0.12)',
    cursor: 'pointer',
    lineHeight: '1',
  };
}

export interface EnvironmentRibbonProps extends EnvironmentRibbonInput {
  /** Extra controls at the end of the bar, such as `<PersonaMenu />` from `auth-kit/dev/menu` (dev only). */
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/** A 28 px environment bar + `[data-env-badge-slot]` corner badge. Renders nothing on the live site. */
export function EnvironmentRibbon(props: EnvironmentRibbonProps): ReactElement | null {
  const { children, className, style, ...input } = props;
  const m = environmentRibbonModel(input);
  const badge = environmentBadgeModel(input);

  const barRef = useRef<HTMLDivElement | null>(null);
  const detailsRef = useRef<HTMLDivElement | null>(null);
  const fallbackBadgeRef = useRef<HTMLButtonElement | null>(null);
  const slotBadgeBtnRef = useRef<HTMLButtonElement | null>(null);
  const detailsTitleId = useId();

  const [pinned, setPinned] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [scrolledOff, setScrolledOff] = useState(false);
  const [hasSlotInDom, setHasSlotInDom] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  // Restore saved pin state on client mount.
  useEffect(() => {
    if (!m.show || typeof window === 'undefined') return;
    try {
      if (window.localStorage.getItem(RIBBON_PIN_STORAGE_KEY) === '1') {
        setPinned(true);
      }
    } catch {
      // Ignore restricted storage environments.
    }
  }, [m.show]);

  const togglePin = useCallback((nextPinned?: boolean) => {
    setPinned((prev) => {
      const next = nextPinned ?? !prev;
      if (next) {
        setCollapsed(false);
        setDetailsOpen(false);
      }
      try {
        window.localStorage.setItem(RIBBON_PIN_STORAGE_KEY, next ? '1' : '0');
      } catch {
        // Ignore restricted storage environments.
      }
      return next;
    });
  }, []);

  // Maintain `--ak-ribbon-height: 28px` on `<html>` when pinned and visible (unset otherwise).
  useEffect(() => {
    if (typeof document === 'undefined' || !document.documentElement) return;
    const root = document.documentElement;
    if (m.show && pinned && !collapsed) {
      root.style.setProperty('--ak-ribbon-height', '28px');
    } else {
      root.style.removeProperty('--ak-ribbon-height');
    }
    return () => {
      root.style.removeProperty('--ak-ribbon-height');
    };
  }, [m.show, pinned, collapsed]);

  // Track whether the unpinned top bar has scrolled off the top of the viewport.
  useEffect(() => {
    if (!m.show || pinned || collapsed || typeof window === 'undefined') {
      setScrolledOff(false);
      return;
    }
    const el = barRef.current;
    if (!el) return;

    const checkScroll = () => {
      const rect = el.getBoundingClientRect();
      setScrolledOff(rect.bottom <= 2);
    };
    checkScroll();

    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(
        (entries) => {
          const entry = entries[0];
          if (entry) setScrolledOff(!entry.isIntersecting && entry.boundingClientRect.bottom <= 2);
        },
        { threshold: 0 },
      );
      io.observe(el);
    }

    window.addEventListener('scroll', checkScroll, { passive: true, capture: true });
    window.addEventListener('resize', checkScroll, { passive: true });
    return () => {
      io?.disconnect();
      window.removeEventListener('scroll', checkScroll, true);
      window.removeEventListener('resize', checkScroll);
    };
  }, [m.show, pinned, collapsed]);

  const showBadge = Boolean(m.show && badge && !pinned && (scrolledOff || collapsed));

  useEffect(() => {
    if (!showBadge) {
      setDetailsOpen(false);
    }
  }, [showBadge]);

  // Mount the 18 px badge directly into feedback-kit's `[data-env-badge-slot]` whenever present.
  useEffect(() => {
    if (!m.show || !badge || typeof document === 'undefined') {
      setHasSlotInDom(false);
      return;
    }

    let mountedBtn: HTMLButtonElement | null = null;
    let currentSlot: HTMLElement | null = null;

    const teardownBtn = () => {
      if (mountedBtn) {
        mountedBtn.remove();
        mountedBtn = null;
      }
      slotBadgeBtnRef.current = null;
      currentSlot = null;
    };

    const syncSlot = () => {
      const slot = document.querySelector<HTMLElement>('[data-env-badge-slot]');
      setHasSlotInDom(Boolean(slot));
      if (!showBadge || !slot) {
        teardownBtn();
        return;
      }
      if (currentSlot !== slot || !mountedBtn) {
        teardownBtn();
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-auth-kit-ui', 'true');
        btn.setAttribute('data-auth-kit-env-badge', badge.letter);
        btn.addEventListener('click', (event) => {
          event.stopPropagation();
          setDetailsOpen((o) => !o);
        });
        slot.appendChild(btn);
        mountedBtn = btn;
        slotBadgeBtnRef.current = btn;
        currentSlot = slot;
      }
      mountedBtn.textContent = badge.letter;
      mountedBtn.title = badge.tooltip;
      mountedBtn.setAttribute('aria-label', badge.tooltip);
      mountedBtn.setAttribute('aria-expanded', String(detailsOpen));
      mountedBtn.setAttribute('data-auth-kit-env-badge', badge.letter);
      Object.assign(mountedBtn.style, badgeInlineStyle(badge.letter, 18));
    };

    syncSlot();

    let mo: MutationObserver | null = null;
    if (typeof MutationObserver !== 'undefined' && document.body) {
      mo = new MutationObserver(() => {
        const nextSlot = document.querySelector<HTMLElement>('[data-env-badge-slot]');
        if (nextSlot !== currentSlot || (showBadge && nextSlot && (!mountedBtn || !nextSlot.contains(mountedBtn)))) {
          syncSlot();
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }

    return () => {
      mo?.disconnect();
      teardownBtn();
    };
  }, [m.show, badge, showBadge, detailsOpen]);

  // Close details panel on outside pointerdown or Escape, returning focus to the badge button.
  useEffect(() => {
    if (!detailsOpen || typeof document === 'undefined') return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (!target) return;
      if (detailsRef.current?.contains(target)) return;
      if (slotBadgeBtnRef.current?.contains(target)) return;
      if (fallbackBadgeRef.current?.contains(target)) return;
      setDetailsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setDetailsOpen(false);
        (slotBadgeBtnRef.current ?? fallbackBadgeRef.current)?.focus();
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [detailsOpen]);

  if (!m.show || m.tone === 'none' || !badge) return null;

  const palette = BAR_PALETTE[badge.barVariant];
  const chipButtonStyle: CSSProperties = {
    font: 'inherit',
    fontSize: 11,
    fontWeight: 600,
    lineHeight: 1.2,
    color: palette.color,
    background: palette.chipBg,
    border: `1px solid ${palette.chipBorder}`,
    borderRadius: 3,
    padding: '2px 7px',
    cursor: 'pointer',
  };

  return (
    <>
      {badge.frame !== 'none' && (
        <div
          aria-hidden="true"
          data-auth-kit-env-frame={badge.frame}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: Z_INDEX,
            pointerEvents: 'none',
            border: badge.frame === 'danger' ? '3px solid #b91c1c' : '2px solid #e0a526',
          }}
        />
      )}

      {!collapsed && (
        <div
          ref={barRef}
          role="region"
          aria-label="Environment"
          data-auth-kit-ribbon={m.tone}
          data-auth-kit-bar-variant={badge.barVariant}
          data-auth-kit-ui="true"
          title={m.label}
          className={className}
          style={{
            ...BAR_BASE,
            position: pinned ? 'sticky' : 'relative',
            ...(pinned ? { top: 0 } : {}),
            background: palette.background,
            color: palette.color,
            ...style,
          }}
        >
          <strong style={{ fontWeight: 700 }}>{m.heading}</strong>
          {m.details.map((detail) => (
            <span key={detail}>
              <span aria-hidden="true">· </span>
              {detail}
            </span>
          ))}
          <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {children}
            <button
              type="button"
              data-auth-kit-ui="true"
              data-auth-kit-pin=""
              aria-pressed={pinned}
              aria-label="Keep environment bar pinned at top"
              title={pinned ? 'Pinned at top (click to let bar scroll with page)' : 'Keep bar pinned at top'}
              style={chipButtonStyle}
              onClick={() => togglePin()}
            >
              {pinned ? 'Pinned' : 'Pin'}
            </button>
            {badge.barVariant !== 'danger' && (
              <button
                type="button"
                data-auth-kit-ui="true"
                data-auth-kit-collapse=""
                aria-label="Collapse environment bar to corner badge"
                title="Collapse bar to corner badge"
                style={{ ...chipButtonStyle, padding: '2px 6px' }}
                onClick={() => {
                  setPinned(false);
                  setCollapsed(true);
                }}
              >
                ✕
              </button>
            )}
          </span>
        </div>
      )}

      {showBadge && !hasSlotInDom && (
        <button
          ref={fallbackBadgeRef}
          type="button"
          data-auth-kit-ui="true"
          data-auth-kit-env-badge={badge.letter}
          data-auth-kit-env-fallback=""
          aria-label={badge.tooltip}
          aria-expanded={detailsOpen}
          title={badge.tooltip}
          onClick={() => setDetailsOpen((o) => !o)}
          style={{
            ...badgeInlineStyle(badge.letter, 24),
            position: 'fixed',
            bottom: 16,
            left: 16,
            zIndex: Z_INDEX,
          }}
        >
          {badge.letter}
        </button>
      )}

      {showBadge && detailsOpen && (
        <div
          ref={detailsRef}
          role="dialog"
          aria-labelledby={detailsTitleId}
          data-auth-kit-ui="true"
          data-auth-kit-env-details=""
          style={{
            position: 'fixed',
            bottom: 58,
            left: 16,
            zIndex: Z_INDEX + 1,
            width: 'min(320px, calc(100vw - 32px))',
            background: 'rgba(255, 252, 249, 0.98)',
            backdropFilter: 'blur(14px) saturate(150%)',
            WebkitBackdropFilter: 'blur(14px) saturate(150%)',
            color: '#0f172a',
            border: '1px solid #cbd5e1',
            borderRadius: 6,
            boxShadow: '0 14px 34px rgba(15, 23, 42, 0.20)',
            fontFamily: 'inherit',
            fontSize: 12.5,
            lineHeight: 1.45,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              padding: '8px 10px 8px 12px',
              borderBottom: '1px solid #cbd5e1',
            }}
          >
            <span id={detailsTitleId} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontWeight: 600 }}>
              <span aria-hidden="true" style={{ ...badgeInlineStyle(badge.letter, 18), cursor: 'default' }}>
                {badge.letter}
              </span>
              <span>{badge.summary}</span>
            </span>
            <button
              type="button"
              data-auth-kit-ui="true"
              aria-label="Close environment details"
              onClick={() => setDetailsOpen(false)}
              style={{
                font: 'inherit',
                fontSize: 12,
                color: '#475569',
                background: 'transparent',
                border: '1px solid transparent',
                borderRadius: 3,
                padding: '2px 6px',
                cursor: 'pointer',
              }}
            >
              ✕
            </button>
          </div>
          <div style={{ padding: '10px 12px', color: '#334155' }}>
            {m.details.map((detail) => (
              <div key={detail} style={{ marginBottom: 3 }}>
                · {detail}
              </div>
            ))}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 6,
              padding: '6px 10px 8px 12px',
              borderTop: '1px solid #cbd5e1',
            }}
          >
            {collapsed && (
              <button
                type="button"
                data-auth-kit-ui="true"
                onClick={() => {
                  setCollapsed(false);
                  setDetailsOpen(false);
                }}
                style={{
                  font: 'inherit',
                  fontSize: 12,
                  fontWeight: 500,
                  color: '#0f172a',
                  background: '#ffffff',
                  border: '1px solid #cbd5e1',
                  borderRadius: 3,
                  padding: '3px 9px',
                  cursor: 'pointer',
                }}
              >
                Show top bar
              </button>
            )}
            <button
              type="button"
              data-auth-kit-ui="true"
              onClick={() => togglePin(true)}
              style={{
                font: 'inherit',
                fontSize: 12,
                fontWeight: 600,
                color: '#0f172a',
                background: '#ffffff',
                border: '1px solid #cbd5e1',
                borderRadius: 3,
                padding: '3px 9px',
                cursor: 'pointer',
              }}
            >
              Pin bar at top
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export interface ViewAsBannerProps {
  /** Who the admin is viewing as: a role ("Admin – content only") or a person's name. */
  viewingAs: string;
  /**
   * Ends View as: a server action, or a URL the Exit button POSTs to. Ending is a state change the
   * audit log records, so it's a form submission, not a link.
   */
  exitAction: string | ((formData: FormData) => void | Promise<void>);
  /** Default "read-only". */
  note?: string;
  className?: string;
}

/**
 * The View as frame: a hatched border around the whole page and a sticky bar,
 * "Viewing as Admin – content only · read-only · Exit". The server still blocks every write; this only makes the
 * mode impossible to miss.
 */
export function ViewAsBanner(props: ViewAsBannerProps): ReactElement {
  const color = RIBBON_COLORS.viewAs;
  const action = props.exitAction;
  return (
    <>
      <div
        aria-hidden="true"
        data-auth-kit-view-as-border=""
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: Z_INDEX,
          pointerEvents: 'none',
          border: '6px solid transparent',
          borderImage: `repeating-linear-gradient(45deg, ${color} 0 10px, #ede9fe 10px 20px) 6`,
        }}
      />
      <div
        role="region"
        aria-label="View as"
        data-auth-kit-view-as=""
        data-auth-kit-ui="true"
        className={props.className}
        style={{
          ...BAR_BASE,
          position: 'sticky',
          top: 0,
          background: color,
          color: '#ffffff',
        }}
      >
        <span>
          Viewing as <strong style={{ fontWeight: 700 }}>{props.viewingAs}</strong>
          <span aria-hidden="true"> · </span>
          {props.note ?? 'read-only'}
        </span>
        <form action={action} {...(typeof action === 'string' ? { method: 'post' } : {})} style={{ marginLeft: 'auto', display: 'inline' }}>
          <button
            type="submit"
            data-auth-kit-ui="true"
            style={{
              font: 'inherit',
              fontWeight: 600,
              color,
              background: '#ffffff',
              border: 0,
              borderRadius: 3,
              padding: '2px 10px',
              cursor: 'pointer',
            }}
          >
            Exit
          </button>
        </form>
      </div>
    </>
  );
}
