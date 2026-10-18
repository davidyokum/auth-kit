/**
 * Optional styles for `<Backdrop>`'s markup: a fade-in once the first frame is drawn (none under
 * reduced motion). Zero specificity (`:where()`), so any site style wins. The positioning that keeps
 * the canvas behind the content and out of the pointer's way is on the elements themselves, so the
 * component works without this. Add it to a global stylesheet (a strict CSP needs no exception).
 */
export const backdropStyles = `
:where([data-auth-kit-backdrop-canvas]) { opacity: 0; transition: opacity 700ms ease-out; }
:where([data-auth-kit-backdrop-canvas][data-ready]) { opacity: 1; }
@media (prefers-reduced-motion: reduce) { :where([data-auth-kit-backdrop-canvas]) { transition: none; } }
`.trim();
