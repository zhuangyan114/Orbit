#!/usr/bin/env node

'use strict';

const { runTests } = require('@vscode/test-electron');

const options = JSON.parse(process.env.ORBIT_TEST_HOST_OPTIONS || '{}');
if (!options.extensionDevelopmentPath || !options.extensionTestsPath) {
  console.error('ORBIT_TEST_HOST_OPTIONS must include extensionDevelopmentPath and extensionTestsPath');
  process.exit(1);
}

runTests(options).then(() => {
  process.exit(0);
}, (error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
