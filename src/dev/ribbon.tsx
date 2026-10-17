/**
 * `auth-kit/ribbon`: the environment ribbon and the View as banner (primer Chapter 8, Figure 8.3;
 * Chapter 7, View as).
 *
 * **Safe in production builds**, unlike `auth-kit/dev`: preview branches run production builds and
 * still show a ribbon, and View as runs on the live site. Nothing here signs anyone in, reads AWS,
 * or contains the dev sign-in marker. Both components are plain markup with inline styles and no
 * hooks, so they render from server or client components.
 *
 * ```tsx
 * // app/layout.tsx (server component)
 * <EnvironmentRibbon environment={resolveEnvironment()} poolId={outputs.auth.user_pool_id} poolIsSandbox={null} />
 * ```
 */
import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { type EnvironmentRibbonInput, environmentRibbonModel, RIBBON_COLORS } from './ribbon-model.js';

export {
  environmentRibbonModel,
  resolveEnvironment,
  environmentMetadata,
  viewAsMetadata,
  environmentFavicon,
  RIBBON_COLORS,
  type RibbonEnvironment,
  type RibbonTone,
  type EnvironmentRibbonInput,
  type EnvironmentRibbonModel,
  type ResolveEnvironmentInput,
  type TitleMetadata,
} from './ribbon-model.js';

/** Above app content, below nothing: the ribbon must never be hidden by a sticky app header. */
const Z_INDEX = 2_147_483_000;

const BAR: CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: Z_INDEX,
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '4px 8px',
  padding: '4px 12px',
  font: '500 12px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
  color: '#fff',
  letterSpacing: '0.01em',
};

const BACKGROUND = {
  local: RIBBON_COLORS.local,
  preview: RIBBON_COLORS.preview,
  danger: `repeating-linear-gradient(-45deg, ${RIBBON_COLORS.danger} 0 12px, #991b1b 12px 24px)`,
} as const;

export interface EnvironmentRibbonProps extends EnvironmentRibbonInput {
  /** Extra controls at the end of the bar, such as `<PersonaMenu />` from `auth-kit/dev/menu` (dev only). */
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/** A colored bar naming the environment, the pool, and the persona. Renders nothing on the live site. */
export function EnvironmentRibbon(props: EnvironmentRibbonProps): ReactElement | null {
  const { children, className, style, ...input } = props;
  const m = environmentRibbonModel(input);
  if (!m.show || m.tone === 'none') return null;
  return (
    <div
      role="region"
      aria-label="Environment"
      data-auth-kit-ribbon={m.tone}
      title={m.label}
      className={className}
      style={{ ...BAR, background: BACKGROUND[m.tone], ...style }}
    >
      <strong style={{ fontWeight: 700 }}>{m.heading}</strong>
      {m.details.map((detail) => (
        <span key={detail}>
          <span aria-hidden="true">· </span>
          {detail}
        </span>
      ))}
      {children != null && <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center' }}>{children}</span>}
    </div>
  );
}

export interface ViewAsBannerProps {
  /** Who the admin is viewing as: a role ("Editor") or a person's name. */
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
 * "Viewing as Editor · read-only · Exit". The server still blocks every write; this only makes the
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
      <div role="region" aria-label="View as" data-auth-kit-view-as="" className={props.className} style={{ ...BAR, background: color }}>
        <span>
          Viewing as <strong style={{ fontWeight: 700 }}>{props.viewingAs}</strong>
          <span aria-hidden="true"> · </span>
          {props.note ?? 'read-only'}
        </span>
        <form action={action} {...(typeof action === 'string' ? { method: 'post' } : {})} style={{ marginLeft: 'auto', display: 'inline' }}>
          <button
            type="submit"
            style={{
              font: 'inherit',
              fontWeight: 600,
              color,
              background: '#fff',
              border: 0,
              borderRadius: 4,
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
