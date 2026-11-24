/**
 * `auth-kit/ribbon`: the environment ribbon, its pure metadata/model helpers, and the View as banner
 * (primer Chapter 8, Figure 8.3; Chapter 7, View as).
 *
 * **Server- and client-safe barrel**: pure functions (`environmentRibbonModel`, `environmentMetadata`,
 * `resolveEnvironment`) stay server-callable inside Next.js `generateMetadata()` and Server Components,
 * while `<EnvironmentRibbon />` lives in `./ribbon-client.js` (`'use client'`) so its scroll, pin, and
 * `[data-env-badge-slot]` hooks hydrate cleanly on the client.
 */
import type { CSSProperties, ReactElement } from 'react';
import { RIBBON_COLORS } from './ribbon-model.js';

export {
  EnvironmentRibbon,
  RIBBON_PIN_STORAGE_KEY,
  type EnvironmentRibbonProps,
} from './ribbon-client.js';

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

const Z_INDEX = 2_147_483_000;

const VIEW_AS_BAR: CSSProperties = {
  boxSizing: 'border-box',
  minHeight: 28,
  position: 'sticky',
  top: 0,
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
  color: '#ffffff',
  letterSpacing: '0.01em',
};

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
        style={{ ...VIEW_AS_BAR, background: color }}
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
