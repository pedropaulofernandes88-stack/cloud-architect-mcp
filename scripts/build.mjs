import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

for (const name of ['lambda', 'dispatcher', 'worker', 'reconciler']) {
  await mkdir(`dist/${name}`, { recursive: true });
  await build({
    entryPoints: [`src/${name}.ts`],
    outfile: `dist/${name}/index.mjs`,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    sourcemap: true,
    sourcesContent: false,
    legalComments: 'none',
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });
}
console.log('Bundles Lambda, dispatcher, worker e reconciler gerados em dist/.');
