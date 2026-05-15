'use strict';

/**
 * runtime-slash.cjs — single source of truth for emitting GSD slash-command
 * references in user-facing runtime output (recommended-actions JSON, persisted
 * ROADMAP.md entries, verify/validate fix hints, error messages, etc.).
 *
 * Background: #2808 unified all GSD skill installs to register under the hyphen
 * form (`name: gsd-<cmd>`). The legacy colon form `/gsd:<cmd>` is no longer
 * routable by Claude Code skill installs, but ~50 runtime emissions in
 * bin/lib/*.cjs still hardcoded it (#3584). Codex installs need the shell-var
 * `$gsd-<cmd>` form. This module is the only place the runtime should decide
 * which shape to emit.
 *
 *   - codex:                                   $gsd-<cmd>   (shell-var syntax)
 *   - claude, cursor, opencode, kilo, etc.:    /gsd-<cmd>
 *
 * The colon form is never emitted.
 */

function formatGsdSlash(commandName, runtime) {
  if (typeof commandName !== 'string') return commandName;
  if (commandName === '') return commandName;

  // Strip any existing leading prefix so the helper is idempotent and accepts
  // both legacy `/gsd:<name>` and canonical hyphen-form input (plus the bare
  // `gsd:<name>` shorthand and codex `$gsd-<name>` shell-var input).
  const stripped = commandName.replace(/^[/$]?gsd[-:]/i, '');
  // If the regex matched nothing (no prefix), the input is already a bare name.
  const bare = stripped === commandName ? commandName : stripped;
  if (bare === '') return commandName;

  const rt = String(runtime || 'claude').toLowerCase();
  if (rt === 'codex') {
    // Codex skills are invoked as $gsd-<cmd> (shell-var syntax). Lowercased
    // because shell-var identifiers in the surrounding prose are conventionally
    // lowercase; matches the convertCodexSlash() projection in bin/install.js.
    return `$gsd-${bare.toLowerCase()}`;
  }
  return `/gsd-${bare}`;
}

/**
 * Resolve the effective runtime for a project directory.
 *
 *   process.env.GSD_RUNTIME  >  config.runtime  >  'claude'
 *
 * Mirrors the precedence already used by profile-output.cjs and the rest of
 * the runtime resolution chain. Returns a lowercased string so downstream
 * comparisons can be case-blind.
 *
 * @param {string|null|undefined} projectDir
 * @returns {string}
 */
function resolveRuntime(projectDir) {
  if (process.env.GSD_RUNTIME) {
    return String(process.env.GSD_RUNTIME).toLowerCase();
  }
  if (projectDir) {
    try {
      // Read config.json directly (not via loadConfig). loadConfig has a side
      // effect of normalizing and re-writing legacy keys back to disk, which
      // would mutate the project file just to read the runtime name. We only
      // need the literal `runtime:` value, so a plain JSON read is sufficient
      // and side-effect-free.
      const fs = require('fs');
      const path = require('path');
      const configPath = path.join(projectDir, '.planning', 'config.json');
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.runtime) {
          return String(parsed.runtime).toLowerCase();
        }
      }
    } catch {
      // Fall through to default — a missing/broken config must not crash
      // runtime output formatting.
    }
  }
  return 'claude';
}

/**
 * Convenience: format using the runtime resolved from a project directory.
 * Equivalent to `formatGsdSlash(name, resolveRuntime(projectDir))`.
 */
function formatGsdSlashFor(projectDir, commandName) {
  return formatGsdSlash(commandName, resolveRuntime(projectDir));
}

module.exports = {
  formatGsdSlash,
  resolveRuntime,
  formatGsdSlashFor,
};
