import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDirectory = fileURLToPath(new URL('../test/', import.meta.url));

export function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return testFiles(path);
      return entry.isFile() && entry.name.endsWith('.test.mjs') ? [path] : [];
    })
    .sort();
}

export function testArgs({ directory = testDirectory, cwd = process.cwd(), nodeArgs = [] } = {}) {
  const files = testFiles(directory);
  return files.length
    ? ['--test', ...nodeArgs, ...files.map((path) => relative(cwd, path))]
    : null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = testArgs({ nodeArgs: process.argv.slice(2) });
  if (!args) {
    console.error(`No .test.mjs files found in ${testDirectory}`);
    process.exitCode = 1;
  } else {
    const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
}
