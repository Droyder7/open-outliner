import { useEffect, useMemo, useRef, useState } from 'react';
import { createSession, type Session } from './session.js';
import { Outliner } from './Outliner.js';
import { AuthGate, type AuthedUser } from './auth/AuthGate.js';
import { StorageBanner } from './offline/StorageBanner.js';
import { detectStorageAvailability } from './offline/storage-status.js';
import { registerReconnectFlush } from './offline/outbox.js';
import { createRpcClient, RpcClientError } from './rpc.js';

/**
 * App shell: opens one editing session (Y.Doc + local persistence + optional
 * sync) for the document named in `?doc=`, and renders the outliner once local
 * state has loaded. Offline-first — with no sync URL configured this is a fully
 * usable local outliner with no account. When a sync URL IS configured, the
 * Hocuspocus server requires an authenticated session (Phase 5/SEC), so the
 * outliner renders behind `AuthGate`, and the durable mutation outbox (OFF)
 * replays queued API-plane writes on reconnect.
 */

const DEFAULT_DOC = 'demo-document';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const rpc = createRpcClient();

function documentIdFromLocation(): string {
  return new URLSearchParams(window.location.search).get('doc') ?? DEFAULT_DOC;
}

function replaceDocQuery(documentId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set('doc', documentId);
  window.history.replaceState({}, '', url.toString());
}

export function App(): JSX.Element {
  const documentIdHint = useMemo(documentIdFromLocation, []);
  const syncConfigured = Boolean(import.meta.env.VITE_SYNC_URL);

  useEffect(() => {
    void detectStorageAvailability();
  }, []);

  useEffect(() => {
    if (!syncConfigured) return undefined;
    // Offline-access-loss (ADR-0014/offline-and-pwa.md): a queued replay
    // rejected as unauthorized means the session was revoked while
    // disconnected. Reload so AuthGate re-resolves WhoAmI and shows the
    // login form — the simplest correct way to fully reset client state.
    return registerReconnectFlush(() => window.location.reload());
  }, [syncConfigured]);

  return (
    <div className="app">
      {syncConfigured ? (
        <AuthGate>
          {(user, logout) => (
            <SyncedDocument user={user} documentIdHint={documentIdHint} onLogout={logout} />
          )}
        </AuthGate>
      ) : (
        <>
          <AppHeader documentId={documentIdHint} />
          <StorageBanner />
          <DocumentView documentId={documentIdHint} />
        </>
      )}
    </div>
  );
}

/**
 * Server-synced path: WS auth gates on workspace membership of a real
 * `documents` row (canAccessDocument). A bare `?doc=smoke-doc-1` string is
 * not a document id, so resolve or create one before opening the provider.
 */
function SyncedDocument({
  user,
  documentIdHint,
  onLogout,
}: {
  user: AuthedUser;
  documentIdHint: string;
  onLogout: () => Promise<void>;
}): JSX.Element {
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<Session | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const workspaceId = user.workspaceIds[0];
        if (!workspaceId) {
          if (alive) setError('No workspace on this account');
          return;
        }
        const { documents } = await rpc.call('ListDocuments', { workspaceId });
        let resolved: string | undefined;
        if (UUID_RE.test(documentIdHint) && documents.some((d) => d.id === documentIdHint)) {
          resolved = documentIdHint;
        } else if (documents[0]) {
          resolved = documents[0].id;
        } else {
          const created = await rpc.call('CreateDocument', {
            workspaceId,
            title: 'Untitled',
          });
          resolved = created.documentId;
        }
        if (!alive) return;
        if (resolved !== documentIdHint) replaceDocQuery(resolved);
        setDocumentId(resolved);
      } catch (err) {
        if (!alive) return;
        setError(err instanceof RpcClientError ? err.message : 'Failed to open document');
      }
    })();
    return () => {
      alive = false;
    };
  }, [user, documentIdHint]);

  // Tear down the collab socket before Logout so the server's session-kill
  // (ADR-0014) doesn't race a still-open provider and surface as a 4401 close.
  async function handleLogout(): Promise<void> {
    sessionRef.current?.destroy();
    sessionRef.current = null;
    await onLogout();
  }

  if (error) return <div className="loading">{error}</div>;
  if (!documentId) return <div className="loading">Opening document…</div>;

  return (
    <>
      <AppHeader documentId={documentId} onLogout={handleLogout} />
      <StorageBanner />
      <DocumentView documentId={documentId} sessionRef={sessionRef} />
    </>
  );
}

function AppHeader({
  documentId,
  onLogout,
}: {
  documentId: string;
  onLogout?: () => Promise<void>;
}): JSX.Element {
  const [busy, setBusy] = useState(false);

  async function handleLogout(): Promise<void> {
    if (!onLogout) return;
    setBusy(true);
    try {
      await onLogout();
    } finally {
      setBusy(false);
    }
  }

  return (
    <header className="app-header">
      <h1>Open-Outliner</h1>
      <span className="doc-id">{documentId}</span>
      {onLogout && (
        <button
          type="button"
          className="logout-btn"
          disabled={busy}
          onClick={() => void handleLogout()}
        >
          {busy ? 'Logging out…' : 'Log out'}
        </button>
      )}
    </header>
  );
}

function DocumentView({
  documentId,
  sessionRef,
}: {
  documentId: string;
  sessionRef?: { current: Session | null };
}): JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const s = createSession(documentId);
    setSession(s);
    if (sessionRef) sessionRef.current = s;
    setReady(false);
    let alive = true;
    void s.whenReady.then(() => {
      if (alive) setReady(true);
    });
    return () => {
      alive = false;
      if (sessionRef) sessionRef.current = null;
      s.destroy();
    };
  }, [documentId, sessionRef]);

  if (!session || !ready) return <div className="loading">Loading…</div>;
  return <Outliner doc={session.doc} actor={session.actor} rootId={session.rootId} />;
}
