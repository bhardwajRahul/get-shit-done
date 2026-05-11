'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertInstallerMigrationsUnblocked,
  summarizeInstallerMigrationResult,
} = require('../get-shit-done/bin/lib/installer-migration-report.cjs');

test('summarizes every installer migration report category', () => {
  const blockedAction = {
    type: 'prompt-user',
    relPath: 'hooks/gsd-retired-hook.js',
    reason: 'needs a user choice',
  };
  const result = {
    blocked: [blockedAction],
    plan: {
      actions: [
        {
          type: 'remove-managed',
          relPath: 'hooks/statusline.js',
          reason: 'retired hook',
        },
        {
          type: 'backup-and-remove',
          relPath: 'hooks/modified.js',
          reason: 'modified managed hook retired',
        },
        {
          type: 'baseline-preserve-user',
          relPath: 'hooks/custom.js',
          reason: 'user-owned hook',
        },
        {
          type: 'unknown-action',
          relPath: 'hooks/unknown.js',
          reason: 'unsupported in this installer',
        },
        blockedAction,
      ],
    },
  };

  assert.deepEqual(
    summarizeInstallerMigrationResult(result).rows.map((row) => ({
      label: row.label,
      relPath: row.relPath,
      reason: row.reason,
    })),
    [
      {
        label: 'removed',
        relPath: 'hooks/statusline.js',
        reason: 'retired hook',
      },
      {
        label: 'backed up and removed',
        relPath: 'hooks/modified.js',
        reason: 'modified managed hook retired',
      },
      {
        label: 'preserved',
        relPath: 'hooks/custom.js',
        reason: 'user-owned hook',
      },
      {
        label: 'skipped',
        relPath: 'hooks/unknown.js',
        reason: 'unsupported in this installer',
      },
      {
        label: 'blocked',
        relPath: 'hooks/gsd-retired-hook.js',
        reason: 'needs a user choice',
      },
    ]
  );
});

test('throws when installer migrations require user choice', () => {
  assert.throws(
    () => assertInstallerMigrationsUnblocked({
      blocked: [
        {
          relPath: 'hooks/gsd-retired-hook.js',
        },
      ],
    }),
    /installer migration blocked pending user choice: hooks\/gsd-retired-hook\.js/
  );
});
