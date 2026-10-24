# ADR-0023 — Local library and committed update receipts

**Status:** Accepted
**Date:** 2026-10-25 · **Deciders:** Personal-first plan

## Decision

Account-scoped IndexedDB owns the local catalog, document cache and pending byte
batches. Opening cached documents does not require an authentication round trip.
Offline creation uses client UUIDs and idempotent authorized server registration.
The personal client uses a periodic/reconnect RPC exchange of Yjs updates; live
WebSocket rooms remain for legacy/future collaborative clients. This avoids
uploading cached account data through a socket before identity is verified.

Every batch has an immutable UUID and digest. PersistDocumentUpdate returns its
receipt only after both update and receipt commit. Retrying returns the same
revision; changing bytes for a used ID is a conflict. GetDocumentState returns a
revision-bound snapshot. Payloads are bounded and schemas must match.

The client verifies the current server identity before upload, retains pending
updates on errors and replays them locally after restart. A loaded state is also
captured to reconcile local IDB/pending-write timing. Quota failure is never a
successful save. Guest data stays separate; signing in does not automatically
transfer it to an account. No data reset is performed by this milestone.

## Evidence

Five Playwright offline/account/storage tests against the production PWA build;
document-receipts.integration.test.ts against PostgreSQL; existing client tests.
