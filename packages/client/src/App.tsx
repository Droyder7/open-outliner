import { useEffect, useMemo, useState } from 'react';
import { createSession, type Session } from './session.js';
import { Outliner } from './Outliner.js';
import { AuthGate } from './auth/AuthGate.js';

/**
 * App shell: opens one editing session (Y.Doc + local persistence + optional
 * sync) for the document named in `?doc=`, and renders the outliner once local
 * state has loaded. Offline-first — with no sync URL configured this is a fully
 * usable local outliner with no account. When a sync URL IS configured, the
 * Hocuspocus server requires an authenticated session (Phase 5/SEC), so the
 * outliner renders behind `AuthGate`.
 */

const DEFAULT_DOC = 'demo-document';

function documentIdFromLocation(): string {
  return new URLSearchParams(window.location.search).get('doc') ?? DEFAULT_DOC;
}

export function App(): JSX.Element {
  const documentId = useMemo(documentIdFromLocation, []);
  const syncConfigured = Boolean(import.meta.env.VITE_SYNC_URL);

  const body = syncConfigured ? (
    <AuthGate>{() => <DocumentView documentId={documentId} />}</AuthGate>
  ) : (
    <DocumentView documentId={documentId} />
  );

  return (
    <div className="app">
      <header className="app-header">
        <h1>Open-Outliner</h1>
        <span className="doc-id">{documentId}</span>
      </header>
      {body}
    </div>
  );
}

function DocumentView({ documentId }: { documentId: string }): JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const s = createSession(documentId);
    setSession(s);
    setReady(false);
    let alive = true;
    void s.whenReady.then(() => {
      if (alive) setReady(true);
    });
    return () => {
      alive = false;
      s.destroy();
    };
  }, [documentId]);

  if (!session || !ready) return <div className="loading">Loading…</div>;
  return <Outliner doc={session.doc} actor={session.actor} rootId={session.rootId} />;
}

