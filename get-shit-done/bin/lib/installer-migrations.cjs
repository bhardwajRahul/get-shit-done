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

function sha256Text(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
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
  writeFileAtomicSync(path.join(configDir, INSTALL_STATE_NAME), JSON.stringify(state, null, 2) + '\n');
  return state;
}

function readJson(configDir, relPath) {
  const { fullPath } = ensureInsideConfig(configDir, relPath);
  if (!fs.existsSync(fullPath)) {
    return { exists: false, value: null, error: null };
  }
  try {
    return { exists: true, value: JSON.parse(fs.readFileSync(fullPath, 'utf8')), error: null };
  } catch (error) {
    return { exists: true, value: null, error };
  }
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

function appliedMigrationEntries(state) {
  const entries = new Map();
  for (const entry of state.appliedMigrations) {
    if (entry && typeof entry.id === 'string' && !entries.has(entry.id)) {
      entries.set(entry.id, entry);
    }
  }
  return entries;
}

function migrationChecksum(migration) {
  if (typeof migration.checksum === 'string' && migration.checksum) return migration.checksum;
  const serializable = {
    id: migration.id,
    title: migration.title || null,
    description: migration.description || null,
    introducedIn: migration.introducedIn || null,
    runtimes: migration.runtimes || null,
    scopes: migration.scopes || null,
    destructive: migration.destructive === true,
    runtimeContract: migration.runtimeContract || null,
    plan: typeof migration.plan === 'function' ? migration.plan.toString() : null,
  };
  return `sha256:${sha256Text(JSON.stringify(serializable))}`;
}

function assertAppliedMigrationChecksums(state, migrations) {
  const applied = appliedMigrationEntries(state);
  for (const migration of migrations) {
    const entry = applied.get(migration.id);
    if (!entry || !entry.checksum) continue;
    const checksum = migrationChecksum(migration);
    if (entry.checksum !== checksum) {
      throw new Error(
        `applied migration checksum changed for ${migration.id}; create a new fix-forward migration id`
      );
    }
  }
}

function migrationMatchesContext(migration, { runtime, scope }) {
  if (Array.isArray(migration.runtimes) && migration.runtimes.length > 0) {
    if (!runtime || !migration.runtimes.includes(runtime)) return false;
  }
  if (Array.isArray(migration.scopes) && migration.scopes.length > 0) {
    if (!scope || !migration.scopes.includes(scope)) return false;
  }
  return true;
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
      const checksum = `sha256:${sha256File(source)}`;
      delete require.cache[require.resolve(source)];
      const exported = require(source);
      const records = Array.isArray(exported) ? exported : [exported];
      return records.map((record) => validateMigrationRecord({ ...record, checksum: record.checksum || checksum }, source));
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

function isStructurallyEmpty(value) {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === 'object' && Object.keys(value).length === 0;
}

function writeFileAtomicSync(filePath, content) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // best-effort cleanup only; preserve the original write failure
    }
    throw error;
  }
}

function journalAction(action, status, extras = {}) {
  const { value, ...safeAction } = action;
  return { ...safeAction, ...extras, status };
}

function planInstallerMigrations({
  configDir,
  runtime = null,
  scope = null,
  migrations,
  baselineScan = false,
  now = () => new Date().toISOString(),
}) {
  if (!configDir) throw new Error('configDir is required');
  if (!Array.isArray(migrations)) throw new Error('migrations must be an array');

  const manifest = readInstallManifest(configDir);
  const state = readInstallState(configDir);
  const scopedMigrations = migrations.filter((migration) =>
    migration && migrationMatchesContext(migration, { runtime, scope })
  );
  assertAppliedMigrationChecksums(state, scopedMigrations);
  const applied = appliedMigrationIds(state);
  const pending = scopedMigrations.filter((migration) => !applied.has(migration.id));
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
      runtime,
      scope,
      manifest,
      state,
      baselineScan,
      now,
      classifyArtifact: classify,
      readJson: (relPath) => readJson(configDir, relPath),
    });
    if (!Array.isArray(plannedActions)) {
      throw new Error(`migration ${migration.id} plan must return an array`);
    }
    for (const rawAction of plannedActions) {
      const relPath = normalizeRelPath(rawAction.relPath);
      const classification = rawAction.classification
        ? {
            classification: rawAction.classification,
            originalHash: rawAction.originalHash || null,
            currentHash: rawAction.currentHash || null,
          }
        : classify(relPath);
      let protectedType = rawAction.type;
      if (rawAction.type === 'remove-managed' && classification.classification === 'managed-modified') {
        protectedType = 'backup-and-remove';
      }
      if (rawAction.type === 'remove-managed' && classification.classification === 'unknown') {
        protectedType = 'preserve-user';
      }
      const action = {
        migrationId: migration.id,
        migrationChecksum: migrationChecksum(migration),
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
      if (action.type === 'rewrite-json') {
        action.value = rawAction.value;
        action.deleteIfEmpty = rawAction.deleteIfEmpty === true;
      }
      if (rawAction.prompt) action.prompt = rawAction.prompt;
      if (Array.isArray(rawAction.choices)) action.choices = rawAction.choices;
      if (action.type === 'prompt-user') {
        blocked.push(action);
      } else if (
        action.classification === 'unknown' &&
        action.type !== 'rewrite-json' &&
        action.type !== 'record-baseline' &&
        action.type !== 'baseline-preserve-user'
      ) {
        blocked.push(action);
      }
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

function rollbackAppliedMigrationResult({ configDir, journal, journalPath, rollbackRoot, previousInstallStateBytes }) {
  const failures = [];
  for (const action of [...journal.actions].reverse()) {
    if (!action.rollbackRelPath) continue;
    const rollbackPath = path.join(configDir, action.rollbackRelPath);
    const dest = path.join(configDir, action.relPath);
    try {
      if (fs.existsSync(rollbackPath)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(rollbackPath, dest);
      }
    } catch (error) {
      failures.push({ relPath: action.relPath, error: error.message });
    }
    if (action.backupRelPath) {
      try {
        fs.rmSync(path.join(configDir, action.backupRelPath), { force: true });
      } catch {
        // backup cleanup is best-effort; preserve restore failures above
      }
    }
  }

  try {
    if (previousInstallStateBytes === null) {
      fs.rmSync(path.join(configDir, INSTALL_STATE_NAME), { force: true });
    } else {
      fs.mkdirSync(configDir, { recursive: true });
      writeFileAtomicSync(path.join(configDir, INSTALL_STATE_NAME), previousInstallStateBytes);
    }
  } catch (error) {
    failures.push({ relPath: INSTALL_STATE_NAME, error: error.message });
  }

  try {
    fs.rmSync(journalPath, { force: true });
    fs.rmSync(rollbackRoot, { recursive: true, force: true });
  } catch {
    // journal cleanup is best-effort; the rollback above is the safety-critical part
  }

  if (failures.length > 0) {
    const error = new Error('migration rollback incomplete');
    error.rollbackFailures = failures;
    throw error;
  }
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
  const installStatePath = path.join(configDir, INSTALL_STATE_NAME);
  const previousInstallStateBytes = fs.existsSync(installStatePath)
    ? fs.readFileSync(installStatePath)
    : null;

  try {
    for (const action of plan.actions) {
      if (
        action.type !== 'remove-managed' &&
        action.type !== 'backup-and-remove' &&
        action.type !== 'rewrite-json' &&
        action.type !== 'record-baseline' &&
        action.type !== 'baseline-preserve-user'
      ) {
        throw new Error(`unsupported migration action type: ${action.type}`);
      }

      const { normalized, fullPath } = ensureInsideConfig(configDir, action.relPath);
      if (!fs.existsSync(fullPath)) {
        journal.actions.push(journalAction(action, 'missing'));
        continue;
      }

      if (action.type === 'record-baseline' || action.type === 'baseline-preserve-user') {
        journal.actions.push(journalAction(action, action.type === 'record-baseline' ? 'recorded' : 'preserved'));
        continue;
      }

      const rollbackPath = path.join(rollbackRoot, normalized);
      fs.mkdirSync(path.dirname(rollbackPath), { recursive: true });
      fs.copyFileSync(fullPath, rollbackPath);
      rollback.push({ relPath: normalized, rollbackPath });

      if (action.type === 'rewrite-json') {
        if (action.deleteIfEmpty && isStructurallyEmpty(action.value)) {
          fs.rmSync(fullPath, { force: true });
          journal.actions.push(journalAction(action, 'removed', {
            rollbackRelPath: path.posix.join(rollbackRootRelPath, normalized),
          }));
        } else {
          writeFileAtomicSync(fullPath, JSON.stringify(action.value, null, 2) + '\n');
          journal.actions.push(journalAction(action, 'rewritten', {
            rollbackRelPath: path.posix.join(rollbackRootRelPath, normalized),
          }));
        }
        continue;
      }

      if (action.type === 'backup-and-remove') {
        const backupRelPath = action.backupRelPath || path.posix.join('gsd-migration-backups', action.migrationId, normalized);
        const backupPath = path.join(configDir, backupRelPath);
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.copyFileSync(fullPath, backupPath);
        journal.actions.push(journalAction(action, 'removed', {
          backupRelPath,
          rollbackRelPath: path.posix.join(rollbackRootRelPath, normalized),
        }));
      } else {
        journal.actions.push(journalAction(action, 'removed', {
          rollbackRelPath: path.posix.join(rollbackRootRelPath, normalized),
        }));
      }
      fs.rmSync(fullPath, { force: true });
    }

    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2) + '\n', 'utf8');

    const state = readInstallState(configDir);
    const applied = appliedMigrationIds(state);
    const nextApplied = [...state.appliedMigrations];
    const actionsByMigrationId = new Map();
    for (const action of plan.actions) {
      if (action.migrationId && !actionsByMigrationId.has(action.migrationId)) {
        actionsByMigrationId.set(action.migrationId, action);
      }
    }
    for (const id of journal.appliedMigrationIds) {
      if (!applied.has(id)) {
        const action = actionsByMigrationId.get(id);
        nextApplied.push({
          id,
          appliedAt,
          journal: journalRelPath,
          checksum: action && action.migrationChecksum ? action.migrationChecksum : null,
        });
      }
    }
    writeInstallState(configDir, {
      schemaVersion: 1,
      appliedMigrations: nextApplied,
    });

    return {
      appliedMigrationIds: journal.appliedMigrationIds,
      journalRelPath,
      rollback: () => rollbackAppliedMigrationResult({
        configDir,
        journal,
        journalPath,
        rollbackRoot,
        previousInstallStateBytes,
      }),
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

function rollbackAppliedMigrationResult({ configDir, journal, journalPath, rollbackRoot, previousInstallStateBytes }) {
  const failures = [];
  for (const action of [...journal.actions].reverse()) {
    if (!action.rollbackRelPath) continue;
    const rollbackPath = path.join(configDir, action.rollbackRelPath);
    const dest = path.join(configDir, action.relPath);
    try {
      if (fs.existsSync(rollbackPath)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(rollbackPath, dest);
      }
    } catch (error) {
      failures.push({ relPath: action.relPath, error: error.message });
    }
    if (action.backupRelPath) {
      try {
        fs.rmSync(path.join(configDir, action.backupRelPath), { force: true });
      } catch {
        // backup cleanup is best-effort; preserve restore failures above
      }
    }
  }

  try {
    if (previousInstallStateBytes === null) {
      fs.rmSync(path.join(configDir, INSTALL_STATE_NAME), { force: true });
    } else {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, INSTALL_STATE_NAME), previousInstallStateBytes);
    }
  } catch (error) {
    failures.push({ relPath: INSTALL_STATE_NAME, error: error.message });
  }

  try {
    fs.rmSync(journalPath, { force: true });
    fs.rmSync(rollbackRoot, { recursive: true, force: true });
  } catch {
    // journal cleanup is best-effort; the rollback above is the safety-critical part
  }

  if (failures.length > 0) {
    const error = new Error('migration rollback incomplete');
    error.rollbackFailures = failures;
    throw error;
  }
}

function runInstallerMigrations({
  configDir,
  runtime = null,
  scope = null,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
  migrations = discoverInstallerMigrations({ migrationsDir }),
  baselineScan = false,
  now = () => new Date().toISOString(),
} = {}) {
  const plan = planInstallerMigrations({ configDir, runtime, scope, migrations, baselineScan, now });
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
