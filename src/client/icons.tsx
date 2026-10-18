/*!
 * Icons for the sign-in screens, from Lucide (https://lucide.dev) as published in lucide-react 0.475.0:
 * `fingerprint`, `mail`, `chevron` (chevron-right), `back` (arrow-left), `info`, and `check` as drawn
 * there; `alert` (circle-alert), `help` (circle-help), `copy`, and `refresh` (refresh-cw) adapted
 * (simplified paths). Under the ISC License:
 *
 * ISC License
 * Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All
 * other copyright (c) for Lucide are held by Lucide Contributors 2022.
 *
 * Permission to use, copy, modify, and/or distribute this software for any purpose with or without
 * fee is hereby granted, provided that the above copyright notice and this permission notice appear
 * in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
 * SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
 * AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
 * NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
 * THIS SOFTWARE.
 *
 * `password` (a password field with three dots) is auth-kit's own drawing, from the sign-in design
 * studio, so a card never shows two keys (register E4d).
 */
import type { ReactNode } from 'react';

const PATHS = {
  // The one passkey icon (register E4d), drawn in the family accent.
  fingerprint: (
    <>
      <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4" />
      <path d="M14 13.12c0 2.38 0 6.38-1 8.88" />
      <path d="M17.29 21.02c.12-.6.43-2.3.5-3.02" />
      <path d="M2 12a10 10 0 0 1 18-6" />
      <path d="M2 16h.01" />
      <path d="M21.8 16c.2-2 .131-5.354 0-6" />
      <path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2" />
      <path d="M8.65 22c.21-.66.45-1.32.57-2" />
      <path d="M9 6.8a6 6 0 0 1 9 5.2v2" />
    </>
  ),
  password: (
    <>
      <rect width="20" height="12" x="2" y="6" rx="3" />
      <circle cx="7.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="16.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  mail: (
    <>
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </>
  ),
  chevron: <path d="m9 18 6-6-6-6" />,
  back: (
    <>
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4.5" />
      <path d="M12 16h.01" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  copy: (
    <>
      <rect width="13" height="13" x="9" y="9" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </>
  ),
  refresh: (
    <>
      <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" />
      <path d="M8 16H3v5" />
    </>
  ),
} as const;

export type IconName = keyof typeof PATHS;
export const ICON_NAMES = Object.freeze(Object.keys(PATHS) as IconName[]);

/**
 * A decorative icon: hidden from assistive technology (the words beside it say what it is), drawn in
 * `currentColor`. The passkey fingerprint and the password glyph carry `data-auth-kit-icon` so styles
 * can give them the family accent (`--ak-accent`).
 */
export function Icon(props: { name: IconName; className?: string }): ReactNode {
  return (
    <svg
      data-auth-kit-icon={props.name}
      className={props.className}
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[props.name]}
    </svg>
  );
}
