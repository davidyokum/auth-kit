/**
 * jsdom has no `matchMedia`, so the live driver's `isTouchDevice` says "a computer" there. Tests that
 * look for the setup link (shown on phones and tablets only; ADR 0027) pretend to be a touch device.
 */
export function pretendTouchDevice(touch = true): () => void {
  const had = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: touch && query === '(pointer: coarse)', media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }),
  });
  return () => {
    if (had) Object.defineProperty(window, 'matchMedia', had);
    else Reflect.deleteProperty(window, 'matchMedia');
  };
}
