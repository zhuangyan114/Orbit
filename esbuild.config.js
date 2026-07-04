const esbuild = require('esbuild');
const path = require('path');

const isWatch = process.argv.includes('--watch');

/** @type {esbuild.BuildOptions} */
const extConfig = {
  entryPoints: [path.resolve('src/extension.ts')],
  bundle: true,
  outfile: path.resolve('dist/extension.js'),
  external: ['vscode', 'koffi'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  minify: false,
};

/** @type {esbuild.BuildOptions} */
const webviewConfig = {
  entryPoints: [path.resolve('src/webview/main.tsx')],
  bundle: true,
  outfile: path.resolve('dist/webview.js'),
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: false,
  minify: false,
  loader: { '.svg': 'text' },
};

/** @type {esbuild.BuildOptions} */
const timelineConfig = {
  entryPoints: [path.resolve('src/webview/timeline/main.tsx')],
  bundle: true,
  outfile: path.resolve('dist/timeline.js'),
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: false,
  minify: false,
};

/** @type {esbuild.BuildOptions} */
const watchConfig = {
  entryPoints: [path.resolve('src/webview/watch/main.tsx')],
  bundle: true,
  outfile: path.resolve('dist/watch.js'),
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: false,
  minify: false,
};

/** @type {esbuild.BuildOptions} */
const debugAdapterConfig = {
  entryPoints: [path.resolve('src/debugadapter.ts')],
  bundle: true,
  outfile: path.resolve('dist/debugadapter.js'),
  external: ['vscode', 'koffi'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: false,
  minify: false,
};

async function build() {
  try {
    if (isWatch) {
      const extCtx = await esbuild.context(extConfig);
      const webviewCtx = await esbuild.context(webviewConfig);
      const daCtx = await esbuild.context(debugAdapterConfig);
      const tlCtx = await esbuild.context(timelineConfig);
      const wCtx = await esbuild.context(watchConfig);
      await Promise.all([extCtx.watch(), webviewCtx.watch(), daCtx.watch(), tlCtx.watch(), wCtx.watch()]);
      console.log('[watch] extension + webview + debugadapter + timeline + watch — waiting for changes...');
    } else {
      await Promise.all([esbuild.build(extConfig), esbuild.build(webviewConfig), esbuild.build(debugAdapterConfig), esbuild.build(timelineConfig), esbuild.build(watchConfig)]);
      console.log('[build] extension + webview + debugadapter + timeline + watch — done');
    }
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

build();