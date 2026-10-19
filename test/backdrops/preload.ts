/**
 * Each style's drawing code loads on first use (`lazyVersion`). Tests that create a style directly
 * (scenes, the renderer with a fake host) load every registered version first. The lazy path itself
 * is tested in lazy.test.ts.
 */
import { STYLE_MODULES } from '../../src/backdrops/styles/registry.js';

await Promise.all(STYLE_MODULES.flatMap((m) => m.versions.map((v) => v.load())));
