---
type: Fixed
pr: 3516
---
**`/gsd-update --reapply` no longer treats installer-authored commits as user customizations** — the git-enhanced two-way merge filter in `get-shit-done/workflows/reapply-patches.md` was missing the `gsd-update` arm after the slash-command rename from `/gsd:update` to `/gsd-update`. Commits created by the current update flow now fall through the filter and are excluded from the diff, preventing spurious merge-conflict prompts. The legacy `gsd:update` arm is preserved for back-compat, and `GSD update` / `gsd-install` exclusions are unchanged. (#3516)
