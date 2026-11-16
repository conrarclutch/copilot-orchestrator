import { build } from 'esbuild';
import { copyFile, mkdir, readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./', import.meta.url));
await mkdir(new URL('./dist/', import.meta.url), { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: { index: 'src/index.ts', browser: 'src/browser/index.ts' },
  outdir: 'dist', bundle: true, splitting: true, format: 'esm', platform: 'browser',
  target: 'es2022', sourcemap: true, metafile: true, minify: true,
});
// Remove only obsolete generated JS outputs, so copying dist never carries old chunks.
const generated = new Set(Object.keys(result.metafile.outputs).map(file => path.resolve(root, file)));
for (const entry of await readdir(path.join(root, 'dist'), {withFileTypes:true})) {
  const file = path.join(root, 'dist', entry.name);
  if (entry.isFile() && /\.js(?:\.map)?$/.test(entry.name) && !generated.has(file)) await unlink(file);
}
execFileSync(process.execPath, [fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url)), '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit', windowsHide: true });
await copyFile(new URL('./src/styles.css', import.meta.url), new URL('./dist/styles.css', import.meta.url));
await copyFile(new URL('./LICENSE', import.meta.url), new URL('./dist/LICENSE', import.meta.url));
await copyFile(new URL('./README.md', import.meta.url), new URL('./dist/README.md', import.meta.url));
const notices = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.includes('node_modules')) continue;
  let dir = path.dirname(path.resolve(root, input));
  while (dir !== path.dirname(dir)) {
    let manifest;
    try { manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')); } catch { dir = path.dirname(dir); continue; }
    if (!manifest.name) { dir = path.dirname(dir); continue; }
    if (!notices.has(manifest.name)) {
      const files = (await readdir(dir)).filter(name => /^(license|copying|notice)(\.|$)/i.test(name));
      const texts = await Promise.all(files.map(name => readFile(path.join(dir, name), 'utf8')));
      if (texts.length === 0) throw new Error(`Missing bundled dependency license: ${manifest.name}`);
      notices.set(manifest.name, `${manifest.name} ${manifest.version} (${manifest.license ?? 'see license'})\n${texts.join('\n')}`);
    }
    break;
  }
}
await writeFile(new URL('./dist/THIRD_PARTY_LICENSES.txt', import.meta.url), [...notices.values()].join('\n\n----------------------------------------\n\n'));
console.log('Built embeddable chat-renderer package');
