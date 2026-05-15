---
type: Fixed
pr: 3578
---
**`/gsd:plan-phase` now refuses to replan closed phases** — `init.plan-phase` exposes a new `phase_status` field and the workflow short-circuits on `Complete` phases (use `--force` to override; `--reviews` has no override).
