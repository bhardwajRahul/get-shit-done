'use strict';

function installerMigrationActionLabel(action) {
  if (!action || !action.type) return 'skipped';
  if (action.type === 'backup-and-remove') return 'backed up and removed';
  if (action.type === 'remove-managed') return 'removed';
  if (action.type === 'rewrite-json') return action.deleteIfEmpty ? 'rewrote or removed' : 'rewrote';
  if (action.type === 'record-baseline') return 'recorded';
  if (action.type === 'baseline-preserve-user') return 'preserved';
  if (action.type === 'preserve-user') return 'preserved';
  if (action.type === 'prompt-user') return 'blocked';
  return 'skipped';
}

function blockedInstallerMigrationActions(result) {
  if (result && Array.isArray(result.blocked)) return result.blocked;
  const plan = result && result.plan;
  if (plan && Array.isArray(plan.blocked)) return plan.blocked;
  return [];
}

function summarizeInstallerMigrationResult(result) {
  const plan = result && result.plan;
  const actions = plan && Array.isArray(plan.actions) ? plan.actions : [];
  const blocked = blockedInstallerMigrationActions(result);
  const blockedSet = new Set(blocked);

  return {
    hasReportableActions: actions.length > 0 || blocked.length > 0,
    blocked,
    rows: actions.map((action) => ({
      label: blockedSet.has(action) ? 'blocked' : installerMigrationActionLabel(action),
      relPath: action.relPath,
      reason: action.reason || '',
      action,
    })),
  };
}

function assertInstallerMigrationsUnblocked(result) {
  const blocked = blockedInstallerMigrationActions(result);
  if (blocked.length === 0) return;
  const paths = blocked.map((action) => action.relPath).join(', ');
  throw new Error(`installer migration blocked pending user choice: ${paths}`);
}

module.exports = {
  assertInstallerMigrationsUnblocked,
  summarizeInstallerMigrationResult,
};
