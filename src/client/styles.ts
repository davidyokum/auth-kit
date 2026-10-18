/**
 * Optional default styles: the card and its controls as the sign-in design studio draws them
 * (REPORT §7.1: one white card, a thin dark edge, 48px fields and buttons, 16px text, a 3px focus
 * ring; Card Studio v4). Every selector is wrapped in `:where()`, so it has zero specificity and any
 * site style wins. Colors come from the theme's CSS custom properties (`--ak-*`, set on the card by
 * `SignIn`, `SignUp`, `RequestAccess`; `themeCssVariables`), with the OSBM core as the fallback.
 * Add it to a global stylesheet, or render it with your CSP nonce: `<style nonce={nonce}>{authKitStyles}</style>`.
 */
export const authKitStyles = `
:where([data-auth-kit]) { display: grid; gap: 1rem; max-width: 30rem; }
:where([data-auth-kit="sign-in"], [data-auth-kit="sign-up"], [data-auth-kit="request-access"], [data-auth-kit="signed-out"]) { display: block; width: 100%; max-width: var(--ak-card-width, 380px); margin-inline: auto; }
:where([data-auth-kit] [data-auth-kit-slot="card"]) { display: grid; gap: 1rem; box-sizing: border-box; padding: 36px 32px 24px; background: var(--ak-surface, #fff); color: var(--ak-text, #3c434b); border: 1px solid var(--ak-edge, #4a5f73); border-radius: 12px; box-shadow: 0 1px 2px rgba(9, 41, 64, 0.05), 0 16px 36px -16px rgba(9, 41, 64, 0.22); font-size: 1rem; line-height: 1.5; }
@media (max-width: 480px) { :where([data-auth-kit] [data-auth-kit-slot="card"]) { padding: 28px 22px 20px; } }
:where([data-auth-kit="totp-gate"]) { display: block; max-width: none; }
:where([data-auth-kit="totp-gate"] > [data-auth-kit-slot="content"][hidden]) { display: none !important; }
:where([data-auth-kit] [data-auth-kit-slot="form"], [data-auth-kit] [data-auth-kit-slot="section"], [data-auth-kit] [data-auth-kit-slot="content"]) { display: grid; gap: 1rem; }
:where([data-auth-kit] [data-auth-kit-slot="heading"]) { margin: 0; color: var(--ak-ink, #092940); font-size: 1.5rem; line-height: 1.25; display: flex; gap: 0.5rem; align-items: center; }
:where([data-auth-kit] [data-auth-kit-slot="heading"]:focus) { outline: none; }
:where([data-auth-kit] [data-auth-kit-slot="text"], [data-auth-kit] [data-auth-kit-slot="hint"], [data-auth-kit] [data-auth-kit-slot="small"], [data-auth-kit] [data-auth-kit-slot="who"]) { margin: 0; }
:where([data-auth-kit] [data-auth-kit-slot="hint"], [data-auth-kit] [data-auth-kit-slot="small"], [data-auth-kit] [data-auth-kit-slot="footer"], [data-auth-kit] [data-auth-kit-slot="notice"]) { font-size: 0.875rem; color: var(--ak-muted, #56606b); margin: 0; }
:where([data-auth-kit] [data-auth-kit-slot="field"]) { display: grid; gap: 0.375rem; }
:where([data-auth-kit] [data-auth-kit-slot="label"]) { font-weight: 600; color: var(--ak-ink, #092940); }
:where([data-auth-kit] [data-auth-kit-slot="input"]) { font: inherit; font-size: max(1rem, 16px); min-height: 48px; box-sizing: border-box; padding: 0.625rem 0.75rem; color: var(--ak-ink, #092940); background: #fff; border: 1px solid var(--ak-field-border, #6b7480); border-radius: 8px; }
:where([data-auth-kit] textarea[data-auth-kit-slot="input"]) { min-height: 6rem; resize: vertical; }
:where([data-auth-kit] [data-auth-kit-slot="input"]::placeholder) { color: #646e79; }
:where([data-auth-kit] [data-auth-kit-slot="input"][aria-invalid="true"]) { border-color: var(--ak-error, #b42318); border-width: 2px; }
:where([data-auth-kit] :focus-visible) { outline: 3px solid var(--ak-focus, #3892e1); outline-offset: 2px; }
:where([data-auth-kit] [data-auth-kit-slot="fieldError"]) { margin: 0; color: var(--ak-error, #b42318); font-weight: 600; }
:where([data-auth-kit] [data-auth-kit-slot="summary"]) { display: flex; gap: 0.5rem; align-items: flex-start; padding: 0.75rem 0.875rem; border: 2px solid var(--ak-error, #b42318); border-radius: 8px; color: var(--ak-error, #b42318); font-weight: 600; }
:where([data-auth-kit] [data-auth-kit-slot="summary"][hidden]) { display: none; }
:where([data-auth-kit] [data-auth-kit-slot="summary"] p, [data-auth-kit] [data-auth-kit-slot="summary"] ul) { margin: 0; padding: 0; list-style: none; }
:where([data-auth-kit] [data-auth-kit-slot="summary"] a) { color: inherit; }
:where([data-auth-kit] [data-auth-kit-slot="note"], [data-auth-kit] [data-auth-kit-slot="wait"], [data-auth-kit] [data-auth-kit-slot="contact"]) { display: flex; gap: 0.5rem; align-items: flex-start; padding: 0.75rem 0.875rem; border-radius: 8px; background: rgba(9, 41, 64, 0.045); }
:where([data-auth-kit] [data-auth-kit-slot="note"] p) { margin: 0; }
:where([data-auth-kit] [data-auth-kit-slot="contact"]) { display: grid; gap: 0.25rem; }
:where([data-auth-kit] [data-auth-kit-slot="contact"] p) { margin: 0; }
:where([data-auth-kit] [data-auth-kit-slot="actions"]) { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; }
:where([data-auth-kit] [data-auth-kit-slot="button"], [data-auth-kit] [data-auth-kit-slot="secondaryButton"]) { font: inherit; min-height: 48px; padding: 0.625rem 1rem; border-radius: 8px; cursor: pointer; display: inline-flex; gap: 0.5rem; align-items: center; justify-content: center; text-decoration: none; }
:where([data-auth-kit] [data-auth-kit-slot="button"]) { width: 100%; font-weight: 600; color: var(--ak-button-text, #fff); background: var(--ak-button, #1e79c8); border: 0; }
:where([data-auth-kit] [data-auth-kit-slot="button"][data-danger]) { background: var(--ak-error, #b42318); }
:where([data-auth-kit] [data-auth-kit-slot="secondaryButton"]) { color: var(--ak-ink, #092940); background: #fff; border: 1px solid var(--ak-field-border, #6b7480); }
:where([data-auth-kit] [data-auth-kit-slot="linkButton"], [data-auth-kit] [data-auth-kit-slot="link"], [data-auth-kit] [data-auth-kit-slot="showButton"]) { font: inherit; background: none; border: 0; padding: 0; color: var(--ak-link, #1668b0); text-decoration: underline; cursor: pointer; display: inline-flex; gap: 0.375rem; align-items: center; }
:where([data-auth-kit] [data-auth-kit-slot="field"]:has([data-auth-kit-slot="showButton"])) { position: relative; }
:where([data-auth-kit] [data-auth-kit-slot="showButton"]) { justify-self: end; font-size: 0.875rem; }
:where([data-auth-kit] [data-auth-kit-slot="alts"], [data-auth-kit] [data-auth-kit-slot="list"]) { margin: 0; padding: 0; list-style: none; display: grid; gap: 0.25rem; }
:where([data-auth-kit] [data-auth-kit-slot="alts"] [data-auth-kit-slot="linkButton"]) { width: 100%; min-height: 44px; text-decoration: none; }
:where([data-auth-kit] [data-auth-kit-slot="alts"] [data-auth-kit-slot="linkButton"] span) { flex: 1; text-align: start; text-decoration: underline; }
:where([data-auth-kit] [data-auth-kit-slot="list"] [data-auth-kit-slot="secondaryButton"]) { width: 100%; justify-content: space-between; }
:where([data-auth-kit] [data-auth-kit-slot="steps"]) { margin: 0; padding-inline-start: 1.25rem; display: grid; gap: 0.5rem; }
:where([data-auth-kit] [data-auth-kit-slot="choice"]) { display: grid; gap: 0.5rem; padding: 1rem; border: 1px solid var(--ak-field-border, #6b7480); border-radius: 10px; }
:where([data-auth-kit] [data-auth-kit-slot="choice"] h2) { margin: 0; font-size: 1.0625rem; color: var(--ak-ink, #092940); display: flex; gap: 0.5rem; align-items: center; }
:where([data-auth-kit] [data-auth-kit-slot="choice"] p) { margin: 0; }
:where([data-auth-kit] [data-auth-kit-slot="bottom"]) { display: grid; gap: 0.5rem; justify-items: start; padding-top: 1rem; border-top: 1px solid rgba(9, 41, 64, 0.1); }
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
