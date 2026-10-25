# Personal browser validation

Reference run: Chromium 156 / Playwright 1.64.1, headless, managed Linux cloud
workspace, Node 24.19.0, no CPU/network throttling. This is not a mobile claim.

PF-4 uses 20 samples per interaction on a 10,000-item shallow outline with valid
fractional ranks. Times run from dispatched input/command to the next animation
frame, including the command's synchronous model/DOM work. Tests assert no page
errors and at most 32 rendered tree rows. The nesting fixture has 1,000 levels.

Latest complete performance run: typing p95 15.8ms, keyboard navigation 15.4ms,
move 41.7ms, zoom 15.5ms. Budgets remain 50/50/100/100ms respectively. Both tests
pass. The fixture closes the live provider before loading an out-of-band test
snapshot, avoiding a fixture write racing IndexedDB compaction.

Seven production-PWA browser tests pass: local offline reload, cached-account
startup, quota failure, account reconnect/committed receipts, different-account
upload protection, structural undo/redo, and same-account tab continuity.

Run: build shared + crdt + client, start the server against a disposable migrated
PostgreSQL database, then `pnpm test:browser`. Browser binaries are installed with
`pnpm exec playwright install chromium`. The performance fixtures block service
workers to isolate rendering; offline tests exercise the actual service worker.

PF-5 adds two workflow journeys: capture with title/notes, note search, trash and
restore, JSON download/re-import, checkpoint recovery; and revealing a collapsed
search match while rejecting invalid imports without changing the catalog.
Recovery always creates another document. Exports include one canonical root;
a session regression guards schema/root initialization. Pre-versioned development
caches get a raw checkpoint before conversion, preserving legacy trash.

Final PF-6 run: all 12 Chromium cases pass. A second isolated browser profile logs
into the same account, opens the synced document, and edits the same text offline
alongside the first profile. Reconnecting both retains both insertions and yields
the same text and committed status. This exercises the real HTTP receipt/pull
path across independent IndexedDB databases, in addition to the tab channel.
