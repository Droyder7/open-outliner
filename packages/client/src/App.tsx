import { useEffect, useMemo, useState } from 'react';
import { createSession, type Session } from './session.js';
import { Outliner } from './Outliner.js';

/**
 * App shell: opens one editing session (Y.Doc + local persistence + optional
 * sync) for the document named in `?doc=`, and renders the outliner once local
 * state has loaded. Offline-first — with no sync URL configured this is a fully
 * usable local outliner.
 */

const DEFAULT_DOC = 'demo-document';

function documentIdFromLocation(): string {
  return new URLSearchParams(window.location.search).get('doc') ?? DEFAULT_DOC;
}

export function App(): JSX.Element {
  const documentId = useMemo(documentIdFromLocation, []);
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

  return (
    <div className="app">
      <header className="app-header">
        <h1>Open-Outliner</h1>
        <span className="doc-id">{documentId}</span>
      </header>
      {session && ready ? (
        <Outliner doc={session.doc} actor={session.actor} rootId={session.rootId} />
      ) : (
        <div className="loading">Loading…</div>
      )}
    </div>
  );
}
