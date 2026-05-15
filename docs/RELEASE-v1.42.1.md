# v1.42.1 Release Notes

Stable release. Published to npm under the `latest` tag.

```bash
npx get-shit-done-cc@latest
```

---

## What's in this release

1.42.1 is a safety, documentation, and control-surface release. The headline additions are the package legitimacy gate, skill-surface budgeting, installer migrations, configurable ship PR sections, reviewer defaults, and optional fallow structural review. It also includes execution and state hardening across quota handling, milestone tags, `project_code` phase directories, phase completion, nested git detection, Codex install migration, and SDK readiness.

## Added

- **Package legitimacy gate against slopsquatting** — researchers audit external packages with `slopcheck`, planners add human verification for unverified packages, and executors stop on package install failures instead of trying similarly named alternatives.
- **Skill surface budgeting** — install with `--profile=core`, `--profile=standard`, or the default `full`; profiles persist in `.gsd-profile`. Use `/gsd:surface` to list, enable, disable, or switch skill clusters without reinstalling.
- **Installer migrations** — install now has an explicit migration framework for baseline scanning, legacy cleanup, user-owned file preservation, rollback, and ambiguous stale-file guardrails.
- **Configurable `/gsd-ship` PR body sections** — `ship.pr_body_sections` appends project-specific PRD-style sections while preserving required review sections.
- **`review.default_reviewers`** — no-flag `/gsd-review` can default to a configured reviewer subset; explicit flags and `--all` still take precedence.
- **Optional fallow structural review** — `code_quality.fallow.*` runs a structural pre-pass for `/gsd-code-review`, writes `FALLOW.json`, and embeds findings in `REVIEW.md`.
- **Statusline context meter placement** — `statusline.context_position: "front"` keeps the context meter visible on narrow terminals.
- **Structured CLI errors** — `--json-errors` returns machine-readable error envelopes for `gsd-tools` callers.

## Changed

- **Human verification defaults to end-of-phase** — `workflow.human_verify_mode: "end-of-phase"` keeps human checks in verification blocks instead of scattering mid-flight checkpoint tasks. Set `"mid-flight"` to restore the older behavior.
- **Quota and rate-limit failures get a distinct recovery path** — execute-phase classifies provider quota failures and guides wait-and-resume rather than retry-now.
- **Milestone tags can be disabled** — `git.create_tag: false` prevents automatic tags for projects with their own release process.
- **Reasoning effort is transported with resolved model IDs** — runtime-aware model resolution now carries `reasoning_effort` where supported, including Codex config output and SDK query paths.
- **Shell command projection and SDK architecture seams were deepened** — hook commands, path actions, subprocess execution, platform file I/O, and SDK compatibility policy now flow through narrower typed modules.

## Fixed

- `project_code` phase directory prefixes now apply consistently across discuss, plan, import, gap-planning, and backlog creation paths.
- Phase completion is idempotent and refreshes stale `STATE.md` progress and focus fields.
- `/gsd-new-project` and ingest flows detect nested git worktrees and avoid creating nested `.git` directories.
- Codex install migration preserves user hooks, removes duplicate legacy hook entries, and emits correct event-name keys.
- SDK install readiness now requires durable shims before printing "GSD SDK ready", including Windows PATH repair.
- User custom skills are detected during update preservation scans.
- Decimal-phase short-form `depends_on` references resolve correctly.
- `gsd-sdk query commit --files --respect-staged` preserves interactive staging.

## Installing

```bash
# npm (global)
npm install -g get-shit-done-cc@latest

# npx (one-shot)
npx get-shit-done-cc@latest

# Pin to this exact version
npm install -g get-shit-done-cc@1.42.1
```

The installer is idempotent. Re-running it updates in place while preserving `.planning/` and local patches.
