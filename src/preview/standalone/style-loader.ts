/**
 * The standalone preview's backdrop styles, loaded on first use (ADR 0025). Each style's drawing code is
 * in a second release file, `auth-kit-preview-backdrops.js`, so the card's file stays small; the build
 * points each style's lazy loader here. The file is fetched from beside `auth-kit-preview.js` (or from
 * `AuthKitPreview.backdropsUrl`), once, and only when a backdrop is drawn. A page that loads it with its
 * own `<script>` tag makes no request at all.
 */

declare const __AUTH_KIT_VERSION__: string;

/** What the styles file sets: its version and each style version's module, by `style/vN`. */
export interface PreviewBackdropRegistry {
  version: string;
  modules: Record<string, Record<string, unknown>>;
}

export const BACKDROPS_FILE = 'auth-kit-preview-backdrops.js';
export const REGISTRY_GLOBAL = '__authKitPreviewBackdrops';

function scriptUrl(): string | null {
  // Only while this file's own <script> runs: that's when this module is first evaluated.
  const script = typeof document === 'undefined' ? null : (document.currentScript as HTMLScriptElement | null);
  return script?.src ? new URL(BACKDROPS_FILE, script.src).href : null;
}

let url: string | null = scriptUrl();
let loading: Promise<PreviewBackdropRegistry> | null = null;

function registry(): PreviewBackdropRegistry | undefined {
  return (globalThis as Record<string, unknown>)[REGISTRY_GLOBAL] as PreviewBackdropRegistry | undefined;
}

/** Where the styles file is fetched from. Default: beside the preview's own script, when it was loaded by URL. */
export function backdropsUrl(): string | null {
  return url;
}

export function setBackdropsUrl(value: string | null): void {
  url = value === null ? null : new URL(value, typeof document === 'undefined' ? undefined : document.baseURI).href;
  loading = null;
}

function load(): Promise<PreviewBackdropRegistry> {
  const ready = registry();
  if (ready) return Promise.resolve(ready);
  if (loading) return loading;
  if (!url) return Promise.reject(new Error(`auth-kit preview: the backdrop styles are in ${BACKDROPS_FILE}. Load it with a <script> tag, or set AuthKitPreview.backdropsUrl.`));
  const from = url;
  loading = new Promise<PreviewBackdropRegistry>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = from;
    script.async = true;
    script.onload = () => {
      const loaded = registry();
      if (loaded) resolve(loaded);
      else reject(new Error(`auth-kit preview: ${from} loaded but registered no backdrop styles.`));
    };
    script.onerror = () => {
      loading = null;
      reject(new Error(`auth-kit preview: couldn't load the backdrop styles from ${from}.`));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/** One style version's module (`contours/v1`), from the styles file. */
export async function loadPreviewStyleModule(key: string): Promise<Record<string, unknown>> {
  const loaded = await load();
  if (loaded.version !== __AUTH_KIT_VERSION__) {
    throw new Error(`auth-kit preview: the backdrop styles file is from auth-kit ${loaded.version}, but the preview is ${__AUTH_KIT_VERSION__}. Use the two files from the same release.`);
  }
  const module = loaded.modules[key];
  if (!module) throw new Error(`auth-kit preview: the backdrop styles file has no ${key}.`);
  return module;
}
