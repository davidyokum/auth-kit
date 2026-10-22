/**
 * `<AuthKitPreview spec={…} />`: the real sign-in screens, held at one screen and state with sample data,
 * inert (ADR 0025). The components and their words are the live ones (`SignIn`, `SignUp`,
 * `RequestAccess`, `SignedOutEverywhere`); only the driver differs.
 */
import { type CSSProperties, type ReactNode, type SyntheticEvent, useLayoutEffect, useMemo, useRef } from 'react';
import { DriverContext } from '../client/driver.js';
import { RequestAccess } from '../client/RequestAccess.js';
import { SignedOutEverywhere } from '../client/SignedOutEverywhere.js';
import { SignIn } from '../client/SignIn.js';
import { SignUp } from '../client/SignUp.js';
import { PREVIEW_MARKER } from '../dev/marker.js';
import type { AccountCreationSettings, NormalizedAccountCreation } from '../shared/account-creation.js';
import { previewDriver } from './driver.js';
import { sampleQrCode } from './qr.js';
import { nextAfter, placementOf, resolvePreviewSpec } from './screens.js';
import type { PreviewActionInfo, PreviewSpec, ResolvedPreviewSpec } from './spec.js';
import { ensurePreviewStyles } from './styles.js';

export interface AuthKitPreviewProps {
  spec: PreviewSpec;
  /** Add the preview's stylesheet (the card's included) to the page or shadow root. Default true. */
  injectStyles?: boolean;
}

/** A control's words as a screen reader hears them (a form: its submit button's). */
function labelOf(control: Element | null | undefined): string {
  if (!control) return '';
  const target = control.tagName === 'FORM' ? (control.querySelector('button[type="submit"]') ?? control) : control;
  return (target.getAttribute('aria-label') ?? target.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** What's typed in the card's visible fields, by name. Password fields are left out. */
function valuesOf(stage: Element | null): Record<string, string> {
  const values: Record<string, string> = {};
  if (!stage) return values;
  for (const field of stage.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[name], textarea[name]')) {
    if (field.hidden || (field instanceof HTMLInputElement && (field.type === 'password' || field.type === 'hidden'))) continue;
    values[field.name] = field.value;
  }
  return values;
}

/** A stable key for a spec's drawable values: a new key draws the card afresh, held where the new spec says. */
export function previewKey(spec: PreviewSpec): string {
  return JSON.stringify(spec, (key, value: unknown) => (typeof value === 'function' ? undefined : value));
}

/** A checked setting as the screens take it (the domain list only in `domains` mode). */
function settingOf(n: NormalizedAccountCreation): AccountCreationSettings {
  return n.mode === 'domains' ? { mode: 'domains', domains: n.domains, requestsAlso: n.requestsAlso } : { mode: n.mode };
}

/** The real component for a placement, with the props a preview gives it. Exported for tests. */
export function PreviewCard(props: { r: ResolvedPreviewSpec; placement: ReturnType<typeof placementOf> }): ReactNode {
  const { r, placement } = props;
  const common = { siteName: r.siteName, theme: r.authTheme, headingLevel: r.headingLevel };
  switch (placement.component) {
    case 'sign-in':
      return (
        <SignIn
          {...common}
          help={r.help}
          passkeysEnabled={r.passkeysEnabled}
          emailCodeEnabled={r.emailCodeEnabled}
          accountCreation={settingOf(r.accountCreation)}
          inviteLine={r.inviteLine}
          troubleLink={r.troubleLink}
          // Notices on, with the route mounted, as the template sets them up (register A10).
          notices={{ mounted: true }}
          checkBreachedPassword={false}
          {...(placement.reauth && { reauth: true })}
          {...(placement.firstVisit && { firstVisit: true })}
          {...(r.qrCode && { renderQrCode: sampleQrCode })}
        />
      );
    case 'sign-up': {
      const setting: AccountCreationSettings = placement.signUpSetting ? settingOf(placement.signUpSetting) : { mode: 'domains', domains: [r.domain] };
      return (
        <SignUp
          {...common}
          help={r.help}
          accountCreation={setting}
          privacyNoticeUrl="/privacy"
          {...(setting.mode === 'open' && { termsUrl: '/terms' })}
          botNote={r.botNote}
          passkeysEnabled={r.passkeysEnabled}
          notices={{ mounted: true }}
          checkBreachedPassword={false}
          {...(r.qrCode && { renderQrCode: sampleQrCode })}
        />
      );
    }
    case 'request-access':
      return <RequestAccess {...common} help={r.help} privacyNoticeUrl="/privacy" />;
    case 'signed-out':
      return <SignedOutEverywhere {...common} />;
  }
}

/**
 * Draws one screen and state of the real card, inert: no network, no storage, no credentials, no
 * clipboard, no navigation. Every click or submit calls `spec.onAction(name, info)` and changes nothing;
 * typing in a field works (it's the card's own state). Throws `PreviewSpecError` for a spec it can't draw.
 */
export function AuthKitPreview(props: AuthKitPreviewProps): ReactNode {
  const { spec } = props;
  const key = previewKey(spec);
  // Keyed on the spec's drawable values, not its identity; the callbacks are read when a control is used.
  const r = useMemo(() => resolvePreviewSpec(spec), [key]);
  const placement = useMemo(() => placementOf(r), [r]);
  const stageRef = useRef<HTMLDivElement>(null);
  const latest = useRef(spec);
  latest.current = spec;

  const driver = useMemo(
    () =>
      previewDriver({
        held: placement.held,
        email: r.email,
        remembered: r.remembered,
        onAction(name: string, event: SyntheticEvent | undefined) {
          const handler = latest.current.onAction;
          if (!handler) return;
          const control = event?.currentTarget instanceof Element ? event.currentTarget : null;
          const info: PreviewActionInfo = { screen: r.screen, state: r.state, next: nextAfter(r, r.screen, name), label: labelOf(control), values: valuesOf(stageRef.current) };
          handler(name, info);
        },
        onEffect(name: string) {
          latest.current.onEffect?.(name);
        },
      }),
    [placement, r],
  );

  useLayoutEffect(() => {
    if (props.injectStyles !== false && stageRef.current) ensurePreviewStyles(stageRef.current);
  }, [props.injectStyles]);

  const style = { '--ak-preview-ground': r.groundColor, '--ak-preview-font': r.font } as CSSProperties;
  return (
    <div
      ref={stageRef}
      data-auth-kit-preview={PREVIEW_MARKER}
      data-auth-kit-device={r.device}
      data-auth-kit-preview-theme={r.theme}
      data-auth-kit-preview-style={r.cardStyle}
      data-auth-kit-preview-screen={r.screen}
      data-auth-kit-preview-state={r.state}
      {...(r.ground && { 'data-auth-kit-preview-ground': '' })}
      style={style}
      // A second guard behind the driver: no link navigates and no form submits from a preview.
      onClickCapture={(event) => {
        if (event.target instanceof Element && event.target.closest('a[href]')) event.preventDefault();
      }}
      onSubmitCapture={(event) => event.preventDefault()}
    >
      <DriverContext.Provider value={driver}>
        <PreviewCard key={key} r={r} placement={placement} />
      </DriverContext.Provider>
    </div>
  );
}
