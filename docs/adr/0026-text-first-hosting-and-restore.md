# ADR-0026 — Text-first hosting and isolated restore

**Status:** Accepted
**Date:** 2026-10-25 · **Deciders:** Approved personal-first delivery plan

## Context

A mandatory unavailable MinIO image blocked CI and self-hosting even though
personal outlining needs no object store. A successful build or database dump
alone does not demonstrate recovery of committed outlines.

## Decision

Ship web, app and PostgreSQL by default, pinned to tested image digests. The app
runs as the Node user with production dependencies. Build-time proxy trust is a
secret mount with TLS verification enabled. Keep external S3 configuration
optional; reject partial credentials explicitly. Do not recommend a replacement
production blob server without operating and validating it. CI uses the pinned
S3rver development emulator for attachment-cleanup regressions.

Backups include the complete database and checksums, use a private destination,
and never overwrite an existing backup. Enabled S3 or stored attachment metadata
requires stopped app writes and a fresh complete object-key-preserving mirror;
verify referenced keys and package it alongside the dump. No automatic pruning.
Scheduling, off-host copies and deployment-specific TLS are operator choices.

A restore drill always creates a new database with the outliner_restore_ prefix;
it never overwrites the live database or an existing target. Strictly decode all
Yjs documents and validate relational boundaries/revisions. The smoke workload
checks a known committed outline in restored Yjs and projected rows, including
its receipt. Blob bundles require a separate provider/bucket restore validation.

## Consequences

Text capture and recovery have fewer operational dependencies. Backups include
account/session state, rather than orphaning CRDT content from its owner. Browser
pending work and local checkpoints still require device exports. PostgreSQL
major-version upgrades require explicit dump/restore to a new volume. The
personal-first hosting contract supersedes conflicting mandatory-MinIO guidance
in older topic documents; existing accepted ADR files remain unchanged.
