# Personal-first delivery plan

Accepted 2026-10-25. Preserve the stack and deliver each milestone in a separate
commit on main after its relevant checks. [Review](architecture-review.md) records
the starting defects. ADR-0021 establishes the revised product direction.

| Milestone | Deliverable | Acceptance gate |
|---|---|---|
| PF-0 | Baseline, export/reset discipline, specifications | Baseline recorded; identified data exported before any reset |
| PF-1 | Compaction, snapshot revisions, isolation, note ownership | Deterministic PostgreSQL interleavings and document-boundary regressions |
| PF-2 | Local catalog, offline boot, pending updates, committed receipts | Browser reload/reconnect and storage/auth failure tests |
| PF-3 | Schema v2, shared effective tree, delete/restore, undo | Merge-order and offline tree/recovery scenarios |
| PF-4 | Indexed tree traversal and visible-row rendering | Measured 10k browser navigation/editing; 1k nesting |
| PF-5 | Navigation, local search, trash, checkpoints, import/export | Browser capture/develop/retrieve/recover journey |
| PF-6 | Text-only deployment, optional S3, backup/restore | Clean deployment and isolated restore drill |

Plain text, notes, completion, background personal-device sync, and indefinite
trash/checkpoints are in scope. Rich text, backlinks, mirrors, boards, team
sharing expansion, and multi-server operation are deferred. Existing development
data may be reset only after readable exports are verified; no unidentified or
production dataset may be reset. No connected user database or browser profile
was supplied at the baseline, so no user data was reset or purportedly backed up at that baseline. PF-3 later
exported the identified disposable test database and verified a separate restore
before its reset (ADR-0024).
Keep original browser storage until it can be exported explicitly.

Core semantics: atomic native-Yjs placement, deterministic derived recovery of
cycles/orphans, delete records plus observed restore acknowledgements, local
undo, new-document checkpoint recovery. No wall-clock-winner promise. Server
receipts acknowledge committed batches; WebSocket connectivity is not durability.

Tests must cover actual browser boot, not just headless stores. Gate status must
remain Implemented until the documented acceptance workload is verified. Do not
silently weaken a performance threshold to obtain a passing test.

All milestone acceptance workloads are now verified locally; see
[status](status.md), [browser evidence](personal-browser-validation.md), and
[self-host evidence](personal-self-host-validation.md). The CI workflow repeats
unit/type/lint, PostgreSQL/S3 regressions, browser journeys and clean restore.
The deferred collaboration and mobile/a11y scope is unchanged.
