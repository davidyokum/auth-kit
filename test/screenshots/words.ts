/**
 * The primary button's words follow register A6: **Continue** on every step another step follows; **Sign in**
 * only on the step that finishes. So a step that leads to another screen of the card never says "Create
 * account", "Finish", or "Sign in" (the v0.1.10-alpha sign-up name step said "Create account", and could say
 * "Finish").
 *
 * Which steps finish comes from preview mode's own map of where each action leads (`actions()`'s `next`, which
 * a test checks against the live card): a step finishes when its button leads into the site (`@signed-in`).
 *
 * `installWordsProbe` runs in the page (it's serialized, so it's self-contained) and leaves
 * `window.__akWords.check(stage, actions)` behind.
 */

/** Words a primary button may say only where no step follows. */
export const FINAL_WORDS: readonly string[] = ['Create account', 'Finish', 'Sign in'];

interface Action {
  name: string;
  label: string;
  next: { screen: string; state?: string } | null;
}

declare global {
  interface Window {
    __akWords: { check(stage: HTMLElement, actions: Action[], finalWords: readonly string[]): string[] };
  }
}

export function installWordsProbe(): void {
  function check(stage: HTMLElement, actions: Action[], finalWords: readonly string[]): string[] {
    const problems: string[] = [];
    // actions() lists the controls in document order; pair each with its element.
    const tagged = [...stage.querySelectorAll('[data-auth-kit-action]')];
    if (tagged.length !== actions.length) return [`actions() lists ${actions.length} controls, the card tags ${tagged.length}`];
    const actionOf = new Map(tagged.map((el, i) => [el, actions[i]!] as const));
    const banned = new Set(finalWords.map((w) => w.toLowerCase()));
    for (const button of stage.querySelectorAll<HTMLElement>('[data-auth-kit-slot="button"]')) {
      if (button.closest('[hidden]') || button.getClientRects().length === 0) continue;
      const owner = button.hasAttribute('data-auth-kit-action') ? button : button.getAttribute('type') === 'submit' ? button.closest('form[data-auth-kit-action]') : null;
      const action = owner ? actionOf.get(owner) : undefined;
      if (!action) {
        problems.push(`the primary button "${button.textContent?.trim()}" reports no action`);
        continue;
      }
      const words = (button.textContent ?? '').replace(/\s+/g, ' ').trim();
      const leadsOn = action.next !== null && !action.next.screen.startsWith('@');
      if (leadsOn && banned.has(words.toLowerCase())) {
        problems.push(`the primary button says "${words}", but another step follows (${action.name} → ${action.next!.screen}${action.next!.state ? `/${action.next!.state}` : ''}); register A6: Continue`);
      }
    }
    return problems;
  }
  window.__akWords = { check };
}
