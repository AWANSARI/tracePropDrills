// Bundles test/run.ts with `vscode` aliased to the mock, then executes it.
const esbuild = require('esbuild');
const path = require('path');

async function main() {
  await esbuild.build({
    entryPoints: ['test/run.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: 'dist-test/run.js',
    sourcemap: 'inline',
    logLevel: 'warning',
    plugins: [
      {
        name: 'vscode-mock-alias',
        setup(build) {
          build.onResolve({ filter: /^vscode$/ }, () => ({
            path: path.resolve(__dirname, 'vscode-mock.ts'),
          }));
        },
      },
    ],
  });
  require(path.resolve(__dirname, '..', 'dist-test', 'run.js'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
