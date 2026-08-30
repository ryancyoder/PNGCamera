// Bundles the app into a single self-contained HTML file.
//
//   node tools/build.mjs
//
// There is no dependency, no transpiler and no minifier: the modules are
// concatenated in dependency order and their import/export keywords stripped.
// The point is portability — an iPad has no web server, so `dist/` gives you
// one file you can AirDrop, e-mail, or drop in Files and open straight from
// Safari. The modular sources under src/ remain the thing you edit.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Dependency order. Kept explicit rather than parsed out of the imports: the
// graph is small, and an explicit list fails loudly if a module is forgotten.
const MODULES = [
  'src/core/Geometry.js',
  'src/core/PerspectiveProjection.js',
  'src/core/PerspectiveCalibration.js',
  'src/core/ElevationModel.js',
  'src/core/ElevationRuler.js',
  'src/core/MeasurementAnnotation.js',
  'src/core/AnnotationManager.js',
  'src/ui/PhotoView.js',
  'src/ui/OverlayRenderer.js',
  'src/ui/ExportManager.js',
  'src/ui/App.js',
  'src/main.js',
];

/** Strip module syntax so the files can share one scope. */
function flatten(source, path) {
  const out = source
    // `import ... from '...';` — single line, which is all this codebase uses.
    .replace(/^import\s+[^;]*?from\s+['"][^'"]+['"];\s*$/gm, '')
    // `export { A, B };` re-exports of already-declared bindings.
    .replace(/^export\s*\{[^}]*\}\s*;\s*$/gm, '')
    // `export class|const|function|let` -> plain declaration.
    .replace(/^export\s+(?=(class|const|function|let|async)\b)/gm, '');

  const leftover = out.match(/^\s*(import|export)\b.*$/m);
  if (leftover) {
    throw new Error(`${path}: unhandled module syntax -> ${leftover[0].trim()}`);
  }
  return out;
}

const bundle = MODULES.map((path) => {
  const source = readFileSync(join(root, path), 'utf8');
  return `\n// ${'='.repeat(70)}\n// ${path}\n// ${'='.repeat(70)}\n${flatten(source, path)}`;
}).join('\n');

const css = readFileSync(join(root, 'styles.css'), 'utf8');
let html = readFileSync(join(root, 'index.html'), 'utf8');

const before = html;
html = html
  .replace('<link rel="stylesheet" href="styles.css">', `<style>\n${css}\n</style>`)
  .replace(
    '<script type="module" src="src/main.js"></script>',
    `<script type="module">\n${bundle}\n</script>`,
  );

if (html === before) throw new Error('index.html did not contain the expected style/script tags.');

mkdirSync(join(root, 'dist'), { recursive: true });
const out = join(root, 'dist', 'perspective-elevation-ruler.html');
writeFileSync(out, html);

const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
console.log(`Wrote dist/perspective-elevation-ruler.html (${kb} KB, ${MODULES.length} modules)`);
