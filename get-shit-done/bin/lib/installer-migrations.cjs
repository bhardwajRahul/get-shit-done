'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MANIFEST_NAME = 'gsd-file-manifest.json';
const INSTALL_STATE_NAME = 'gsd-install-state.json';
const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, 'installer-migrations');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readJsonIfPresent(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readInstallManifest(configDir) {
  const manifest = readJsonIfPresent(path.join(configDir, MANIFEST_NAME), null);
  if (!manifest || typeof manifest !== 'object') {
    return { version: null, timestamp: null, mode: null, files: {} };
  }
  return {
    version: manifest.version || null,
    timestamp: manifest.timestamp || null,
    mode: manifest.mode || null,
    files: manifest.files && typeof manifest.files === 'object' ? manifest.files : {},
  };
}

function readInstallState(configDir) {
  const state = readJsonIfPresent(path.join(configDir, INSTALL_STATE_NAME), null);
  if (!state || typeof state !== 'object') {
    return { schemaVersion: 1, appliedMigrations: [] };
  }
  return {
    schemaVersion: state.schemaVersion || 1,
    appliedMigrations: Array.isArray(state.appliedMigrations) ? state.appliedMigrations : [],
  };
}

function writeInstallState(configDir, state) {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, INSTALL_STATE_NAME), JSON.stringify(state, null, 2) + '\n', 'utf8');
  return state;
}

function normalizeRelPath(relPath) {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    throw new Error('migration action relPath must be a non-empty string');
  }
  const normalized = relPath.replace(/\\/g, '/');
  if (path.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) {
    throw new Error(`migration action relPath must stay inside configDir: ${relPath}`);
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`migration action relPath must stay inside configDir: ${relPath}`);
  }
  return segments.join('/');
}

function classifyArtifact(configDir, relPath, manifest) {
  const normalized = normalizeRelPath(relPath);
  const originalHash = manifest.files[normalized] || null;
  const fullPath = path.join(configDir, normalized);
  if (!fs.existsSync(fullPath)) {
    return { classification: originalHash ? 'managed-missing' : 'missing', originalHash, currentHash: null };
  }
  const currentHash = sha256File(fullPath);
  if (!originalHash) {
    return { classification: 'unknown', originalHash: null, currentHash };
  }
  if (currentHash === originalHash) {
    return { classification: 'managed-pristine', originalHash, currentHash };
  }
  return { classification: 'managed-modified', originalHash, currentHash };
}

function appliedMigrationIds(state) {
  return new Set(
    state.appliedMigrations
      .filter((entry) => entry && typeof entry.id === 'string')
      .map((entry) => entry.id)
  );
}

function validateMigrationRecord(record, source) {
  if (!record || typeof record !== 'object') {
    throw new Error(`migration record must export an object: ${source}`);
  }
  if (typeof record.id !== 'string' || record.id.trim() === '') {
    throw new Error(`migration record must include a non-empty id: ${source}`);
  }
  if (typeof record.plan !== 'function') {
    throw new Error(`migration record must include a plan function: ${source}`);
  }
  return record;
}

function discoverInstallerMigrations({ migrationsDir }) {
  if (!migrationsDir || !fs.existsSync(migrationsDir)) return [];
  return fs.readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.cjs'))
    .map((entry) => entry.name)
    .sort()
    .flatMap((fileName) => {
      const source = path.join(migrationsDir, fileName);
      delete require.cache[require.resolve(source)];
      const exported = require(source);
      const records = Array.isArray(exported) ? exported : [exported];
      return records.map((record) => validateMigrationRecord(record, source));
    });
}

function journalTimestamp(now) {
  return now().replace(/[:.]/g, '-');
}

function ensureInsideConfig(configDir, relPath) {
  const normalized = normalizeRelPath(relPath);
  const fullPath = path.resolve(configDir, normalized);
  const root = path.resolve(configDir);
  if (fullPath !== root && !fullPath.startsWith(root + path.sep)) {
    throw new Error(`migration path escapes configDir: ${relPath}`);
  }
  return { normalized, fullPath };
}

function planInstallerMigrations({ configDir, migrations, now = () => new Date().toISOString() }) {
  if (!configDir) throw new Error('configDir is required');
  if (!Array.isArray(migrations)) throw new Error('migrations must be an array');

  const manifest = readInstallManifest(configDir);
  const state = readInstallState(configDir);
  const applied = appliedMigrationIds(state);
  const pending = migrations.filter((migration) => migration && !applied.has(migration.id));
  const actions = [];
  const blocked = [];
  const classifications = new Map();
  const classify = (relPath) => {
    const normalized = normalizeRelPath(relPath);
    if (!classifications.has(normalized)) {
      classifications.set(normalized, classifyArtifact(configDir, normalized, manifest));
    }
    return classifications.get(normalized);
  };

  for (const migration of pending) {
    if (typeof migration.id !== 'string' || migration.id.trim() === '') {
      throw new Error('migration id must be a non-empty string');
    }
    if (typeof migration.plan !== 'function') {
      throw new Error(`migration ${migration.id} must provide a plan function`);
    }
    const plannedActions = migration.plan({
      configDir,
      manifest,
      state,
      now,
      classifyArtifact: classify,
    });
    if (!Array.isArray(plannedActions)) {
      throw new Error(`migration ${migration.id} plan must return an array`);
    }
    for (const rawAction of plannedActions) {
      const relPath = normalizeRelPath(rawAction.relPath);
      const classification = classify(relPath);
      let protectedType = rawAction.type;
      if (rawAction.type === 'remove-managed' && classification.classification === 'managed-modified') {
        protectedType = 'backup-and-remove';
      }
      if (rawAction.type === 'remove-managed' && classification.classification === 'unknown') {
        protectedType = 'preserve-user';
      }
      const action = {
        migrationId: migration.id,
        type: protectedType,
        relPath,
        reason: rawAction.reason || migration.description || '',
        classification: classification.classification,
        originalHash: classification.originalHash,
        currentHash: classification.currentHash,
      };
      if (action.type !== rawAction.type) {
        action.requestedType = rawAction.type;
      }
      if (action.type === 'backup-and-remove') {
        action.backupRelPath = path.posix.join('gsd-migration-backups', migration.id, relPath);
      }
      if (action.classification === 'unknown') blocked.push(action);
      actions.push(action);
    }
  }

  return {
    generatedAt: now(),
    manifest,
    state,
    pendingMigrationIds: pending.map((migration) => migration.id),
    actions,
    blocked,
  };
}

function uniqueActionMigrationIds(actions) {
  return [...new Set(actions.map((action) => action.migrationId).filter(Boolean))];
}

function applyInstallerMigrationPlan({ configDir, plan, now = () => new Date().toISOString() }) {
  if (!configDir) throw new Error('configDir is required');
  if (!plan || !Array.isArray(plan.actions)) throw new Error('plan with actions is required');
  if (Array.isArray(plan.blocked) && plan.blocked.length > 0) {
    throw new Error(`migration plan has ${plan.blocked.length} blocked action(s)`);
  }

  const appliedAt = now();
  const journalRelPath = path.posix.join('gsd-migration-journal', `${journalTimestamp(() => appliedAt)}.json`);
  const journalPath = path.join(configDir, journalRelPath);
  const rollbackRootRelPath = path.posix.join('gsd-migration-journal', `${journalTimestamp(() => appliedAt)}-rollback`);
  const rollbackRoot = path.join(configDir, rollbackRootRelPath);
  const journal = {
    schemaVersion: 1,
    appliedAt,
    appliedMigrationIds: uniqueActionMigrationIds(plan.actions),
    actions: [],
  };
  const rollback = [];

  try {
    for (const action of plan.actions) {
      if (action.type === 'preserve-user') {
        journal.actions.push({ ...action, status: 'preserved' });
        continue;
      }
      if (action.type !== 'remove-managed' && action.type !== 'backup-and-remove') {
        throw new Error(`unsupported migration action type: ${action.type}`);
      }

      const { normalized, fullPath } = ensureInsideConfig(configDir, action.relPath);
      if (!fs.existsSync(fullPath)) {
        journal.actions.push({ ...action, status: 'missing' });
        continue;
      }

      const rollbackPath = path.join(rollbackRoot, normalized);
      fs.mkdirSync(path.dirname(rollbackPath), { recursive: true });
      fs.copyFileSync(fullPath, rollbackPath);
      rollback.push({ relPath: normalized, rollbackPath });

      if (action.type === 'backup-and-remove') {
        const backupRelPath = action.backupRelPath || path.posix.join('gsd-migration-backups', action.migrationId, normalized);
        const backupPath = path.join(configDir, backupRelPath);
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.copyFileSync(fullPath, backupPath);
        journal.actions.push({ ...action, backupRelPath, rollbackRelPath: path.posix.join(rollbackRootRelPath, normalized), status: 'removed' });
      } else {
        journal.actions.push({ ...action, rollbackRelPath: path.posix.join(rollbackRootRelPath, normalized), status: 'removed' });
      }
      fs.rmSync(fullPath, { force: true });
    }

    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2) + '\n', 'utf8');

    const state = readInstallState(configDir);
    const applied = appliedMigrationIds(state);
    const nextApplied = [...state.appliedMigrations];
    for (const id of journal.appliedMigrationIds) {
      if (!applied.has(id)) {
        nextApplied.push({ id, appliedAt, journal: journalRelPath });
      }
    }
    writeInstallState(configDir, {
      schemaVersion: 1,
      appliedMigrations: nextApplied,
    });

    return {
      appliedMigrationIds: journal.appliedMigrationIds,
      journalRelPath,
    };
  } catch (error) {
    const rollbackFailures = [];
    for (const entry of rollback.reverse()) {
      const dest = path.join(configDir, entry.relPath);
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(entry.rollbackPath, dest);
      } catch (rollbackError) {
        rollbackFailures.push({
          relPath: entry.relPath,
          rollbackPath: entry.rollbackPath,
          error: rollbackError.message,
        });
      }
    }
    if (rollbackFailures.length > 0) {
      const rollbackError = new Error(`migration apply failed and rollback incomplete: ${error.message}`);
      rollbackError.cause = error;
      rollbackError.rollbackFailures = rollbackFailures;
      throw rollbackError;
    }
    throw error;
  }
}

function runInstallerMigrations({
  configDir,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
  migrations = discoverInstallerMigrations({ migrationsDir }),
  now = () => new Date().toISOString(),
} = {}) {
  const plan = planInstallerMigrations({ configDir, migrations, now });
  if (plan.actions.length === 0) {
    return {
      appliedMigrationIds: [],
      journalRelPath: null,
      plan,
    };
  }
  if (plan.blocked.length > 0) {
    return {
      appliedMigrationIds: [],
      journalRelPath: null,
      plan,
      blocked: plan.blocked,
    };
  }
  const result = applyInstallerMigrationPlan({ configDir, plan, now });
  return { ...result, plan };
}

module.exports = {
  DEFAULT_MIGRATIONS_DIR,
  INSTALL_STATE_NAME,
  MANIFEST_NAME,
  applyInstallerMigrationPlan,
  classifyArtifact,
  discoverInstallerMigrations,
  planInstallerMigrations,
  readInstallManifest,
  readInstallState,
  runInstallerMigrations,
  writeInstallState,
};
