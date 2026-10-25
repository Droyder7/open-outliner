import { Icon } from './Icon.js';
import { useEffect } from 'react';
import { useMemo } from 'react';
import { createOutlineHistory } from '@open-outliner/crdt';
import { useCallback, useLayoutEffect, useReducer, useRef, useState } from 'react';
import * as Y from 'yjs';
import { memo } from 'react';
import {
  getChildren,
  itemsMap,
  insertItem,
  getRecoveredIds,
  visibleRows,
  getContentText,
  getContentYText,
  getIsCompleted,
  getItemType,
  getParentId,
  getRootId,
  hasChildren,
  flattenVisible,
  indent,
  outdent,
  moveWithinSiblings,
  deleteItem,
  mergeIntoPrevious,
  toggleCompleted,
  splitItem,
  ROOT_PARENT_SENTINEL,
  type Actor,
} from '@open-outliner/crdt';
import { RowText } from './RowText.js';
import {
  CARET_END,
  getCaretOffset,
  isCaretAtEnd,
  isCaretAtStart,
  setCaretOffset,
} from './caret.js';

/**
 * The outliner surface: renders the collapse-aware visible tree from the live
 * Y.Doc and maps the ADR-0017 Workflowy-parity keymap onto the shared structural
 * commands (@open-outliner/crdt). Every structural key is one atomic `move`
 * write; the editor never mutates parent/rank outside those commands.
 */

export interface OutlinerProps {
  readonly doc: Y.Doc;
  readonly actor: Actor;
  readonly rootId: string;
  readonly presentationKey?: string;
  readonly revealItem?: string | undefined;
}

interface PendingFocus {
  readonly id: string;
  readonly offset: number;
}

function OutlinerView({
  doc,
  actor,
  rootId,
  presentationKey = rootId,
  revealItem,
}: OutlinerProps): JSX.Element {
  const history = useMemo(() => createOutlineHistory(doc), [doc]);
  useEffect(() => () => history.stop(), [history]);
  const [revision, forceRender] = useReducer((n: number) => n + 1, 0);
  const [zoomRoot, setZoomRoot] = useState<string>(() => {
    try {
      return localStorage.getItem(`oo:zoom:${presentationKey}`) ?? rootId;
    } catch {
      return rootId;
    }
  });
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(`oo:collapse:${presentationKey}`) ?? '[]'));
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(`oo:zoom:${presentationKey}`, zoomRoot);
      localStorage.setItem(`oo:collapse:${presentationKey}`, JSON.stringify([...collapsedIds]));
    } catch {
      /* Editing remains available if view preferences cannot be persisted. */
    }
  }, [zoomRoot, collapsedIds, presentationKey]);
  const toggleCollapse = useCallback(
    (id: string) =>
      setCollapsedIds((old) => {
        const next = new Set(old);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  const pendingFocus = useRef<PendingFocus | null>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const viewport = useRef<HTMLDivElement>(null);
  const visibleIds = useRef<string[]>([]);
  const [scrollTop, setScrollTop] = useState(0);

  // Re-render on any (local or remote) document change.
  useLayoutEffect(() => {
    const onChange = (transaction: Y.Transaction): void => {
      if ([...transaction.changed.keys()].some((type) => !(type instanceof Y.Text))) forceRender();
    };
    doc.on('afterTransaction', onChange);
    return () => doc.off('afterTransaction', onChange);
  }, [doc]);

  const registerEl = useCallback((id: string, el: HTMLElement | null) => {
    if (el) elements.current.set(id, el);
    else elements.current.delete(id);
  }, []);

  const requestFocus = useCallback((id: string, offset: number) => {
    pendingFocus.current = { id, offset };
    forceRender();
  }, []);

  // Apply a requested caret placement after the tree has committed.
  useLayoutEffect(() => {
    const pf = pendingFocus.current;
    if (!pf) return;
    const el = elements.current.get(pf.id);
    if (el) {
      setCaretOffset(el, pf.offset === CARET_END ? (el.textContent?.length ?? 0) : pf.offset);
      pendingFocus.current = null;
    } else {
      const index = visibleIds.current.indexOf(pf.id);
      if (index >= 0 && viewport.current) {
        viewport.current.scrollTop = Math.max(0, index * 36 - 180);
        setScrollTop(viewport.current.scrollTop);
      }
    }
  });

  const isCollapsed = useCallback((id: string) => collapsedIds.has(id), [collapsedIds]);

  // If the zoom target was deleted out from under us, fall back to the root.
  const effectiveZoom = getRootId(doc) && getParentId(doc, zoomRoot) ? zoomRoot : rootId;

  const handleKeyDown = useCallback(
    (id: string, e: React.KeyboardEvent<HTMLDivElement>): void => {
      const el = e.currentTarget;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) history.redo();
        else history.undo();
        forceRender();
        const shown = flattenVisible(doc, effectiveZoom, isCollapsed);
        const target = shown.includes(id) ? id : shown[0];
        if (target) requestFocus(target, CARET_END);
        return;
      }
      const offset = getCaretOffset(el);
      const text = getContentText(doc, id);
      const visible = flattenVisible(doc, effectiveZoom, isCollapsed);
      const idx = visible.indexOf(id);
      const prevId = idx > 0 ? visible[idx - 1] : undefined;
      const nextId = idx >= 0 ? visible[idx + 1] : undefined;

      // --- Structural: split / complete ---
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (mod) {
          toggleCompleted(doc, id);
          requestFocus(id, offset);
          return;
        }
        const newId = crypto.randomUUID();
        doc.transact(() => splitItem(doc, id, offset, newId, actor), 'structure');
        requestFocus(newId, 0);
        return;
      }

      // --- Indent / outdent ---
      if (e.key === 'Tab') {
        e.preventDefault();
        if (e.shiftKey) doc.transact(() => outdent(doc, id, actor), 'structure');
        else doc.transact(() => indent(doc, id, actor), 'structure');
        requestFocus(id, offset);
        return;
      }

      // --- Move subtree among siblings ---
      if (mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        doc.transact(
          () => moveWithinSiblings(doc, id, e.key === 'ArrowUp' ? 'up' : 'down', actor),
          'structure',
        );
        requestFocus(id, offset);
        return;
      }

      // --- Collapse / expand ---
      if (mod && e.key === '.') {
        e.preventDefault();
        if (hasChildren(doc, id)) toggleCollapse(id);
        requestFocus(id, offset);
        return;
      }

      // --- Backspace at start: delete-if-empty else merge into previous visible ---
      if (e.key === 'Backspace' && !mod && isCaretAtStart(el)) {
        if (!prevId) return; // first visible item — no-op
        e.preventDefault();
        if (text.length === 0 && !hasChildren(doc, id)) {
          doc.transact(() => deleteItem(doc, id, actor), 'structure');
          requestFocus(prevId, CARET_END);
        } else {
          const joinAt = getContentText(doc, prevId).length;
          doc.transact(() => mergeIntoPrevious(doc, id, prevId, actor), 'structure');
          requestFocus(prevId, joinAt);
        }
        return;
      }

      // --- Delete at end: symmetric merge with next visible ---
      if (e.key === 'Delete' && !mod && isCaretAtEnd(el)) {
        if (!nextId) return;
        e.preventDefault();
        const joinAt = text.length;
        doc.transact(() => mergeIntoPrevious(doc, nextId, id, actor), 'structure');
        requestFocus(id, joinAt);
        return;
      }

      // --- Caret navigation across the flattened visible order ---
      if (e.key === 'ArrowUp' && prevId) {
        e.preventDefault();
        requestFocus(prevId, offset);
        return;
      }
      if (e.key === 'ArrowDown' && nextId) {
        e.preventDefault();
        requestFocus(nextId, offset);
        return;
      }
      if (e.key === 'ArrowLeft' && isCaretAtStart(el) && prevId) {
        e.preventDefault();
        requestFocus(prevId, CARET_END);
        return;
      }
      if (e.key === 'ArrowRight' && isCaretAtEnd(el) && nextId) {
        e.preventDefault();
        requestFocus(nextId, 0);
      }
    },
    [doc, actor, effectiveZoom, isCollapsed, requestFocus],
  );

  useEffect(() => {
    if (!revealItem || !itemsMap(doc).has(revealItem)) return;
    setZoomRoot(rootId);
    setCollapsedIds((old) => {
      const next = new Set(old);
      let parent = getParentId(doc, revealItem);
      const seen = new Set<string>();
      while (parent && parent !== ROOT_PARENT_SENTINEL && !seen.has(parent)) {
        seen.add(parent);
        next.delete(parent);
        parent = getParentId(doc, parent);
      }
      return next;
    });
    requestFocus(revealItem, 0);
  }, [revealItem, doc, rootId, requestFocus]);
  const breadcrumb = buildBreadcrumb(doc, effectiveZoom, rootId);
  const recovery = getRecoveredIds(doc);
  const rows = useMemo(
    () => visibleRows(doc, effectiveZoom, isCollapsed),
    [doc, effectiveZoom, isCollapsed, revision],
  );
  visibleIds.current = rows.map((row) => row.id);
  const start = Math.max(0, Math.floor(scrollTop / 36) - 8);
  const end = Math.min(rows.length, start + 32);

  return (
    <div className="outliner">
      {effectiveZoom !== rootId && (
        <nav className="breadcrumb" aria-label="Zoom breadcrumb">
          {breadcrumb.map((crumb, i) => (
            <span key={crumb.id}>
              <button className="crumb" onClick={() => setZoomRoot(crumb.id)}>
                {crumb.label}
              </button>
              {i < breadcrumb.length - 1 && <span className="crumb-sep">›</span>}
            </span>
          ))}
        </nav>
      )}
      {recovery.size > 0 && (
        <p role="note">Recovered branches are marked below. Move them to organize them.</p>
      )}
      <div
        className="outline-scroll"
        style={{ height: Math.min(Math.max(rows.length * 36, 72), 480) }}
        ref={viewport}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <ul
          className="tree virtual-tree"
          role="tree"
          style={{ height: Math.max(rows.length * 36, 36) }}
        >
          {rows.slice(start, end).map((node, index) => (
            <Row
              key={node.id}
              doc={doc}
              id={node.id}
              depth={node.depth}
              index={start + index}
              recovered={node.recovered}
              revision={revision}
              isCollapsed={isCollapsed}
              registerEl={registerEl}
              onKeyDown={handleKeyDown}
              onToggleCollapse={toggleCollapse}
              onZoom={setZoomRoot}
              onTrash={(cid) => doc.transact(() => deleteItem(doc, cid, actor), 'structure')}
            />
          ))}
        </ul>
      </div>
      <button
        className="add-item-button"
        onClick={() => {
          const id = crypto.randomUUID();
          doc.transact(
            () =>
              insertItem(
                doc,
                id,
                effectiveZoom,
                getChildren(doc, effectiveZoom).slice(-1)[0]?.id,
                actor,
              ),
            'structure',
          );
          requestFocus(id, 0);
        }}
      >
        <Icon name="plus" size={15} /> Add item
      </button>
    </div>
  );
}

export const Outliner = memo(OutlinerView);

interface RowProps {
  readonly doc: Y.Doc;
  readonly id: string;
  readonly depth: number;
  readonly index: number;
  readonly recovered: boolean;
  readonly revision: number;
  isCollapsed(id: string): boolean;
  registerEl(id: string, el: HTMLElement | null): void;
  onKeyDown(id: string, e: React.KeyboardEvent<HTMLDivElement>): void;
  onToggleCollapse(id: string): void;
  onZoom(id: string): void;
  onTrash(id: string): void;
}

const Row = memo(function Row({
  doc,
  id,
  depth,
  index,
  recovered,
  isCollapsed,
  registerEl,
  onKeyDown,
  onToggleCollapse,
  onZoom,
  onTrash,
}: RowProps): JSX.Element {
  const text = getContentYText(doc, id);
  const children = getChildren(doc, id);
  const collapsed = isCollapsed(id);
  const completed = getIsCompleted(doc, id);
  const type = getItemType(doc, id);
  const expandable = children.length > 0;

  return (
    <li
      className="row-wrap virtual-row"
      data-item-id={id}
      role="treeitem"
      aria-level={depth + 1}
      style={{ position: 'absolute', top: index * 36, left: 0, right: 0, height: 36 }}
      aria-expanded={expandable ? !collapsed : undefined}
    >
      <div
        className={`row type-${type}${completed ? ' completed' : ''}`}
        style={{ paddingLeft: `${Math.min(depth, 10) * 22}px` }}
      >
        <button
          className={`collapse ${expandable ? (collapsed ? 'collapsed' : 'expanded') : 'leaf'}`}
          onClick={() => expandable && onToggleCollapse(id)}
          aria-label={expandable ? (collapsed ? 'Expand' : 'Collapse') : undefined}
          tabIndex={-1}
        >
          {expandable ? <Icon name="chevron" size={12} /> : ''}
        </button>
        <button className="bullet" onClick={() => onZoom(id)} aria-label="Zoom in" tabIndex={-1}>
          •
        </button>
        {recovered && <span className="recovered-label">Recovered</span>}
        {text ? (
          <RowText
            id={id}
            text={text}
            placeholder={depth === 0 ? 'Type here…' : ''}
            registerEl={registerEl}
            onKeyDown={(e) => onKeyDown(id, e)}
          />
        ) : (
          <span className="row-text" />
        )}
        <button className="trash-action" aria-label="Move to trash" onClick={() => onTrash(id)}>
          <Icon name="trash" size={14} />
        </button>
      </div>
    </li>
  );
});

interface Crumb {
  readonly id: string;
  readonly label: string;
}

/** Ancestor chain from the document root down to (and including) the zoom target. */
function buildBreadcrumb(doc: Y.Doc, zoomRoot: string, rootId: string): Crumb[] {
  const chain: Crumb[] = [];
  let cur: string | undefined = zoomRoot;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const label = cur === rootId ? 'Home' : getContentText(doc, cur) || 'Untitled';
    chain.unshift({ id: cur, label });
    if (cur === rootId) break;
    const parent = getParentId(doc, cur);
    cur = parent && parent !== ROOT_PARENT_SENTINEL ? parent : rootId;
  }
  return chain;
}
