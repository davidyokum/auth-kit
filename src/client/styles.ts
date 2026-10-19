/**
 * Optional default styles: the card and its controls as the sign-in design studio draws them
 * (REPORT §7.1: one white card 380px wide, the defined 3:1 edge, 48px fields and buttons, 16px text, a
 * 3px focus ring; Card Studio v4), in the five card styles (register E5: Quiet by default; Monogram,
 * Frosted, Plain, Porcelain; `data-auth-kit-style` on the root, the values from `cardStyleVariables`). Every selector is wrapped in `:where()`, so it has zero specificity and any
 * site style wins. Colors come from the theme's CSS custom properties (`--ak-*`, set on the card by
 * `SignIn`, `SignUp`, `RequestAccess`; `themeCssVariables`), with the OSBM core as the fallback.
 * Add it to a global stylesheet, or render it with your CSP nonce: `<style nonce={nonce}>{authKitStyles}</style>`.
 *
 * The phone layout applies under 480px, and wherever an ancestor carries `data-auth-kit-device="phone"`
 * (a preview drawing a phone on a wide page, ADR 0025): the same declarations either way.
 */
/** The phone layout's rules, scoped: `''` for the media query, an ancestor selector for a forced phone. */
const phoneRules = (scope: string) =>
  `:where(${scope}[data-auth-kit] [data-auth-kit-slot="card"]) { padding: var(--ak-card-padding-phone, 28px 22px 20px); }
:where(${scope}[data-auth-kit-style="plain"])::before { position: absolute; left: -100vw; right: -100vw; width: auto; transform: none; top: -80px; bottom: -100vh; background: linear-gradient(180deg, transparent 0, var(--ak-ground, #f3f4f6) 56px); }`;

export const authKitStyles = `
:where([data-auth-kit]) { display: grid; gap: 1rem; max-width: 30rem; }
:where([data-auth-kit="sign-in"], [data-auth-kit="sign-up"], [data-auth-kit="request-access"], [data-auth-kit="signed-out"]) { display: block; width: 100%; max-width: var(--ak-card-width, 380px); margin-inline: auto; }
:where([data-auth-kit] [data-auth-kit-slot="card"]) { position: relative; display: grid; gap: 1rem; box-sizing: border-box; padding: var(--ak-card-padding, 36px 32px 24px); background: var(--ak-card-bg, var(--ak-surface, #fff)); color: var(--ak-text, #3c434b); border: 1px solid var(--ak-edge, #4a5f73); border-radius: var(--ak-card-radius, 12px); box-shadow: var(--ak-card-shadow, 0 1px 2px rgba(9, 41, 64, 0.05), 0 16px 36px -16px rgba(9, 41, 64, 0.22)); font-size: 1rem; line-height: 1.5; }
:where([data-auth-kit] [data-auth-kit-slot="monogram"]) { width: 44px; height: 44px; border-radius: 11px; display: grid; place-items: center; background: var(--ak-mono, #092940); color: var(--ak-mono-ink, #fff); font-weight: 700; font-size: 17px; letter-spacing: 0.05em; line-height: 1; margin-bottom: 6px; }
:where([data-auth-kit-style="frosted"] [data-auth-kit-slot="card"]) { -webkit-backdrop-filter: blur(18px) saturate(1.5); backdrop-filter: blur(18px) saturate(1.5); }
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) { :where([data-auth-kit-style="frosted"] [data-auth-kit-slot="card"]) { background: var(--ak-card-solid, #fff); } }
:where([data-auth-kit-style="plain"]) { position: relative; isolation: isolate; }
:where([data-auth-kit-style="plain"])::before { content: ""; position: fixed; z-index: -1; top: 0; bottom: 0; left: 50%; width: calc(var(--ak-card-width, 380px) + 184px); transform: translateX(-50%); pointer-events: none; background: linear-gradient(90deg, transparent 0, var(--ak-ground, #f3f4f6) 56px, var(--ak-ground, #f3f4f6) calc(100% - 56px), transparent 100%); }
@media (max-width: 480px) { ${phoneRules('')} }
${phoneRules('[data-auth-kit-device="phone"] ')}
:where([data-auth-kit-style="plain"] [data-auth-kit-slot="card"]) { background: transparent; border-color: transparent; box-shadow: none; }
:where([data-auth-kit-style="porcelain"] [data-auth-kit-slot="alts"]) { background: var(--ak-well, transparent); border-radius: 14px; padding: 2px 16px; }
:where([data-auth-kit-style="porcelain"] [data-auth-kit-slot="bottom"]) { border-top-color: transparent; padding-top: 6px; }
:where([data-auth-kit="totp-gate"]) { display: block; max-width: none; }
:where([data-auth-kit="totp-gate"] > [data-auth-kit-slot="content"][hidden]) { display: none !important; }
:where([data-auth-kit] [data-auth-kit-slot="form"], [data-auth-kit] [data-auth-kit-slot="section"], [data-auth-kit] [data-auth-kit-slot="content"]) { display: grid; gap: 1rem; }
:where([data-auth-kit] [data-auth-kit-slot="heading"]) { margin: 0; color: var(--ak-ink, #092940); font-size: 1.5rem; line-height: 1.25; display: flex; gap: 0.5rem; align-items: center; }
:where([data-auth-kit] [data-auth-kit-slot="heading"]:focus) { outline: none; }
:where([data-auth-kit] [data-auth-kit-slot="text"], [data-auth-kit] [data-auth-kit-slot="hint"], [data-auth-kit] [data-auth-kit-slot="small"], [data-auth-kit] [data-auth-kit-slot="who"]) { margin: 0; }
:where([data-auth-kit] [data-auth-kit-slot="hint"], [data-auth-kit] [data-auth-kit-slot="small"], [data-auth-kit] [data-auth-kit-slot="footer"], [data-auth-kit] [data-auth-kit-slot="notice"]) { font-size: 0.875rem; color: var(--ak-muted, #56606b); margin: 0; }
:where([data-auth-kit] [data-auth-kit-slot="field"]) { display: grid; gap: 0.375rem; }
:where([data-auth-kit] [data-auth-kit-slot="label"]) { font-weight: 600; color: var(--ak-ink, #092940); }
:where([data-auth-kit] [data-auth-kit-slot="input"]) { font: inherit; font-size: max(1rem, 16px); min-height: 48px; box-sizing: border-box; padding: 0.625rem 0.75rem; color: var(--ak-ink, #092940); background: #fff; border: 1px solid var(--ak-field-border, #6b7480); border-radius: var(--ak-control-radius, 8px); }
:where([data-auth-kit] [data-auth-kit-slot="inputWrap"]) { position: relative; display: grid; }
:where([data-auth-kit] [data-auth-kit-slot="inputWrap"] > svg) { position: absolute; left: 14px; top: 50%; transform: translateY(-50%); width: 20px; height: 20px; color: var(--ak-muted, #56606b); pointer-events: none; }
:where([data-auth-kit] [data-auth-kit-slot="input"][data-auth-kit-has-icon]) { padding-left: 44px; }
:where([data-auth-kit] textarea[data-auth-kit-slot="input"]) { min-height: 6rem; resize: vertical; }
:where([data-auth-kit] [data-auth-kit-slot="input"]::placeholder) { color: #646e79; }
:where([data-auth-kit] [data-auth-kit-slot="input"][aria-invalid="true"]) { border-color: var(--ak-error, #b42318); border-width: 2px; }
:where([data-auth-kit] :focus-visible) { outline: 3px solid var(--ak-focus, #3892e1); outline-offset: 2px; }
:where([data-auth-kit] [data-auth-kit-slot="fieldError"]) { margin: 0; color: var(--ak-error, #b42318); font-weight: 600; }
:where([data-auth-kit] [data-auth-kit-slot="summary"]) { display: flex; gap: 0.5rem; align-items: flex-start; padding: 0.75rem 0.875rem; border: 2px solid var(--ak-error, #b42318); border-radius: 8px; color: var(--ak-error, #b42318); font-weight: 600; }
:where([data-auth-kit] [data-auth-kit-slot="summary"][hidden]) { display: none; }
:where([data-auth-kit] [data-auth-kit-slot="summary"] p, [data-auth-kit] [data-auth-kit-slot="summary"] ul) { margin: 0; padding: 0; list-style: none; }
:where([data-auth-kit] [data-auth-kit-slot="summary"] a) { color: inherit; }
:where([data-auth-kit] [data-auth-kit-slot="note"], [data-auth-kit] [data-auth-kit-slot="wait"], [data-auth-kit] [data-auth-kit-slot="contact"]) { display: flex; gap: 0.5rem; align-items: flex-start; padding: 0.75rem 0.875rem; border-radius: var(--ak-control-radius, 8px); background: var(--ak-status, rgba(9, 41, 64, 0.045)); }
:where([data-auth-kit] [data-auth-kit-slot="note"] p) { margin: 0; }
:where([data-auth-kit] [data-auth-kit-slot="contact"]) { display: grid; gap: 0.25rem; }
:where([data-auth-kit] [data-auth-kit-slot="contact"] p) { margin: 0; }
:where([data-auth-kit] [data-auth-kit-slot="actions"]) { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; }
:where([data-auth-kit] [data-auth-kit-slot="button"], [data-auth-kit] [data-auth-kit-slot="secondaryButton"]) { font: inherit; min-height: 48px; padding: 0.625rem 1rem; border-radius: var(--ak-control-radius, 8px); cursor: pointer; display: inline-flex; gap: 0.5rem; align-items: center; justify-content: center; text-decoration: none; }
:where([data-auth-kit] [data-auth-kit-slot="button"]) { width: 100%; font-weight: 600; color: var(--ak-button-text, #fff); background: var(--ak-button-bg, var(--ak-button, #1e79c8)); box-shadow: var(--ak-button-shadow, none); border: 0; }
:where([data-auth-kit] [data-auth-kit-slot="button"][data-danger]) { background: var(--ak-error, #b42318); }
:where([data-auth-kit] [data-auth-kit-slot="secondaryButton"]) { color: var(--ak-ink, #092940); background: #fff; border: 1px solid var(--ak-field-border, #6b7480); }
:where([data-auth-kit] [data-auth-kit-slot="linkButton"], [data-auth-kit] [data-auth-kit-slot="link"], [data-auth-kit] [data-auth-kit-slot="showButton"]) { font: inherit; background: none; border: 0; padding: 0; color: var(--ak-link, #1668b0); text-decoration: underline; cursor: pointer; display: inline-flex; gap: 0.375rem; align-items: center; }
:where([data-auth-kit] [data-auth-kit-slot="field"]:has([data-auth-kit-slot="showButton"])) { position: relative; }
:where([data-auth-kit] [data-auth-kit-slot="showButton"]) { justify-self: end; font-size: 0.875rem; }
:where([data-auth-kit] [data-auth-kit-slot="alts"], [data-auth-kit] [data-auth-kit-slot="list"]) { margin: 0; padding: 0; list-style: none; display: grid; gap: 0.25rem; }
:where([data-auth-kit] [data-auth-kit-slot="alts"] [data-auth-kit-slot="linkButton"]) { width: 100%; min-height: 44px; text-decoration: none; }
:where([data-auth-kit] [data-auth-kit-slot="alts"] [data-auth-kit-slot="linkButton"] span) { flex: 1; text-align: start; text-decoration: underline; }
:where([data-auth-kit] [data-auth-kit-slot="list"] [data-auth-kit-slot="secondaryButton"]) { width: 100%; justify-content: space-between; }
:where([data-auth-kit] [data-auth-kit-slot="ways"]) { margin: 0.5rem 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 10px; }
:where([data-auth-kit] [data-auth-kit-slot="way"]) { font: inherit; font-weight: 600; font-size: 17px; line-height: 22px; box-sizing: border-box; display: flex; align-items: center; gap: 14px; width: 100%; min-height: 60px; margin: 0; padding: 12px 14px 12px 16px; text-align: start; color: var(--ak-ink, #092940); background: transparent; border: 1px solid var(--ak-option-border, #d8dde0); border-radius: max(10px, calc(var(--ak-card-radius, 12px) - 2px)); cursor: pointer; }
:where([data-auth-kit] [data-auth-kit-slot="way"][data-auth-kit-recommended]) { background: var(--ak-status, rgba(9, 41, 64, 0.045)); border-color: transparent; }
:where([data-auth-kit] [data-auth-kit-slot="way"]:hover:not(:disabled)) { border-color: var(--ak-field-border, #6b7480); }
:where([data-auth-kit] [data-auth-kit-slot="way"]:hover:not(:disabled) [data-auth-kit-slot="wayLabel"]) { text-decoration: underline; text-underline-offset: 3px; }
:where([data-auth-kit] [data-auth-kit-slot="way"] > svg) { flex: none; width: 22px; height: 22px; color: var(--ak-link, #1668b0); }
:where([data-auth-kit] [data-auth-kit-slot="way"] > [data-auth-kit-icon="chevron"]) { margin-left: auto; width: 18px; height: 18px; color: var(--ak-muted, #56606b); }
:where([data-auth-kit] [data-auth-kit-slot="wayText"]) { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
:where([data-auth-kit] [data-auth-kit-slot="wayLabel"] [data-auth-kit-recommended-label]) { font-weight: 400; color: var(--ak-text, #3c434b); }
:where([data-auth-kit] [data-auth-kit-slot="wayDescription"]) { display: block; font-weight: 400; font-size: 16px; line-height: 22px; color: var(--ak-text, #3c434b); }
:where([data-auth-kit] [data-auth-kit-slot="steps"]) { margin: 0; padding-inline-start: 1.25rem; display: grid; gap: 0.5rem; }
:where([data-auth-kit] [data-auth-kit-slot="choice"]) { display: grid; gap: 0.5rem; padding: 1rem; border: 1px solid var(--ak-field-border, #6b7480); border-radius: 10px; }
:where([data-auth-kit] [data-auth-kit-slot="choice"] h2) { margin: 0; font-size: 1.0625rem; color: var(--ak-ink, #092940); display: flex; gap: 0.5rem; align-items: center; }
:where([data-auth-kit] [data-auth-kit-slot="choice"] p) { margin: 0; }
:where([data-auth-kit] [data-auth-kit-slot="bottom"]) { display: grid; gap: 0.5rem; justify-items: start; padding-top: 1rem; border-top: 1px solid var(--ak-hair, rgba(9, 41, 64, 0.1)); }
:where([data-auth-kit] [data-auth-kit-slot="access"]) { margin: 0; }
:where([data-auth-kit] [data-auth-kit-slot="below"]) { margin: 0.75rem 0 0; text-align: center; }
:where([data-auth-kit] [data-auth-kit-slot="glyph"]) { color: var(--ak-accent, #1e79c8); }
:where([data-auth-kit] [data-auth-kit-slot="glyph"] svg) { width: 40px; height: 40px; }
:where([data-auth-kit] [data-auth-kit-icon="fingerprint"], [data-auth-kit] [data-auth-kit-icon="password"]) { color: var(--ak-accent, #1e79c8); flex: none; }
:where([data-auth-kit] [data-auth-kit-slot="code"]) { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.05em; overflow-wrap: anywhere; }
:where([data-auth-kit] button:disabled) { cursor: not-allowed; opacity: 0.6; }
:where([data-auth-kit] [data-auth-kit-slot="error"]:empty, [data-auth-kit] [data-auth-kit-slot="status"]:empty) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
:where([data-auth-kit] [data-auth-kit-slot="error"]) { color: var(--ak-error, #b42318); font-weight: 600; }
:where([data-auth-kit] [data-auth-kit-sr]) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (prefers-reduced-motion: no-preference) { :where([data-auth-kit] [data-auth-kit-slot="wait"] svg) { animation: ak-pulse 1.6s ease-in-out infinite; } }
@keyframes ak-pulse { 50% { opacity: 0.45; } }
`.trim();
