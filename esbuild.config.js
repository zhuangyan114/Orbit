const esbuild = require('esbuild');
const path = require('path');

const isWatch = process.argv.includes('--watch');
// Regular builds ship React's production runtime; --watch keeps development checks.
const browserDefines = { 'process.env.NODE_ENV': JSON.stringify(isWatch ? 'development' : 'production') };

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
  define: browserDefines,
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
  define: browserDefines,
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
  define: browserDefines,
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
const rtosConfig = {
  ...watchConfig,
  entryPoints: [path.resolve('src/webview/rtos/main.tsx')],
  outfile: path.resolve('dist/rtos.js'),
};

/** @type {esbuild.BuildOptions} */
const symbolPickerConfig = {
  ...watchConfig,
  entryPoints: [path.resolve('src/webview/symbol-picker/main.tsx')],
  outfile: path.resolve('dist/symbol-picker.js'),
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

/** @type {esbuild.BuildOptions} */
const traceWorkerConfig = {
  entryPoints: [path.resolve('src/trace/trace-worker.ts')],
  bundle: true,
  outfile: path.resolve('dist/trace-worker.js'),
  external: ['vscode', 'koffi'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  minify: false,
};

async function build() {
  try {
    if (isWatch) {
      const extCtx = await esbuild.context(extConfig);
      const webviewCtx = await esbuild.context(webviewConfig);
      const daCtx = await esbuild.context(debugAdapterConfig);
      const twCtx = await esbuild.context(traceWorkerConfig);
      const tlCtx = await esbuild.context(timelineConfig);
      const wCtx = await esbuild.context(watchConfig);
      const rtosCtx = await esbuild.context(rtosConfig);
      const spCtx = await esbuild.context(symbolPickerConfig);
      await Promise.all([extCtx.watch(), webviewCtx.watch(), daCtx.watch(), twCtx.watch(), tlCtx.watch(), wCtx.watch(), rtosCtx.watch(), spCtx.watch()]);
      console.log('[watch] extension + webview + debugadapter + trace-worker + timeline + watch + rtos + symbol-picker — waiting for changes...');
    } else {
      await Promise.all([esbuild.build(extConfig), esbuild.build(webviewConfig), esbuild.build(debugAdapterConfig), esbuild.build(traceWorkerConfig), esbuild.build(timelineConfig), esbuild.build(watchConfig), esbuild.build(rtosConfig), esbuild.build(symbolPickerConfig)]);
      console.log('[build] extension + webview + debugadapter + trace-worker + timeline + watch + rtos + symbol-picker — done');
    }
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

build();
