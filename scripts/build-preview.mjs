// Builds preview mode's standalone files (ADR 0025) into release/ (never into dist/, so never into the npm
// package): auth-kit-preview.js (the card, React and ReactDOM inside, sets window.AuthKitPreview) and
// auth-kit-preview-backdrops.js (every backdrop style version's drawing code, loaded on first use).
// CI attaches both to each GitHub Release, under the same provenance attestation as the tarball.
// Usage: node scripts/build-preview.mjs
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'release');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const styles = join(root, 'src', 'backdrops', 'styles');
const standalone = join(root, 'src', 'preview', 'standalone');

/** Budgets (bytes, minified): the card's file stays small; the styles file carries the map data. */
const BUDGET = {
  // React DOM alone is about 206 KB of this.
  'auth-kit-preview.js': { min: 420_000, gzip: 140_000 },
  'auth-kit-preview-backdrops.js': { min: 900_000, gzip: 450_000 },
};

const banner = `/*! auth-kit-preview ${version} | MIT, with notices in THIRD_PARTY_NOTICES.md | https://github.com/davidyokum/auth-kit */`;

const common = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  // License comments (/*! … */: Lucide's ISC notice, the OpenStreetMap data's ODbL notice, React's) are kept.
  legalComments: 'eof',
  jsx: 'automatic',
  sourcemap: false,
  logLevel: 'warning',
  define: {
    'process.env.NODE_ENV': '"production"',
    __AUTH_KIT_VERSION__: JSON.stringify(version),
    // The second wall (src/preview/standalone/inert-globals.ts): no network, storage, credentials,
    // clipboard, or navigation, even for a control the driver missed.
    fetch: '__akpFetch',
    'window.localStorage': '__akpStorage',
    'window.sessionStorage': '__akpStorage',
    'navigator.credentials': '__akpCredentials',
    'navigator.clipboard': '__akpClipboard',
    'window.location.assign': '__akpAssign',
  },
  inject: [join(standalone, 'inert-globals.ts')],
  banner: { js: banner },
};

/**
 * Neither Amplify nor the direct Cognito calls enter the bundle: the client's `api.ts` (the only module
 * that reaches them) becomes a stub whose functions refuse, and any import of Amplify gets one too.
 */
const noCognito = {
  name: 'auth-kit-preview-no-cognito',
  setup(b) {
    b.onResolve({ filter: /^\.\/api\.js$/ }, (args) => (/[\\/]src[\\/]client$/.test(args.resolveDir) ? { path: join(standalone, 'api-stub.ts') } : undefined));
    b.onResolve({ filter: /^aws-amplify(\/.*)?$/ }, () => ({ path: join(standalone, 'amplify-stub.ts') }));
  },
};

/** Each style's lazy `import('./vN.js')` loads from the backdrops file instead (style-loader.ts). */
const lazyStyles = {
  name: 'auth-kit-preview-lazy-styles',
  setup(b) {
    b.onLoad({ filter: /[\\/]src[\\/]backdrops[\\/]styles[\\/][^\\/]+[\\/]index\.ts$/ }, (args) => {
      const id = relative(styles, dirname(args.path));
      const source = readFileSync(args.path, 'utf8');
      let count = 0;
      const rewritten = source.replace(/import\('\.\/(v\d+)\.js'\)/g, (_, v) => {
        count++;
        return `__previewStyle(${JSON.stringify(`${id}/${v}`)})`;
      });
      if (count === 0) throw new Error(`${relative(root, args.path)}: no lazy version loader found (expected import('./vN.js')).`);
      const loader = JSON.stringify(join(standalone, 'style-loader.ts'));
      return { contents: `import { loadPreviewStyleModule as __previewStyle } from ${loader};\n${rewritten}`, loader: 'ts', resolveDir: dirname(args.path) };
    });
  },
};

/** The backdrops file: every released style version, registered by `style/vN`. */
function backdropsEntry() {
  const imports = [];
  const entries = [];
  for (const id of readdirSync(styles).sort()) {
    const dir = join(styles, id);
    if (!statSync(dir).isDirectory() || id === 'plotter') continue;
    for (const file of readdirSync(dir).sort()) {
      const m = /^(v\d+)\.ts$/.exec(file);
      if (!m) continue;
      const name = `m${imports.length}`;
      imports.push(`import * as ${name} from ${JSON.stringify(join(dir, file))};`);
      entries.push(`${JSON.stringify(`${id}/${m[1]}`)}: ${name}`);
    }
  }
  if (entries.length < 10) throw new Error(`found only ${entries.length} backdrop style versions under ${relative(root, styles)}`);
  return `${imports.join('\n')}\nglobalThis.__authKitPreviewBackdrops = { version: ${JSON.stringify(version)}, modules: { ${entries.join(', ')} } };\n`;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({ ...common, entryPoints: [join(standalone, 'index.tsx')], outfile: join(out, 'auth-kit-preview.js'), plugins: [noCognito, lazyStyles] });
await build({ ...common, stdin: { contents: backdropsEntry(), resolveDir: root, loader: 'ts', sourcefile: 'auth-kit-preview-backdrops.ts' }, outfile: join(out, 'auth-kit-preview-backdrops.js') });

const problems = [];
const report = [];
for (const [file, budget] of Object.entries(BUDGET)) {
  const bytes = readFileSync(join(out, file));
  const code = bytes.toString('utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const gzip = gzipSync(bytes).length;
  report.push(`${file}: ${bytes.length} bytes (${gzip} gzipped), sha256 ${sha256}`);
  if (bytes.length > budget.min) problems.push(`${file} is ${bytes.length} bytes minified, over its ${budget.min}-byte budget`);
  if (gzip > budget.gzip) problems.push(`${file} is ${gzip} bytes gzipped, over its ${budget.gzip}-byte budget`);
  if (/aws-amplify|cognito-idp|amazonaws\.com/.test(code)) problems.push(`${file} carries Amplify or an AWS endpoint`);
}
const main = readFileSync(join(out, 'auth-kit-preview.js'), 'utf8');
const art = readFileSync(join(out, 'auth-kit-preview-backdrops.js'), 'utf8');
if (!main.includes('auth-kit-preview-9d4a7c13')) problems.push('auth-kit-preview.js lacks the preview marker');
if (!/Lucide/.test(main) || !/ISC License/.test(main)) problems.push("auth-kit-preview.js lacks the icons' ISC notice");
if (/COUNTY_DATA|BASIN_DATA/.test(main)) problems.push('auth-kit-preview.js carries backdrop map data (it belongs in the backdrops file)');
if (!/© OpenStreetMap\s+(?:\*\s+)?contributors/.test(art) || !/Open Database License 1\.0/.test(art)) problems.push("auth-kit-preview-backdrops.js lacks the OpenStreetMap data's ODbL notice");
writeFileSync(join(out, 'SIZES.txt'), `${report.join('\n')}\n`);
console.log(report.join('\n'));
if (problems.length > 0) {
  console.error(`- ${problems.join('\n- ')}`);
  process.exit(1);
}
