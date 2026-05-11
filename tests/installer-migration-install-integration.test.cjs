/**
 * Phase 4 installer migration integration tests.
 *
 * These exercise the public install() entry point so the migration runner is
 * pinned at the install/update seam, not just as a standalone library.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const installModule = require('../bin/install.js');
const { install } = installModule;
const { createTempDir, cleanup } = require('./helpers.cjs');

const installScript = path.join(__dirname, '..', 'bin', 'install.js');
const SUPPORTED_RUNTIMES = installModule.allRuntimes;

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function writeFile(root, relPath, content) {
  const fullPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function writeManifest(root, files) {
  fs.writeFileSync(
    path.join(root, 'gsd-file-manifest.json'),
    JSON.stringify({
      version: '1.49.0',
      timestamp: '2026-05-10T00:00:00.000Z',
      mode: 'full',
      files,
    }, null, 2),
    'utf8'
  );
}

function withEnv(key, value, fn) {
  const previous = process.env[key];
  process.env[key] = value;
  try {
    return fn();
  } finally {
    if (previous == null) delete process.env[key];
    else process.env[key] = previous;
  }
}

function captureConsole(fn) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const lines = [];
  console.log = (...args) => { lines.push(args.join(' ')); };
  console.warn = (...args) => { lines.push(args.join(' ')); };
  try {
    return { value: fn(), output: lines.join('\n') };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function runInstallerCli(runtime, targetDir) {
  const env = { ...process.env };
  delete env.GSD_TEST_MODE;

  return spawnSync(
    process.execPath,
    [installScript, `--${runtime}`, '--global', '--config-dir', targetDir, '--minimal', '--no-sdk'],
    {
      encoding: 'utf8',
      env,
    }
  );
}

describe('installer migration install integration', { concurrency: false }, () => {
  let tmpRoot;
  let codexHome;

  beforeEach(() => {
    tmpRoot = createTempDir('gsd-install-migrations-');
    codexHome = path.join(tmpRoot, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpRoot);
  });

  test('reports applied migration actions before package materialization', () => {
    writeFile(codexHome, 'hooks/statusline.js', 'legacy managed hook\n');
    writeManifest(codexHome, {
      'hooks/statusline.js': sha256('legacy managed hook\n'),
    });

    const { output } = captureConsole(() =>
      withEnv('CODEX_HOME', codexHome, () => install(true, 'codex'))
    );

    const plainOutput = stripAnsi(output);
    assert.match(plainOutput, /Installer migrations/);
    assert.match(plainOutput, /removed\s+hooks\/statusline\.js/);
    assert.ok(
      plainOutput.indexOf('Installer migrations') < plainOutput.indexOf('Installed get-shit-done'),
      'migration report should appear before package materialization'
    );
    assert.equal(fs.existsSync(path.join(codexHome, 'hooks/statusline.js')), false);
  });

  test('blocks install before materialization when baseline needs explicit user choice', () => {
    writeFile(codexHome, 'hooks/gsd-retired-hook.js', 'old gsd hook\n');

    assert.throws(
      () => captureConsole(() =>
        withEnv('CODEX_HOME', codexHome, () => install(true, 'codex'))
      ),
      /installer migration blocked/
    );

    assert.equal(fs.readFileSync(path.join(codexHome, 'hooks/gsd-retired-hook.js'), 'utf8'), 'old gsd hook\n');
    assert.equal(fs.existsSync(path.join(codexHome, 'skills')), false);
    assert.equal(fs.existsSync(path.join(codexHome, 'get-shit-done', 'VERSION')), false);
  });

  for (const runtime of SUPPORTED_RUNTIMES) {
    test(`runs managed cleanup migrations for ${runtime}`, () => {
      const targetDir = path.join(tmpRoot, `.${runtime}-managed-cleanup`);
      fs.mkdirSync(targetDir, { recursive: true });
      writeFile(targetDir, 'hooks/statusline.js', 'legacy managed hook\n');
      writeManifest(targetDir, {
        'hooks/statusline.js': sha256('legacy managed hook\n'),
      });

      const result = runInstallerCli(runtime, targetDir);

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
      assert.match(output, /Installer migrations/);
      assert.match(output, /removed\s+hooks\/statusline\.js/);
      assert.equal(fs.existsSync(path.join(targetDir, 'hooks/statusline.js')), false);
      const installState = JSON.parse(fs.readFileSync(path.join(targetDir, 'gsd-install-state.json'), 'utf8'));
      assert.ok(
        installState.appliedMigrations.some((entry) => entry.id === '2026-05-11-legacy-orphan-files'),
        'successful install should write install state for the applied cleanup migration'
      );
    });

    test(`blocks ambiguous GSD-looking user-choice artifacts for ${runtime}`, () => {
      const targetDir = path.join(tmpRoot, `.${runtime}-blocked`);
      fs.mkdirSync(targetDir, { recursive: true });
      writeFile(targetDir, 'get-shit-done/gsd-retired-tool.cjs', 'old ambiguous artifact\n');

      const result = runInstallerCli(runtime, targetDir);

      assert.notEqual(result.status, 0, 'install should fail before materialization');
      const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
      assert.match(output, /Installer migrations/);
      assert.match(output, /blocked\s+get-shit-done\/gsd-retired-tool\.cjs/);
      assert.match(output, /installer migration blocked/);
      assert.equal(
        fs.readFileSync(path.join(targetDir, 'get-shit-done/gsd-retired-tool.cjs'), 'utf8'),
        'old ambiguous artifact\n'
      );
      assert.equal(fs.existsSync(path.join(targetDir, 'get-shit-done', 'VERSION')), false);
    });
  }
});
