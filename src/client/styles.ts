/**
 * Optional tidy defaults. Every selector is wrapped in `:where()`, so it has zero specificity and any
 * site style wins. Add it to a global stylesheet, or render it with your CSP nonce:
 * `<style nonce={nonce}>{authKitStyles}</style>`.
 */
export const authKitStyles = `
:where([data-auth-kit]) { display: grid; gap: 1rem; max-width: 30rem; }
:where([data-auth-kit] [data-auth-kit-slot="form"], [data-auth-kit] [data-auth-kit-slot="section"]) { display: grid; gap: 1rem; }
:where([data-auth-kit] [data-auth-kit-slot="heading"]) { margin: 0; }
:where([data-auth-kit] [data-auth-kit-slot="heading"]:focus) { outline: none; }
:where([data-auth-kit] [data-auth-kit-slot="text"], [data-auth-kit] [data-auth-kit-slot="hint"]) { margin: 0; }
:where([data-auth-kit] [data-auth-kit-slot="hint"]) { font-size: 0.875em; opacity: 0.8; }
:where([data-auth-kit] [data-auth-kit-slot="field"]) { display: grid; gap: 0.25rem; }
:where([data-auth-kit] [data-auth-kit-slot="label"]) { font-weight: 600; }
:where([data-auth-kit] [data-auth-kit-slot="input"]) { font: inherit; padding: 0.5rem 0.625rem; }
:where([data-auth-kit] [data-auth-kit-slot="input"][aria-invalid="true"]) { outline: 2px solid #c5221f; outline-offset: 1px; }
:where([data-auth-kit] [data-auth-kit-slot="actions"]) { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; }
:where([data-auth-kit] [data-auth-kit-slot="button"], [data-auth-kit] [data-auth-kit-slot="secondaryButton"]) { font: inherit; padding: 0.5rem 1rem; cursor: pointer; }
:where([data-auth-kit] [data-auth-kit-slot="button"]) { font-weight: 600; }
:where([data-auth-kit] [data-auth-kit-slot="linkButton"]) { font: inherit; background: none; border: 0; padding: 0; color: LinkText; text-decoration: underline; cursor: pointer; }
:where([data-auth-kit] button:disabled) { cursor: not-allowed; opacity: 0.6; }
:where([data-auth-kit] [data-auth-kit-slot="error"]:empty, [data-auth-kit] [data-auth-kit-slot="status"]:empty) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
:where([data-auth-kit] [data-auth-kit-slot="error"]) { color: #c5221f; font-weight: 600; }
:where([data-auth-kit] [data-auth-kit-slot="code"]) { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.05em; overflow-wrap: anywhere; }
:where([data-auth-kit] [data-auth-kit-slot="list"]) { margin: 0; padding-left: 1.25rem; display: grid; gap: 0.5rem; }
`.trim();
