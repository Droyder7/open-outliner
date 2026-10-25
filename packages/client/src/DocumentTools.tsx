import { flushSync } from 'react-dom';
import { Icon } from './Icon.js';
import { applyTextEdit } from './RowText.js';
import { useEffect, useRef, useState, type ReactNode } from 'react';
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
  children,
}: {
  doc: Y.Doc;
  id: string;
  account: Account;
  onCreated: (id: string) => void;
  children: ReactNode;
}) {
  const [title, setTitle] = useState(String(doc.getMap('meta').get('title') ?? 'Untitled'));
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string>();
  const [note, setNote] = useState('');
  const [trash, setTrash] = useState<{ id: string; text: string }[]>([]);
  const [history, setHistory] = useState<Checkpoint[]>([]);
  const [panel, setPanel] = useState<'notes' | 'history' | 'options'>();
  const panelTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && panel) {
        setPanel(undefined);
        panelTrigger.current?.focus();
      }
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [panel]);
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
    <>
      <div className="document-heading">
        <span className="document-kicker">PERSONAL OUTLINE</span>
        <input
          className="document-title"
          aria-label="Document title"
          value={title}
          placeholder="Untitled"
          spellCheck={false}
          onChange={(event) => {
            setTitle(event.target.value);
            doc.getMap('meta').set('title', event.target.value);
          }}
        />
      </div>
      <div className="document-toolbar" role="group" aria-label="Document tools">
        <span className="current-view">
          <Icon name="outline" size={16} />
          Outline
        </span>
        <div className="toolbar-actions">
          {(
            [
              { key: 'notes', label: 'Notes', icon: 'note' },
              { key: 'history', label: 'History', icon: 'history' },
              { key: 'options', label: 'More', icon: 'more' },
            ] as const
          ).map((item) => (
            <button
              key={item.key}
              className={`toolbar-button ${panel === item.key ? 'active' : ''}`}
              aria-label={item.key === 'options' ? 'Document options' : item.label}
              aria-expanded={panel === item.key}
              aria-controls={`document-panel-${id}`}
              onClick={(event) => {
                panelTrigger.current = event.currentTarget;
                setPanel(panel === item.key ? undefined : item.key);
              }}
            >
              <Icon name={item.icon} size={16} />
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className={`editor-layout ${panel ? 'with-inspector' : ''}`}>
        <div className="editor-surface">{children}</div>
        {panel && (
          <aside
            className="inspector"
            id={`document-panel-${id}`}
            aria-label={
              panel === 'notes'
                ? 'Notes panel'
                : panel === 'history'
                  ? 'Recovery history'
                  : 'Document options'
            }
          >
            <div className="inspector-heading">
              <h2>
                {panel === 'notes'
                  ? 'Notes'
                  : panel === 'history'
                    ? 'Recovery history'
                    : 'Document options'}
              </h2>
              <button
                className="icon-button"
                aria-label="Close panel"
                onClick={() => {
                  setPanel(undefined);
                  panelTrigger.current?.focus();
                }}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
            {panel === 'notes' &&
              (selected ? (
                <>
                  <p className="selected-item-label">
                    {String(itemsMap(doc).get(selected)?.get('content') ?? '') || 'Untitled item'}
                  </p>
                  <label className="sr-only" htmlFor={`item-note-${id}`}>
                    Item note
                  </label>
                  <textarea
                    id={`item-note-${id}`}
                    className="item-note"
                    value={note}
                    placeholder="Add a little context…"
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
                  <p className="panel-hint">Notes stay with this item.</p>
                </>
              ) : (
                <p className="empty-panel">Select an outline item to add notes.</p>
              ))}
            {panel === 'history' && (
              <>
                <p className="panel-description">
                  Return to an earlier version without replacing your current work.
                </p>
                <button
                  className="panel-primary"
                  onClick={() =>
                    void checkpoint(doc, account.id, id, 'Manual checkpoint').catch(() =>
                      setError('Could not save checkpoint'),
                    )
                  }
                >
                  <Icon name="bookmark" size={15} />
                  Save checkpoint
                </button>
                <p className="panel-hint">
                  Saved on this device. Automatic checkpoints every five minutes while editing.
                </p>
                <div className="history-list">
                  {history.length === 0 && (
                    <p className="empty-panel">Your saved checkpoints will appear here.</p>
                  )}
                  {[...history].reverse().map((saved) => (
                    <div className="history-entry" key={saved.id}>
                      <Icon name="history" size={15} />
                      <div>
                        <strong>
                          {new Date(saved.createdAt).toLocaleString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                        </strong>
                        <span>{saved.reason}</span>
                        <button
                          className="text-button"
                          onClick={() =>
                            void recoverCheckpoint(saved.id, account)
                              .then(onCreated)
                              .catch((err) => setError(String(err)))
                          }
                        >
                          Recover as new document
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
            {panel === 'options' && (
              <>
                <span className="panel-section-label">TAKE YOUR IDEAS WITH YOU</span>
                <button
                  className="panel-action"
                  onClick={() =>
                    download(
                      'outline.json',
                      JSON.stringify(portableDocument(doc), null, 2),
                      'application/json',
                    )
                  }
                >
                  <Icon name="download" size={16} />
                  Export JSON
                </button>
                <button
                  className="panel-action"
                  onClick={() =>
                    download('outline.md', markdown(portableDocument(doc)), 'text/markdown')
                  }
                >
                  <Icon name="download" size={16} />
                  Export Markdown
                </button>
                <label className="panel-action import-action">
                  <Icon name="upload" size={16} />
                  Import JSON
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
                <p className="panel-hint">
                  JSON keeps your structure and notes. Imports open as a new outline.
                </p>
                <details className="trash-panel">
                  <summary>
                    <Icon name="trash" size={16} />
                    Trash ({trash.length})<Icon name="chevron" size={13} />
                  </summary>
                  {trash.length === 0 && <p className="empty-panel">Nothing in the trash.</p>}
                  {trash.map((item) => (
                    <div className="trash-entry" key={item.id}>
                      <span>{item.text}</span>
                      <button
                        className="text-button"
                        aria-label={`Restore ${item.text}`}
                        onClick={() =>
                          undeleteItem(doc, item.id, {
                            replicaId: 'restore',
                            now: () => Date.now(),
                          })
                        }
                      >
                        Restore
                      </button>
                    </div>
                  ))}
                </details>
              </>
            )}
          </aside>
        )}
      </div>
      <footer className="editor-footer">
        <span>
          <kbd>↵</kbd> New item
        </span>
        <span>
          <kbd>Tab</kbd> Indent
        </span>
        <span>
          <kbd>⇧ Tab</kbd> Outdent
        </span>
      </footer>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export function LibrarySearch({
  account,
  onReveal,
  onOpen,
}: {
  account: Account;
  onReveal: (documentId: string, itemId?: string) => void;
  onOpen: () => void;
}) {
  const [query, setQuery] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const search = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (document.querySelector('dialog[open]')) return;
        // Show the mobile library before moving focus into it.
        flushSync(onOpen);
        searchInput.current?.focus();
      }
    };
    document.addEventListener('keydown', search);
    return () => document.removeEventListener('keydown', search);
  }, [onOpen]);
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
    <section className="library-search" aria-label="Library search">
      <label className="search-field">
        <Icon name="search" size={16} />
        <span className="sr-only">Search library</span>
        <input
          ref={searchInput}
          aria-label="Search library"
          type="search"
          placeholder="Search your thoughts"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <kbd>{navigator.platform.includes('Mac') ? '⌘ K' : 'Ctrl K'}</kbd>
      </label>
      {query.trim() && (
        <div className="search-results">
          {results.length === 0 && <p className="empty-search">No matching thoughts.</p>}
          {results.map((result) => (
            <button
              className="search-result"
              key={result.key}
              onClick={() => {
                onReveal(result.documentId, result.itemId);
                setQuery('');
              }}
            >
              <Icon name="file" size={15} />
              <span>{result.text}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
