const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  applyInstallerMigrationPlan,
  discoverInstallerMigrations,
  planInstallerMigrations,
  readInstallState,
  runInstallerMigrations,
  writeInstallState,
} = require('../get-shit-done/bin/lib/installer-migrations.cjs');

function createTempInstall() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-installer-migrations-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

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

test('plans a pending migration against an unchanged managed file', () => {
  const configDir = createTempInstall();
  try {
    writeFile(configDir, 'hooks/old-hook.js', 'managed hook\n');
    writeManifest(configDir, {
      'hooks/old-hook.js': sha256('managed hook\n'),
    });

    const plan = planInstallerMigrations({
      configDir,
      migrations: [
        {
          id: '2026-05-11-remove-old-hook',
          description: 'Remove retired hook',
          plan: () => [
            {
              type: 'remove-managed',
              relPath: 'hooks/old-hook.js',
              reason: 'retired hook',
            },
          ],
        },
      ],
      now: () => '2026-05-11T00:00:00.000Z',
    });

    assert.deepEqual(plan.pendingMigrationIds, ['2026-05-11-remove-old-hook']);
    assert.equal(plan.blocked.length, 0);
    assert.deepEqual(plan.actions, [
      {
        migrationId: '2026-05-11-remove-old-hook',
        type: 'remove-managed',
        relPath: 'hooks/old-hook.js',
        reason: 'retired hook',
        classification: 'managed-pristine',
        originalHash: sha256('managed hook\n'),
        currentHash: sha256('managed hook\n'),
      },
    ]);
  } finally {
    cleanup(configDir);
  }
});

test('plans backup before removal for a modified managed file', () => {
  const configDir = createTempInstall();
  try {
    writeFile(configDir, 'hooks/old-hook.js', 'user changed hook\n');
    writeManifest(configDir, {
      'hooks/old-hook.js': sha256('managed hook\n'),
    });

    const plan = planInstallerMigrations({
      configDir,
      migrations: [
        {
          id: '2026-05-11-remove-old-hook',
          description: 'Remove retired hook',
          plan: () => [
            {
              type: 'remove-managed',
              relPath: 'hooks/old-hook.js',
              reason: 'retired hook',
            },
          ],
        },
      ],
      now: () => '2026-05-11T00:00:00.000Z',
    });

    assert.equal(plan.blocked.length, 0);
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].type, 'backup-and-remove');
    assert.equal(plan.actions[0].classification, 'managed-modified');
    assert.equal(plan.actions[0].originalHash, sha256('managed hook\n'));
    assert.equal(plan.actions[0].currentHash, sha256('user changed hook\n'));
    assert.equal(plan.actions[0].backupRelPath, 'gsd-migration-backups/2026-05-11-remove-old-hook/hooks/old-hook.js');
  } finally {
    cleanup(configDir);
  }
});

test('blocks removal of unknown files by preserving them by default', () => {
  const configDir = createTempInstall();
  try {
    writeFile(configDir, 'hooks/custom-user-hook.js', 'user hook\n');
    writeManifest(configDir, {});

    const plan = planInstallerMigrations({
      configDir,
      migrations: [
        {
          id: '2026-05-11-remove-old-hook',
          description: 'Remove retired hook',
          plan: () => [
            {
              type: 'remove-managed',
              relPath: 'hooks/custom-user-hook.js',
              reason: 'retired hook',
            },
          ],
        },
      ],
      now: () => '2026-05-11T00:00:00.000Z',
    });

    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].type, 'preserve-user');
    assert.equal(plan.actions[0].requestedType, 'remove-managed');
    assert.equal(plan.actions[0].classification, 'unknown');
    assert.deepEqual(plan.blocked, [plan.actions[0]]);
  } finally {
    cleanup(configDir);
  }
});

test('applies an unblocked plan with a journal and install-state update', () => {
  const configDir = createTempInstall();
  try {
    writeFile(configDir, 'hooks/old-hook.js', 'managed hook\n');
    writeManifest(configDir, {
      'hooks/old-hook.js': sha256('managed hook\n'),
    });

    const plan = planInstallerMigrations({
      configDir,
      migrations: [
        {
          id: '2026-05-11-remove-old-hook',
          description: 'Remove retired hook',
          plan: () => [
            {
              type: 'remove-managed',
              relPath: 'hooks/old-hook.js',
              reason: 'retired hook',
            },
          ],
        },
      ],
      now: () => '2026-05-11T00:00:00.000Z',
    });

    const result = applyInstallerMigrationPlan({
      configDir,
      plan,
      now: () => '2026-05-11T00:00:01.000Z',
    });

    assert.equal(fs.existsSync(path.join(configDir, 'hooks/old-hook.js')), false);
    assert.deepEqual(result.appliedMigrationIds, ['2026-05-11-remove-old-hook']);
    assert.equal(result.journalRelPath, 'gsd-migration-journal/2026-05-11T00-00-01-000Z.json');

    const journal = JSON.parse(fs.readFileSync(path.join(configDir, result.journalRelPath), 'utf8'));
    assert.deepEqual(journal.appliedMigrationIds, ['2026-05-11-remove-old-hook']);
    assert.equal(journal.actions[0].relPath, 'hooks/old-hook.js');

    const state = readInstallState(configDir);
    assert.deepEqual(state.appliedMigrations.map((entry) => entry.id), ['2026-05-11-remove-old-hook']);
  } finally {
    cleanup(configDir);
  }
});

test('rolls back touched files and leaves state unchanged when apply fails', () => {
  const configDir = createTempInstall();
  try {
    writeFile(configDir, 'hooks/old-hook.js', 'managed hook\n');
    writeManifest(configDir, {
      'hooks/old-hook.js': sha256('managed hook\n'),
    });

    const plan = {
      pendingMigrationIds: ['2026-05-11-remove-old-hook'],
      blocked: [],
      actions: [
        {
          migrationId: '2026-05-11-remove-old-hook',
          type: 'remove-managed',
          relPath: 'hooks/old-hook.js',
          reason: 'retired hook',
          classification: 'managed-pristine',
          originalHash: sha256('managed hook\n'),
          currentHash: sha256('managed hook\n'),
        },
        {
          migrationId: '2026-05-11-remove-old-hook',
          type: 'unsupported-test-action',
          relPath: 'hooks/other.js',
          reason: 'force failure',
          classification: 'managed-pristine',
          originalHash: null,
          currentHash: null,
        },
      ],
    };

    assert.throws(
      () => applyInstallerMigrationPlan({
        configDir,
        plan,
        now: () => '2026-05-11T00:00:02.000Z',
      }),
      /unsupported migration action type/
    );

    assert.equal(fs.readFileSync(path.join(configDir, 'hooks/old-hook.js'), 'utf8'), 'managed hook\n');
    assert.deepEqual(readInstallState(configDir).appliedMigrations, []);
    assert.equal(fs.existsSync(path.join(configDir, 'gsd-migration-journal', '2026-05-11T00-00-02-000Z.json')), false);
  } finally {
    cleanup(configDir);
  }
});

test('reports rollback restore failures instead of swallowing them', () => {
  const configDir = createTempInstall();
  const originalCopyFileSync = fs.copyFileSync;
  try {
    writeFile(configDir, 'hooks/old-hook.js', 'managed hook\n');
    writeManifest(configDir, {
      'hooks/old-hook.js': sha256('managed hook\n'),
    });

    const plan = {
      blocked: [],
      actions: [
        {
          migrationId: '2026-05-11-remove-old-hook',
          type: 'remove-managed',
          relPath: 'hooks/old-hook.js',
          reason: 'retired hook',
          classification: 'managed-pristine',
          originalHash: sha256('managed hook\n'),
          currentHash: sha256('managed hook\n'),
        },
        {
          migrationId: '2026-05-11-remove-old-hook',
          type: 'unsupported-test-action',
          relPath: 'hooks/other.js',
          reason: 'force failure',
          classification: 'managed-pristine',
          originalHash: null,
          currentHash: null,
        },
      ],
    };

    fs.copyFileSync = (src, dest) => {
      if (String(src).includes('2026-05-11T00-00-04-000Z-rollback')) {
        throw new Error('simulated rollback copy failure');
      }
      return originalCopyFileSync(src, dest);
    };

    assert.throws(
      () => applyInstallerMigrationPlan({
        configDir,
        plan,
        now: () => '2026-05-11T00:00:04.000Z',
      }),
      (error) => {
        assert.match(error.message, /rollback incomplete/);
        assert.equal(error.rollbackFailures.length, 1);
        assert.equal(error.rollbackFailures[0].relPath, 'hooks/old-hook.js');
        return true;
      }
    );
  } finally {
    fs.copyFileSync = originalCopyFileSync;
    cleanup(configDir);
  }
});

test('skips migration records already present in install state', () => {
  const configDir = createTempInstall();
  try {
    writeManifest(configDir, {});
    writeInstallState(configDir, {
      schemaVersion: 1,
      appliedMigrations: [
        {
          id: '2026-05-11-remove-old-hook',
          appliedAt: '2026-05-11T00:00:00.000Z',
          journal: 'gsd-migration-journal/prior.json',
        },
      ],
    });

    const plan = planInstallerMigrations({
      configDir,
      migrations: [
        {
          id: '2026-05-11-remove-old-hook',
          description: 'Remove retired hook',
          plan: () => {
            throw new Error('already-applied migration planner must not run');
          },
        },
      ],
      now: () => '2026-05-11T00:00:03.000Z',
    });

    assert.deepEqual(plan.pendingMigrationIds, []);
    assert.deepEqual(plan.actions, []);
    assert.deepEqual(plan.blocked, []);
  } finally {
    cleanup(configDir);
  }
});

test('discovers migration records from a directory in filename order', () => {
  const configDir = createTempInstall();
  try {
    const migrationsDir = path.join(configDir, 'migrations');
    fs.mkdirSync(migrationsDir, { recursive: true });
    fs.writeFileSync(
      path.join(migrationsDir, '002-second.cjs'),
      "module.exports = { id: 'second', description: 'second', plan: () => [] };\n",
      'utf8'
    );
    fs.writeFileSync(
      path.join(migrationsDir, '001-first.cjs'),
      "module.exports = { id: 'first', description: 'first', plan: () => [] };\n",
      'utf8'
    );

    const migrations = discoverInstallerMigrations({ migrationsDir });

    assert.deepEqual(migrations.map((migration) => migration.id), ['first', 'second']);
  } finally {
    cleanup(configDir);
  }
});

test('rejects migration actions that escape the install root', () => {
  const configDir = createTempInstall();
  try {
    writeManifest(configDir, {});

    assert.throws(
      () => planInstallerMigrations({
        configDir,
        migrations: [
          {
            id: '2026-05-11-bad-path',
            description: 'Bad path',
            plan: () => [
              {
                type: 'remove-managed',
                relPath: 'hooks/../../outside.js',
                reason: 'bad path',
              },
            ],
          },
        ],
      }),
      /relPath must stay inside configDir/
    );
  } finally {
    cleanup(configDir);
  }
});

test('rejects migration actions that normalize to the install root', () => {
  const configDir = createTempInstall();
  try {
    writeManifest(configDir, {});

    for (const relPath of ['.', 'hooks/..']) {
      assert.throws(
        () => planInstallerMigrations({
          configDir,
          migrations: [
            {
              id: `2026-05-11-bad-path-${relPath.replace(/[^a-z0-9]/gi, '-')}`,
              description: 'Bad path',
              plan: () => [
                {
                  type: 'remove-managed',
                  relPath,
                  reason: 'bad path',
                },
              ],
            },
          ],
        }),
        /relPath must stay inside configDir/
      );
    }
  } finally {
    cleanup(configDir);
  }
});

test('runs discovered installer migrations against manifest-managed legacy orphan files', () => {
  const configDir = createTempInstall();
  try {
    writeFile(configDir, 'hooks/statusline.js', 'legacy managed hook\n');
    writeFile(configDir, 'hooks/custom.js', 'custom hook\n');
    writeManifest(configDir, {
      'hooks/statusline.js': sha256('legacy managed hook\n'),
    });

    const result = runInstallerMigrations({
      configDir,
      now: () => '2026-05-11T00:00:05.000Z',
    });

    assert.equal(fs.existsSync(path.join(configDir, 'hooks/statusline.js')), false);
    assert.equal(fs.readFileSync(path.join(configDir, 'hooks/custom.js'), 'utf8'), 'custom hook\n');
    assert.deepEqual(result.appliedMigrationIds, ['2026-05-11-legacy-orphan-files']);
    assert.deepEqual(readInstallState(configDir).appliedMigrations.map((entry) => entry.id), ['2026-05-11-legacy-orphan-files']);
  } finally {
    cleanup(configDir);
  }
});
