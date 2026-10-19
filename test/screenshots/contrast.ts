/**
 * Computed contrast for preview mode's matrix (register E5; WCAG 2.2 AA 1.4.3, 1.4.11): measured in the browser
 * from the rendered card's computed colours, composited over what is really behind each piece (the page the
 * stage paints, the card's fill, a tint or well, the Plain style's column, a see-through card and what its
 * backdrop filter does to the page under it), never from the theme's tokens.
 *
 * - **Text, 4.5:1**: body text, headings, links, muted text, errors, the words on controls, typed field text,
 *   and the examples in empty fields. Large text gets no 3:1 allowance.
 * - **The focus ring, 3:1** against what it's drawn on. Every control shows one when focused from the keyboard.
 * - **Boundaries, 3:1**: text fields, outline buttons, and the card (its defined edge, or its fill where that
 *   stands out more, as `checkCardEdge` counts it; Plain has no card, register E4). The border or the fill
 *   must reach 3:1 against what's outside.
 *
 * Not measured: disabled controls (WCAG exempts inactive ones), text kept for screen readers only, icons beside
 * words, and hairlines that only decorate (dividers, and the choice rows' light border: each row is a button
 * named by its words).
 *
 * `installContrastProbe` runs in the page (it's serialized, so it's self-contained) and leaves
 * `window.__akContrast.measure(stage)` behind for the matrix to call on every card.
 */

/** What a finding measured. */
export type ContrastKind =
  | 'text'
  | 'heading'
  | 'muted'
  | 'link'
  | 'error'
  | 'label'
  | 'field'
  | 'example'
  | 'focus'
  | 'field-boundary'
  | 'button-boundary'
  | 'card-boundary'
  | 'edge-line';

export interface ContrastFinding {
  kind: ContrastKind;
  /** The lowest ratio over every colour that can be behind it (one per gradient stop). Never rounded. */
  ratio: number;
  minimum: number;
  /** For information only (the edge line by itself on a dark page); never a failure. */
  info?: true;
  fg: string;
  bg: string;
  what: string;
}

declare global {
  interface Window {
    __akContrast: { measure(stage: HTMLElement): ContrastFinding[] };
  }
}

/** Text kinds, all 4.5:1. */
export const TEXT_KINDS: readonly ContrastKind[] = ['text', 'heading', 'muted', 'link', 'error', 'label', 'field', 'example'];

export function installContrastProbe(): void {
  type Rgba = [number, number, number, number];
  const WHITE: Rgba = [255, 255, 255, 1];

  /** Every colour in a computed value (`rgb()`/`rgba()`, which is how Chromium serializes them). */
  const colours = (css: string): Rgba[] =>
    [...css.matchAll(/rgba?\(([^)]*)\)/g)].map((m) => {
      const p = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
      return [p[0]!, p[1]!, p[2]!, p.length > 3 ? p[3]! : 1];
    });
  const one = (css: string, what: string): Rgba => {
    const c = colours(css);
    if (c.length !== 1 || c[0]!.some((v) => Number.isNaN(v))) throw new Error(`contrast probe: can't read the colour "${css}" (${what})`);
    return c[0]!;
  };
  /** `top` painted over an opaque `under`. */
  const over = (top: Rgba, under: Rgba): Rgba => {
    const a = top[3];
    return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
  };
  /** CSS `saturate(s)` (Filter Effects' matrix), on sRGB values as browsers apply filter functions. */
  const saturate = (c: Rgba, s: number): Rgba => {
    const [r, g, b] = c;
    const clamp = (v: number) => Math.max(0, Math.min(255, v));
    return [
      clamp((0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b),
      clamp((0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b),
      clamp((0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b),
      1,
    ];
  };
  const linear = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const luminance = (c: Rgba) => 0.2126 * linear(c[0]) + 0.7152 * linear(c[1]) + 0.0722 * linear(c[2]);
  const ratio = (a: Rgba, b: Rgba) => {
    const x = luminance(a);
    const y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const hex = (c: Rgba) => `#${c
    .slice(0, 3)
    .map((v) => Math.round(v).toString(16).padStart(2, '0'))
    .join('')}`;
  const unique = (list: Rgba[]) => [...new Map(list.map((c) => [hex(c), c] as const)).values()];

  const describe = (el: Element) => {
    const slot = el.closest('[data-auth-kit-slot]')?.getAttribute('data-auth-kit-slot') ?? el.tagName.toLowerCase();
    const words = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value || el.placeholder || el.name : el.textContent || el.getAttribute('aria-label') || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);
    return `${slot} "${words}"`;
  };

  /** What an element paints over `under`: its backdrop filter's saturation, its fill, and each stop of a gradient. */
  function paint(el: Element, under: Rgba[]): Rgba[] {
    const cs = getComputedStyle(el);
    let layers = under;
    const filter = /saturate\(([\d.]+)\)/.exec(cs.backdropFilter || cs.getPropertyValue('-webkit-backdrop-filter') || '');
    if (filter) layers = layers.map((l) => saturate(l, Number(filter[1])));
    const fill = one(cs.backgroundColor, describe(el));
    if (fill[3] > 0) layers = layers.map((l) => over(fill, l));
    if (cs.backgroundImage !== 'none') {
      const stops = colours(cs.backgroundImage);
      if (stops.length === 0) throw new Error(`contrast probe: ${describe(el)} has a background image the check can't read (${cs.backgroundImage})`);
      layers = layers.flatMap((l) => stops.map((s) => over(s, l)));
    }
    return unique(layers);
  }

  /** The opaque colours that can be behind an element's content, painted from the page down. */
  function behind(el: Element, inclusive: boolean): Rgba[] {
    const path: Element[] = [];
    for (let n: Element | null = inclusive ? el : el.parentElement; n; n = n.parentElement) path.unshift(n);
    let layers: Rgba[] = [WHITE];
    for (const n of path) {
      // The Plain style's column is its root's ::before (a band of the page colour that fades out at its
      // sides, wider than the card by 92px each side, so the card sits on its solid band).
      const before = getComputedStyle(n, '::before');
      if (before.content !== 'none' && before.content !== 'normal' && before.backgroundImage !== 'none') {
        const stops = colours(before.backgroundImage);
        const band = stops.reduce((a, b) => (b[3] > a[3] ? b : a), [0, 0, 0, 0] as Rgba);
        if (band[3] > 0) layers = layers.map((l) => over(band, l));
      }
      layers = paint(n, layers);
    }
    return layers;
  }

  /** Not drawn, or drawn for screen readers only. */
  function unseen(el: Element): boolean {
    if (el.closest('[data-auth-kit-sr], svg, [hidden]')) return true;
    if (el.getClientRects().length === 0) return true;
    const box = el.getBoundingClientRect();
    if (box.width <= 1 && box.height <= 1) return true;
    return getComputedStyle(el).visibility !== 'visible';
  }

  /** Inactive (disabled, so WCAG exempts it), or under opacity the check doesn't model (`null`: measure it). */
  function inactive(el: Element): 'disabled' | 'faded' | null {
    if (el.closest('button:disabled, input:disabled, textarea:disabled, fieldset:disabled')) return 'disabled';
    for (let n: Element | null = el; n; n = n.parentElement) if (Number(getComputedStyle(n).opacity) < 1) return 'faded';
    return null;
  }

  function kindOf(el: Element): ContrastKind {
    // A control's own words first (a link can be drawn as a button), then links, then errors.
    if (el.closest('[data-auth-kit-slot="button"], [data-auth-kit-slot="secondaryButton"], [data-auth-kit-slot="way"]')) return 'label';
    if (el.closest('a, [data-auth-kit-slot="link"], [data-auth-kit-slot="linkButton"], [data-auth-kit-slot="showButton"]')) return 'link';
    if (el.closest('[data-auth-kit-slot="error"], [data-auth-kit-slot="fieldError"], [data-auth-kit-slot="summary"]')) return 'error';
    if (el.closest('[data-auth-kit-slot="heading"]')) return 'heading';
    if (el.closest('[data-auth-kit-slot="hint"], [data-auth-kit-slot="small"], [data-auth-kit-slot="footer"], [data-auth-kit-slot="notice"]')) return 'muted';
    return 'text';
  }

  function measure(stage: HTMLElement): ContrastFinding[] {
    const out: ContrastFinding[] = [];
    const add = (kind: ContrastKind, minimum: number, fg: Rgba, layers: Rgba[], el: Element, info?: true) => {
      let worst = Infinity;
      let at: [Rgba, Rgba] = [fg, WHITE];
      for (const l of layers) {
        const f = over(fg, l);
        const r = ratio(f, l);
        if (r < worst) {
          worst = r;
          at = [f, l];
        }
      }
      out.push({ kind, ratio: worst, minimum, ...(info && { info }), fg: hex(at[0]), bg: hex(at[1]), what: describe(el) });
    };
    const unmeasured = (kind: ContrastKind, el: Element, why: string) => out.push({ kind, ratio: 0, minimum: 1, fg: '', bg: '', what: `${describe(el)}: ${why}` });

    // Text: every element that holds words of its own.
    const owners = new Set<Element>();
    const walker = document.createTreeWalker(stage, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) if (t.textContent?.trim() && t.parentElement) owners.add(t.parentElement);
    for (const el of owners) {
      if (unseen(el)) continue;
      const state = inactive(el);
      if (state === 'disabled') continue;
      if (state === 'faded') {
        unmeasured(kindOf(el), el, 'text under opacity, which the check does not model');
        continue;
      }
      add(kindOf(el), 4.5, one(getComputedStyle(el).color, describe(el)), behind(el, true), el);
    }

    // Fields: what's typed, or the example while empty; and the field's boundary.
    for (const field of stage.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')) {
      if ((field instanceof HTMLInputElement && field.type === 'hidden') || field.disabled || unseen(field)) continue;
      const cs = getComputedStyle(field);
      const inside = behind(field, true);
      if (field.value) add('field', 4.5, one(cs.color, describe(field)), inside, field);
      else if (field.placeholder) add('example', 4.5, one(getComputedStyle(field, '::placeholder').color, describe(field)), inside, field);
    }

    // Boundaries: the border or the fill against what's outside, whichever stands out more.
    const boundary = (kind: ContrastKind, el: Element) => {
      const cs = getComputedStyle(el);
      const border = one(cs.borderTopColor, describe(el));
      let worst = Infinity;
      let at: [Rgba, Rgba] = [border, WHITE];
      for (const outside of behind(el, false)) {
        for (const fill of paint(el, [outside])) {
          const line = over(border, fill);
          const [r, shown] = ratio(line, outside) >= ratio(fill, outside) ? [ratio(line, outside), line] : [ratio(fill, outside), fill];
          if (r < worst) {
            worst = r;
            at = [shown, outside];
          }
        }
      }
      out.push({ kind, ratio: worst, minimum: 3, fg: hex(at[0]), bg: hex(at[1]), what: describe(el) });
    };
    for (const el of stage.querySelectorAll('[data-auth-kit-slot="input"]')) if (!unseen(el) && !(el as HTMLInputElement).disabled) boundary('field-boundary', el);
    for (const el of stage.querySelectorAll('[data-auth-kit-slot="secondaryButton"]')) if (!unseen(el) && !(el as HTMLButtonElement).disabled) boundary('button-boundary', el);
    const card = stage.querySelector('[data-backdrop-card]');
    if (card && getComputedStyle(card).borderTopColor !== 'rgba(0, 0, 0, 0)') {
      boundary('card-boundary', card);
      // The edge line by itself, for information (on a dark page the card's fill carries the boundary).
      const page = behind(card, false);
      add('edge-line', 0, one(getComputedStyle(card).borderTopColor, 'card edge'), page, card, true);
    }

    // The focus ring: focus each control as the keyboard would, and measure the ring against what it's drawn on.
    const previous = document.activeElement;
    for (const el of stage.querySelectorAll<HTMLElement>('a[href], button, input, textarea, select, [tabindex]')) {
      if (el.getAttribute('tabindex') === '-1' || (el as HTMLButtonElement).disabled || (el instanceof HTMLInputElement && el.type === 'hidden') || unseen(el) || el.closest('[inert]')) continue;
      el.focus({ preventScroll: true });
      if (document.activeElement !== el) {
        unmeasured('focus', el, "can't be focused");
        continue;
      }
      if (!el.matches(':focus-visible')) {
        unmeasured('focus', el, 'focused, but not as the keyboard focuses it (:focus-visible), so the ring is not drawn');
        continue;
      }
      const cs = getComputedStyle(el);
      if (cs.outlineStyle === 'none' || parseFloat(cs.outlineWidth) < 2) {
        unmeasured('focus', el, `no focus ring (outline ${cs.outlineStyle} ${cs.outlineWidth})`);
        continue;
      }
      add('focus', 3, one(cs.outlineColor, describe(el)), behind(el, false), el);
      el.blur();
    }
    if (previous instanceof HTMLElement) previous.focus({ preventScroll: true });
    return out;
  }

  window.__akContrast = { measure };
}
