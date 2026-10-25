import { applyTextEdit } from './RowText.js';
import { useEffect, useState } from 'react';
import * as Y from 'yjs';
import { liveQuery } from 'dexie';
import { itemsMap, readAllSnapshots, undeleteItem, undoDocument } from '@open-outliner/crdt';
import { library, type Account, type Checkpoint } from './offline/library.js';
import { checkpoint, download, importDocument, recoverCheckpoint } from './offline/recovery.js';
import { portableDocument, markdown, validatePortable } from './offline/portable.js';

export function DocumentTools({
  doc,
  id,
  account,
  onCreated,
}: {
  doc: Y.Doc;
  id: string;
  account: Account;
  onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState(String(doc.getMap('meta').get('title') ?? 'Untitled'));
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string>();
  const [note, setNote] = useState('');
  const [trash, setTrash] = useState<{ id: string; text: string }[]>([]);
  const [history, setHistory] = useState<Checkpoint[]>([]);
  useEffect(() => {
    const focus = (event: FocusEvent) => {
      const row = (event.target as HTMLElement)?.closest('[data-item-id]');
      const itemId = row?.getAttribute('data-item-id');
      if (itemId && itemsMap(doc).has(itemId)) setSelected(itemId);
    };
    document.addEventListener('focusin', focus);
    return () => document.removeEventListener('focusin', focus);
  }, [doc]);
  useEffect(() => {
    const update = () => {
      const text = selected ? itemsMap(doc).get(selected)?.get('note') : undefined;
      setNote(text instanceof Y.Text ? text.toString() : '');
    };
    update();
    doc.on('update', update);
    return () => doc.off('update', update);
  }, [doc, selected]);
  useEffect(() => {
    let changed = false;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      changed = true;
      clearTimeout(timer);
      timer = setTimeout(
        () => void index().catch(() => setError('Could not update local search')),
        300,
      );
    };
    const index = async () => {
      const snapshots = readAllSnapshots(doc);
      if (alive)
        setTrash(
          snapshots
            .filter((s) => s.deleted.isDeleted)
            .map((s) => ({ id: s.id, text: s.content || 'Untitled item' })),
        );
      const data = portableDocument(doc);
      const title = String(doc.getMap('meta').get('title') ?? 'Untitled');
      if (alive) setTitle(title);
      await library.transaction('rw', library.documents, library.search, async () => {
        await library.documents.update(id, { title });
        await library.search
          .where('documentId')
          .equals(id)
          .filter((row) => row.accountId === account.id)
          .delete();
        await library.search.bulkPut(
          data.items
            .filter((item) => item.parentId !== null)
            .map((item) => ({
              id: `${account.id}:${id}:${item.id}`,
              accountId: account.id,
              documentId: id,
              itemId: item.id,
              text: `${item.content}\n${item.note}`,
            })),
        );
      });
    };
    void library.documents.get(id).then((local) => {
      if (!doc.getMap('meta').has('title'))
        doc.getMap('meta').set('title', local?.title ?? 'Untitled');
    });
    doc.on('update', update);
    void index().catch(() => setError('Could not load local search'));
    const interval = setInterval(() => {
      if (changed) {
        changed = false;
        void checkpoint(doc, account.id, id, 'Five-minute checkpoint').catch(() =>
          setError('Could not save a recovery checkpoint'),
        );
      }
    }, 300000);
    const subscription = liveQuery(() =>
      library.checkpoints
        .where('[accountId+documentId]')
        .equals([account.id, id])
        .reverse()
        .sortBy('createdAt'),
    ).subscribe({ next: setHistory, error: () => setError('Could not read recovery history') });
    return () => {
      alive = false;
      void index().catch(() => {});
      doc.off('update', update);
      clearTimeout(timer);
      clearInterval(interval);
      subscription.unsubscribe();
    };
  }, [doc, id, account]);
  async function importFile(file: File) {
    if (file.size > 16 * 1024 * 1024) throw new Error('Import exceeds 16 MB');
    const data = validatePortable(JSON.parse(await file.text()));
    await checkpoint(doc, account.id, id, 'Before import');
    onCreated(await importDocument(data, account));
  }
  return (
    <section className="document-tools" aria-label="Document tools">
      <label>
        Document title{' '}
        <input
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            doc.getMap('meta').set('title', event.target.value);
          }}
        />
      </label>
      {selected && (
        <label>
          Item note{' '}
          <textarea
            value={note}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
                event.preventDefault();
                undoDocument(doc, event.shiftKey);
              }
            }}
            onChange={(event) => {
              const node = itemsMap(doc).get(selected);
              if (!node) return;
              let text = node.get('note');
              if (!(text instanceof Y.Text)) {
                text = new Y.Text();
                node.set('note', text);
              }
              applyTextEdit(text as Y.Text, event.target.value);
              setNote(event.target.value);
            }}
          />
        </label>
      )}
      <div className="tool-actions">
        <button
          onClick={() =>
            download(
              'outline.json',
              JSON.stringify(portableDocument(doc), null, 2),
              'application/json',
            )
          }
        >
          Export JSON
        </button>
        <button
          onClick={() => download('outline.md', markdown(portableDocument(doc)), 'text/markdown')}
        >
          Export Markdown
        </button>
        <label>
          Import JSON{' '}
          <input
            aria-label="Import JSON"
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importFile(file).catch((err) => setError(String(err)));
              event.target.value = '';
            }}
          />
        </label>
        <button
          onClick={() =>
            void checkpoint(doc, account.id, id, 'Manual checkpoint').catch(() =>
              setError('Could not save checkpoint'),
            )
          }
        >
          Save checkpoint
        </button>
      </div>
      <details>
        <summary>Trash ({trash.length})</summary>
        {trash.map((item) => (
          <p key={item.id}>
            {item.text}{' '}
            <button
              aria-label={`Restore ${item.text}`}
              onClick={() =>
                undeleteItem(doc, item.id, { replicaId: 'restore', now: () => Date.now() })
              }
            >
              Restore
            </button>
          </p>
        ))}
      </details>
      <details>
        <summary>Recovery history ({history.length})</summary>
        {history.map((saved) => (
          <p key={saved.id}>
            {new Date(saved.createdAt).toLocaleString()} · {saved.reason}{' '}
            <button
              onClick={() =>
                void recoverCheckpoint(saved.id, account)
                  .then(onCreated)
                  .catch((err) => setError(String(err)))
              }
            >
              Recover as new document
            </button>
          </p>
        ))}
      </details>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
export function LibrarySearch({
  account,
  onReveal,
}: {
  account: Account;
  onReveal: (documentId: string, itemId?: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<
    { key: string; documentId: string; itemId?: string; text: string }[]
  >([]);
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const needle = query.toLocaleLowerCase();
    const subscription = liveQuery(async () => {
      const docs = await library.documents
        .where('accountId')
        .equals(account.id)
        .filter((d) => d.schemaVersion === 2 && d.title.toLocaleLowerCase().includes(needle))
        .toArray();
      const items = await library.search
        .where('accountId')
        .equals(account.id)
        .filter((row) => row.text.toLocaleLowerCase().includes(needle))
        .limit(50)
        .toArray();
      return [
        ...docs.map((d) => ({ key: d.id, documentId: d.id, text: d.title })),
        ...items.map((i) => ({
          key: i.id,
          documentId: i.documentId,
          itemId: i.itemId,
          text: i.text.slice(0, 120),
        })),
      ].slice(0, 50);
    }).subscribe({ next: setResults });
    return () => subscription.unsubscribe();
  }, [account, query]);
  return (
    <section aria-label="Library search">
      <label>
        Search library{' '}
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      {results.map((result) => (
        <button
          className="search-result"
          key={result.key}
          onClick={() => {
            onReveal(result.documentId, result.itemId);
            setQuery('');
          }}
        >
          {result.text}
        </button>
      ))}
    </section>
  );
}
