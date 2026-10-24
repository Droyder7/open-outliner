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
  const [login, setLogin] = useState(false);
  const [error, setError] = useState('');
  const [legacy, setLegacy] = useState(false);
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
    <main className="app">
      <header className="app-header">
        <h1>Open-Outliner</h1>
        <span>{account.id === 'local' ? 'On this device' : 'Personal library'}</span>
        {account.id === 'local' ? (
          <button onClick={() => setLogin(!login)}>Sign in</button>
        ) : (
          <>
            <button onClick={() => setLogin(!login)}>Reconnect</button>
            <button onClick={() => void signOut()}>Log out</button>
          </>
        )}
      </header>
      {login && (
        <section>
          <button onClick={() => setLogin(false)}>Close sign in</button>
          <AuthGate>{(user) => <SignedIn user={user} done={signIn} />}</AuthGate>
        </section>
      )}
      <StorageBanner />
      {legacy && (
        <p>
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
      {error && <p role="alert">{error}</p>}
      <nav aria-label="Documents">
        <select
          aria-label="Open document"
          value={current ?? ''}
          onChange={(e) => setCurrent(e.target.value)}
        >
          {documents.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}
            </option>
          ))}
        </select>
        <button
          onClick={() =>
            void newLocalDocument(account)
              .then(async (d) => {
                await load();
                setCurrent(d.id);
              })
              .catch(() => setError('Could not save a new document'))
          }
        >
          New document
        </button>
      </nav>
      {current && <Document key={`${account.id}:${current}`} id={current} account={account} />}
    </main>
  );
}
function Document({ id, account }: { id: string; account: Account }) {
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
    <section>
      <p role="status">
        {save}
        {save === 'Saved locally' && account.id === 'local'
          ? ' · Stored on this device; export for backup'
          : ''}
      </p>
      {ready && session ? (
        <Outliner
          doc={session.doc}
          actor={session.actor}
          rootId={session.rootId}
          presentationKey={`${account.id}:${id}`}
        />
      ) : (
        <p>Opening local document…</p>
      )}
    </section>
  );
}
