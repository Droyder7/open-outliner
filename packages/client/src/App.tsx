import { Icon } from './Icon.js';
import { checkpoint } from './offline/recovery.js';
import { itemsMap } from '@open-outliner/crdt';
import { DocumentTools, LibrarySearch } from './DocumentTools.js';
import { liveQuery } from 'dexie';
import { exportPreviousLibrary } from './offline/legacy-export.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createSession, type Session } from './session.js';
import { Outliner } from './Outliner.js';
import { AuthGate, type AuthedUser } from './auth/AuthGate.js';
import { StorageBanner } from './offline/StorageBanner.js';
import { detectStorageAvailability } from './offline/storage-status.js';
import {
  library,
  newLocalDocument,
  rememberedAccount,
  rememberAccount,
  type Account,
  type LocalDocument,
} from './offline/library.js';
import { synchronizeDocument, type SaveState } from './offline/document-sync.js';
import { createRpcClient } from './rpc.js';

function SignedIn({ user, done }: { user: AuthedUser; done: (account: Account) => void }) {
  useEffect(
    () =>
      done({
        id: user.userId,
        ...(user.workspaceIds[0] ? { workspaceId: user.workspaceIds[0] } : {}),
      }),
    [user, done],
  );
  return <p>Opening your library…</p>;
}
export function App(): JSX.Element {
  const [account, setAccount] = useState<Account>(rememberedAccount);
  const [documents, setDocuments] = useState<LocalDocument[]>([]);
  const [current, setCurrent] = useState<string>();
  const [reveal, setReveal] = useState<string>();
  const [login, setLogin] = useState(false);
  const [error, setError] = useState('');
  const [legacy, setLegacy] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const signInDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (login) signInDialog.current?.showModal();
    else signInDialog.current?.close();
  }, [login]);
  const load = useCallback(async () => {
    const docs = await library.documents
      .where('accountId')
      .equals(account.id)
      .reverse()
      .sortBy('modifiedAt');
    setLegacy(docs.some((d) => d.schemaVersion !== 2));
    const currentDocs = docs.filter((d) => d.schemaVersion === 2);
    docs.splice(0, docs.length, ...currentDocs);
    if (!docs.length) docs.push(await newLocalDocument(account));
    setDocuments(docs);
    setCurrent((old) => (docs.some((d) => d.id === old) ? old : docs[0]!.id));
  }, [account]);
  useEffect(() => {
    void detectStorageAvailability();
    void load().catch(() =>
      setError('Local storage is unavailable. Export any open work before closing.'),
    );
  }, [load]);
  useEffect(() => {
    if (account.id === 'local') return;
    let alive = true;
    void (async () => {
      const rpc = createRpcClient();
      const who = await rpc.call('WhoAmI', {});
      if (!alive || who.userId !== account.id) return;
      for (const workspaceId of who.workspaceIds) {
        const result = await rpc.call('ListDocuments', { workspaceId });
        if (!alive) return;
        for (const remote of result.documents) {
          const cached = await library.documents.get(remote.id);
          if (!cached)
            await library.documents.put({
              id: remote.id,
              accountId: account.id,
              title: remote.title,
              registered: true,
              schemaVersion: 2,
              workspaceId,
              modifiedAt: Date.now(),
            });
        }
      }
      if (alive) await load();
    })().catch(() => {}); // Cached library remains usable when the server is unavailable.
    return () => {
      alive = false;
    };
  }, [account, load]);
  useEffect(() => {
    const subscription = liveQuery(() =>
      library.documents
        .where('accountId')
        .equals(account.id)
        .filter((d) => d.schemaVersion === 2)
        .reverse()
        .sortBy('modifiedAt'),
    ).subscribe({
      next: (docs) => {
        if (docs.length) setDocuments(docs);
      },
    });
    return () => subscription.unsubscribe();
  }, [account]);
  const created = useCallback(
    (id: string) => {
      void load().then(() => setCurrent(id));
    },
    [load],
  );
  const signIn = useCallback((next: Account) => {
    setCurrent(undefined);
    setDocuments([]);
    rememberAccount(next);
    setAccount(next);
    setLogin(false);
  }, []);
  async function signOut() {
    try {
      await createRpcClient().call('Logout', {});
    } finally {
      signIn({ id: 'local' });
    }
  }
  return (
    <div className="app-shell" data-sidebar-open={sidebarOpen}>
      <button
        className="mobile-library-toggle icon-button"
        aria-label="Open library"
        aria-expanded={sidebarOpen}
        onClick={() => setSidebarOpen(true)}
      >
        <Icon name="panel" />
      </button>
      {sidebarOpen && (
        <button
          className="sidebar-scrim"
          aria-label="Close library"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside className="sidebar" aria-label="Your library">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="outline" size={21} />
          </span>
          <h1>Open-Outliner</h1>
          <button
            className="mobile-sidebar-close icon-button"
            aria-label="Close library"
            onClick={() => setSidebarOpen(false)}
          >
            <Icon name="close" />
          </button>
        </div>
        <LibrarySearch
          onOpen={() => setSidebarOpen(true)}
          account={account}
          onReveal={(documentId, itemId) => {
            setReveal(itemId);
            setCurrent(documentId);
            setSidebarOpen(false);
          }}
        />
        <nav className="library-nav" aria-label="Documents">
          <div className="nav-section-heading">
            <span>YOUR OUTLINES</span>
            <button
              className="icon-button"
              aria-label="New document"
              title="New document"
              onClick={() =>
                void newLocalDocument(account)
                  .then(async (d) => {
                    await load();
                    setCurrent(d.id);
                    setSidebarOpen(false);
                  })
                  .catch(() => setError('Could not save a new document'))
              }
            >
              <Icon name="plus" size={17} />
            </button>
          </div>
          <div className="document-list">
            {documents.map((d) => (
              <button
                key={d.id}
                className="document-link"
                aria-label={`Open ${d.title || 'Untitled'}`}
                aria-current={current === d.id ? 'page' : undefined}
                data-document-id={d.id}
                onClick={() => {
                  setCurrent(d.id);
                  setReveal(undefined);
                  setSidebarOpen(false);
                }}
              >
                <Icon name="file" size={17} />
                <span>{d.title || 'Untitled'}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className="sidebar-footer">
          <div className="workspace-identity">
            <span className="workspace-avatar">
              <Icon name={account.id === 'local' ? 'device' : 'outline'} size={18} />
            </span>
            <div>
              <strong>{account.id === 'local' ? 'Local workspace' : 'Personal library'}</strong>
              <span>{account.id === 'local' ? 'On this device' : 'Connected to your account'}</span>
            </div>
          </div>
          {account.id === 'local' ? (
            <button className="signin-button" onClick={() => setLogin(true)}>
              Sign in <Icon name="arrow" size={16} />
            </button>
          ) : (
            <div className="account-actions">
              <button onClick={() => setLogin(true)}>Reconnect</button>
              <button onClick={() => void signOut()}>Log out</button>
            </div>
          )}
          <p className="sidebar-footnote">
            {account.id === 'local'
              ? 'Export your outlines to keep a backup.'
              : 'Your edits sync when connected.'}
          </p>
        </div>
      </aside>
      <main className="main-workspace">
        <div className="workspace-notices">
          <StorageBanner />
          {legacy && (
            <p className="notice">
              Older local documents are preserved.{' '}
              <button
                onClick={() =>
                  void exportPreviousLibrary(account.id).catch(() =>
                    setError('Could not export the previous library'),
                  )
                }
              >
                Export previous library
              </button>
            </p>
          )}
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
        </div>
        {current && (
          <Document
            key={`${account.id}:${current}`}
            id={current}
            account={account}
            onCreated={created}
            reveal={reveal}
          />
        )}
      </main>
      <dialog
        ref={signInDialog}
        className="signin-dialog"
        aria-label="Sign in to your library"
        onCancel={(event) => {
          event.preventDefault();
          setLogin(false);
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) setLogin(false);
        }}
      >
        <div className="dialog-content">
          <button
            className="dialog-close icon-button"
            aria-label="Close sign in"
            onClick={() => setLogin(false)}
          >
            <Icon name="close" />
          </button>
          <div className="dialog-brand">
            <Icon name="outline" size={25} />
          </div>
          {login && <AuthGate>{(user) => <SignedIn user={user} done={signIn} />}</AuthGate>}
        </div>
      </dialog>
    </div>
  );
}
function Document({
  id,
  account,
  onCreated,
  reveal,
}: {
  id: string;
  account: Account;
  onCreated: (id: string) => void;
  reveal: string | undefined;
}) {
  const [session, setSession] = useState<Session>();
  const [ready, setReady] = useState(false);
  const [save, setSave] = useState<SaveState>('Saved locally');
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    const s = createSession(id, {
      accountId: account.id,
      realtime: false,
      beforeSeed: async () => {
        await sync?.restore();
        if (itemsMap(s.doc).size && s.doc.getMap('meta').get('schemaVersion') !== 2)
          await checkpoint(s.doc, account.id, id, 'Before schema upgrade');
      },
    });
    const sync = synchronizeDocument(s.doc, id, account, (state) => {
      if (active.current) setSave(state);
    });
    setSession(s);
    void s.whenReady
      .then(() => {
        if (active.current) {
          setReady(true);
          sync?.capture();
          void sync?.flush();
        }
      })
      .catch(() => setSave('Storage error'));
    return () => {
      active.current = false;
      sync?.stop();
      s.destroy();
    };
  }, [id, account]);
  return (
    <section className="document-workspace">
      <header className="workspace-topbar">
        <div className="workspace-breadcrumb">
          <Icon name="outline" size={16} />
          <span>My workspace</span>
          <span className="breadcrumb-divider">/</span>
          <strong>Outline</strong>
        </div>
        <p
          className={`save-status ${save.includes('error') ? 'save-error' : ''}`}
          role="status"
          title={
            account.id === 'local'
              ? 'Stored on this device. Export your outlines for a backup.'
              : 'Changes sync when you are connected.'
          }
        >
          <span className="status-dot" />
          {save}
        </p>
      </header>
      <div className="document-canvas">
        {ready && session ? (
          <DocumentTools doc={session.doc} id={id} account={account} onCreated={onCreated}>
            <Outliner
              doc={session.doc}
              actor={session.actor}
              rootId={session.rootId}
              revealItem={reveal}
              presentationKey={`${account.id}:${id}`}
            />
          </DocumentTools>
        ) : (
          <p className="loading">Opening your outline…</p>
        )}
      </div>
    </section>
  );
}
