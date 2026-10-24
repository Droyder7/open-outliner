# Personal browser validation

Reference run: Chromium 156 / Playwright 1.64.1, headless, managed Linux cloud
workspace, Node 24.19.0, no CPU/network throttling. This is not a mobile claim.

PF-4 uses 20 samples per interaction on a 10,000-item shallow outline with valid
fractional ranks. Times run from dispatched input/command to the next animation
frame, including the command's synchronous model/DOM work. Tests assert no page
errors and at most 32 rendered tree rows. The nesting fixture has 1,000 levels.

Latest complete performance run: typing p95 14.9ms, keyboard navigation 14.8ms,
move 63.4ms, zoom 13.5ms. Budgets remain 50/50/100/100ms respectively. Both tests
pass. The fixture closes the live provider before loading an out-of-band test
snapshot, avoiding a fixture write racing IndexedDB compaction.

Seven production-PWA browser tests pass: local offline reload, cached-account
startup, quota failure, account reconnect/committed receipts, different-account
upload protection, structural undo/redo, and same-account tab continuity.

Run: build shared + crdt + client, start the server against a disposable migrated
PostgreSQL database, then `pnpm test:browser`. Browser binaries are installed with
`pnpm exec playwright install chromium`. The performance fixtures block service
workers to isolate rendering; offline tests exercise the actual service worker.
