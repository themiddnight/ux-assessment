// ux-assessment installer (SPEC D27):
//   node scripts/install.mjs [--no-claude] [--no-codex] [--skip-deps] [--deps-only]
// Exit codes: 0 ok, 1 missing prerequisite, 2 conflict. Conservative syntax on purpose (no optional
// chaining, no nullish coalescing, no static import, no top-level await): a Node older than 20 must
// reach the version message below, not a SyntaxError. The work is in install-lib.mjs.
var version = String(process.versions.node);
if (!(Number(version.split('.')[0]) >= 20)) {
  process.stderr.write('ux-assessment needs Node.js 20 or newer (found ' + version + '). Download it from https://nodejs.org/\n');
  process.exitCode = 1;
} else {
  import('./install-lib.mjs').then(function (lib) {
    return lib.main({ argv: process.argv.slice(2) });
  }).then(function (code) {
    process.exitCode = code;
  }, function (error) {
    process.stderr.write('install failed: ' + (error && error.message ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  });
}
