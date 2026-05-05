// allow-test-rule: source-text-is-the-product — commands/gsd/*.md files ARE the
// deployed skill surface. Testing their contract tests the runtime behaviour.

'use strict';

/**
 * Command Contract tests  (ADR-0002)
 *
 * Authoritative behavioral contract for every commands/gsd/*.md file.
 * Replaces scattered coverage in enh-2790-skill-consolidation and
 * bug-3135-capture-backlog-workflow for the full-surface contract checks.
 *
 * Contract:
 *   1. name:          present, non-empty, starts with gsd: or gsd-
 *   2. description:   present, non-empty
 *   3. allowed-tools: present, non-empty, all entries from CANONICAL_TOOLS
 *   4. execution_context @-refs: every reference resolves to an existing file
 *   5. execution_context @-refs: each on its own line (no trailing prose)
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');

const ROOT         = path.join(__dirname, '..');
const COMMANDS_DIR = path.join(ROOT, 'commands', 'gsd');
const GSD_ROOT     = path.join(ROOT, 'get-shit-done');

const CANONICAL_TOOLS = new Set([
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
  'Task', 'Agent', 'Skill', 'SlashCommand',
  'AskUserQuestion', 'WebFetch', 'WebSearch', 'TodoWrite',
  'mcp__context7__resolve-library-id',
  'mcp__context7__query-docs',
  'mcp__context7__*',
]);

// ─── helpers ─────────────────────────────────────────────────────────────────

function parseFrontmatter(content) {
  const lines = content.split('\n');
  if (lines[0].trim() !== '---') return {};
  const end = lines.indexOf('---', 1);
  if (end === -1) return {};
  const fm = {};
  let key = null;
  for (const line of lines.slice(1, end)) {
    const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)/);
    if (kv) { key = kv[1]; fm[key] = kv[2].trim(); }
    else if (key && line.match(/^\s+-\s+/)) {
      const val = line.replace(/^\s+-\s+/, '').trim();
      fm[key] = fm[key] ? fm[key] + '\n' + val : val;
    }
  }
  return fm;
}

function executionContextRefs(content) {
  const refs = [];
  const re = /<execution_context(?:_extended)?>([\s\S]*?)<\/execution_context(?:_extended)?>/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    for (const rawLine of m[1].split('\n')) {
      const line = rawLine.trim();
      if (!line.startsWith('@')) continue;
      const token = line.split(/\s+/)[0];
      const trailingProse = line.length > token.length;
      const normalized = token
        .replace(/^@(?:~|\$HOME)\//, '')
        .replace(/^(?:\.claude\/)?(?:get-shit-done\/)?/, '');
      refs.push({ token, normalized, trailingProse });
    }
  }
  return refs;
}

const commandFiles = fs
  .readdirSync(COMMANDS_DIR)
  .filter(f => f.endsWith('.md'))
  .map(f => ({ name: f, full: path.join(COMMANDS_DIR, f) }));

// ─── contract tests ───────────────────────────────────────────────────────────

describe('command contract: name field (ADR-0002)', () => {
  for (const { name, full } of commandFiles) {
    test(`${name}: name: present and starts with gsd: or gsd-`, () => {
      const fm = parseFrontmatter(fs.readFileSync(full, 'utf-8'));
      assert.ok(fm.name && fm.name.trim(), `${name}: name: field missing or empty`);
      assert.ok(
        /^gsd[:-]/.test(fm.name.trim()),
        `${name}: name: must start with "gsd:" or "gsd-", got "${fm.name.trim()}"`,
      );
    });
  }
});

describe('command contract: description field (ADR-0002)', () => {
  for (const { name, full } of commandFiles) {
    test(`${name}: description: present and non-empty`, () => {
      const fm = parseFrontmatter(fs.readFileSync(full, 'utf-8'));
      assert.ok(
        fm.description && fm.description.trim(),
        `${name}: description: field missing or empty`,
      );
    });
  }
});

describe('command contract: allowed-tools (ADR-0002)', () => {
  for (const { name, full } of commandFiles) {
    test(`${name}: allowed-tools: present, non-empty, all canonical`, () => {
      const fm = parseFrontmatter(fs.readFileSync(full, 'utf-8'));
      assert.ok(
        fm['allowed-tools'] && fm['allowed-tools'].trim(),
        `${name}: allowed-tools: block missing or empty`,
      );
      const tools = fm['allowed-tools'].split('\n').map(t => t.trim()).filter(Boolean);
      for (const tool of tools) {
        const valid =
          CANONICAL_TOOLS.has(tool) ||
          (tool.startsWith('mcp__context7__') && CANONICAL_TOOLS.has('mcp__context7__*'));
        assert.ok(valid, `${name}: unknown tool "${tool}" in allowed-tools`);
      }
    });
  }
});

describe('command contract: execution_context @-refs resolve (ADR-0002)', () => {
  for (const { name, full } of commandFiles) {
    const content = fs.readFileSync(full, 'utf-8');
    const refs = executionContextRefs(content);
    if (refs.length === 0) continue;
    for (const { token, normalized } of refs) {
      test(`${name}: @-ref "${normalized}" exists on disk`, () => {
        assert.ok(
          fs.existsSync(path.join(GSD_ROOT, normalized)),
          `${name}: execution_context @-ref "${normalized}" does not exist — ` +
          'create the file or remove the reference',
        );
      });
    }
  }
});

describe('command contract: execution_context @-refs on own line (ADR-0002)', () => {
  for (const { name, full } of commandFiles) {
    const content = fs.readFileSync(full, 'utf-8');
    const refs = executionContextRefs(content);
    if (refs.length === 0) continue;
    test(`${name}: no @-refs with trailing prose in execution_context`, () => {
      const bad = refs.filter(r => r.trailingProse);
      assert.equal(
        bad.length, 0,
        `${name}: @-refs with trailing prose in execution_context: ` +
        bad.map(r => r.token).join(', '),
      );
    });
  }
});
