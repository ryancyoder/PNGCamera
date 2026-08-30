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
  'src/core/SiteSurvey.js',
  'src/ui/PhotoView.js',
  'src/ui/OverlayRenderer.js',
  'src/ui/SitePlanView.js',
  'src/ui/TiltSensor.js',
  'src/ui/SightView.js',
  'src/ui/ExportManager.js',
  'src/ui/App.js',
  'src/main.js',
];

/**
 * Check the list against what the modules actually import.
 *
 * Concatenation strips the imports, so a module left off the list does not fail
 * the build — it produces a bundle whose references are quietly undefined, and
 * only the browser finds out. The list has to be checked against reality, not
 * merely written down carefully.
 */
function checkGraph(root, modules) {
  const listed = new Set(modules);
  const position = new Map(modules.map((m, i) => [m, i]));
  const problems = [];

  modules.forEach((path, index) => {
    const source = readFileSync(join(root, path), 'utf8');
    const dir = dirname(path);
    for (const m of source.matchAll(/^import\s+[^;]*?from\s+['"](\.[^'"]+)['"];/gm)) {
      // Resolve the relative specifier against this module's own directory.
      const resolved = join(dir, m[1]).split('\\').join('/');
      if (!listed.has(resolved)) {
        problems.push(`${path} imports ${resolved}, which is not in MODULES`);
      } else if (position.get(resolved) > index) {
        problems.push(`${path} imports ${resolved}, which is listed after it`);
      }
    }
  });

  if (problems.length) {
    throw new Error(`Bundle graph is wrong:\n  - ${problems.join('\n  - ')}`);
  }
}

/**
 * Check that no two modules declare the same top-level name.
 *
 * Concatenation puts every module in one scope, so two files that each define a
 * `DEG` are a SyntaxError in the bundle and perfectly fine as modules. The
 * source passes its tests, the bundle is dead on arrival, and nothing in
 * between says so.
 */
function checkCollisions(root, modules) {
  const seen = new Map();
  const clashes = [];
  const declaration = /^(?:export\s+)?(?:const|let|var|function|class|async function)\s+([A-Za-z_$][\w$]*)/;

  for (const path of modules) {
    for (const line of readFileSync(join(root, path), 'utf8').split('\n')) {
      // Top level only: anything indented belongs to a function or a class.
      if (/^\s/.test(line)) continue;
      const name = line.match(declaration)?.[1];
      if (!name) continue;
      if (seen.has(name) && seen.get(name) !== path) {
        clashes.push(`${name} is declared in both ${seen.get(name)} and ${path}`);
      } else {
        seen.set(name, path);
      }
    }
  }

  if (clashes.length) {
    throw new Error(`Bundle name collisions:\n  - ${clashes.join('\n  - ')}`);
  }
}

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

checkGraph(root, MODULES);
checkCollisions(root, MODULES);

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
