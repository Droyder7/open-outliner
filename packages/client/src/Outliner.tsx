import { useCallback, useLayoutEffect, useReducer, useRef, useState } from 'react';
import type * as Y from 'yjs';
import {
  getChildren,
  getContentText,
  getContentYText,
  getIsCollapsed,
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
  setIsCollapsed,
  toggleCompleted,
  splitItem,
  ROOT_PARENT_SENTINEL,
  type Actor,
} from '@open-outliner/crdt';
import { RowText } from './RowText.js';
import { CARET_END, getCaretOffset, isCaretAtEnd, isCaretAtStart, setCaretOffset } from './caret.js';

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
}

interface PendingFocus {
  readonly id: string;
  readonly offset: number;
}

export function Outliner({ doc, actor, rootId }: OutlinerProps): JSX.Element {
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  const [zoomRoot, setZoomRoot] = useState<string>(rootId);
  const pendingFocus = useRef<PendingFocus | null>(null);
  const elements = useRef(new Map<string, HTMLElement>());

  // Re-render on any (local or remote) document change.
  useLayoutEffect(() => {
    const onChange = (): void => forceRender();
    doc.on('afterAllTransactions', onChange);
    return () => doc.off('afterAllTransactions', onChange);
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
    }
  });

  const isCollapsed = useCallback((id: string) => getIsCollapsed(doc, id), [doc]);

  // If the zoom target was deleted out from under us, fall back to the root.
  const effectiveZoom = getRootId(doc) && getParentId(doc, zoomRoot) ? zoomRoot : rootId;

  const handleKeyDown = useCallback(
    (id: string, e: React.KeyboardEvent<HTMLDivElement>): void => {
      const el = e.currentTarget;
      const mod = e.metaKey || e.ctrlKey;
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
        splitItem(doc, id, offset, newId, actor);
        requestFocus(newId, 0);
        return;
      }

      // --- Indent / outdent ---
      if (e.key === 'Tab') {
        e.preventDefault();
        if (e.shiftKey) outdent(doc, id, actor);
        else indent(doc, id, actor);
        requestFocus(id, offset);
        return;
      }

      // --- Move subtree among siblings ---
      if (mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        moveWithinSiblings(doc, id, e.key === 'ArrowUp' ? 'up' : 'down', actor);
        requestFocus(id, offset);
        return;
      }

      // --- Collapse / expand ---
      if (mod && e.key === '.') {
        e.preventDefault();
        if (hasChildren(doc, id)) setIsCollapsed(doc, id, !getIsCollapsed(doc, id));
        requestFocus(id, offset);
        return;
      }

      // --- Backspace at start: delete-if-empty else merge into previous visible ---
      if (e.key === 'Backspace' && !mod && isCaretAtStart(el)) {
        if (!prevId) return; // first visible item — no-op
        e.preventDefault();
        if (text.length === 0 && !hasChildren(doc, id)) {
          deleteItem(doc, id, actor);
          requestFocus(prevId, CARET_END);
        } else {
          const joinAt = getContentText(doc, prevId).length;
          mergeIntoPrevious(doc, id, prevId, actor);
          requestFocus(prevId, joinAt);
        }
        return;
      }

      // --- Delete at end: symmetric merge with next visible ---
      if (e.key === 'Delete' && !mod && isCaretAtEnd(el)) {
        if (!nextId) return;
        e.preventDefault();
        const joinAt = text.length;
        mergeIntoPrevious(doc, nextId, id, actor);
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

  const breadcrumb = buildBreadcrumb(doc, effectiveZoom, rootId);

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
      <ul className="tree" role="tree">
        {getChildren(doc, effectiveZoom).map((node) => (
          <Row
            key={node.id}
            doc={doc}
            id={node.id}
            depth={0}
            isCollapsed={isCollapsed}
            registerEl={registerEl}
            onKeyDown={handleKeyDown}
            onToggleCollapse={(cid) => setIsCollapsed(doc, cid, !getIsCollapsed(doc, cid))}
            onZoom={setZoomRoot}
          />
        ))}
      </ul>
    </div>
  );
}

interface RowProps {
  readonly doc: Y.Doc;
  readonly id: string;
  readonly depth: number;
  isCollapsed(id: string): boolean;
  registerEl(id: string, el: HTMLElement | null): void;
  onKeyDown(id: string, e: React.KeyboardEvent<HTMLDivElement>): void;
  onToggleCollapse(id: string): void;
  onZoom(id: string): void;
}

function Row({
  doc,
  id,
  depth,
  isCollapsed,
  registerEl,
  onKeyDown,
  onToggleCollapse,
  onZoom,
}: RowProps): JSX.Element {
  const text = getContentYText(doc, id);
  const children = getChildren(doc, id);
  const collapsed = isCollapsed(id);
  const completed = getIsCompleted(doc, id);
  const type = getItemType(doc, id);
  const expandable = children.length > 0;

  return (
    <li className="row-wrap" role="treeitem" aria-expanded={expandable ? !collapsed : undefined}>
      <div
        className={`row type-${type}${completed ? ' completed' : ''}`}
        style={{ paddingLeft: `${depth * 22}px` }}
      >
        <button
          className={`collapse ${expandable ? (collapsed ? 'collapsed' : 'expanded') : 'leaf'}`}
          onClick={() => expandable && onToggleCollapse(id)}
          aria-label={expandable ? (collapsed ? 'Expand' : 'Collapse') : undefined}
          tabIndex={-1}
        >
          {expandable ? '▸' : ''}
        </button>
        <button className="bullet" onClick={() => onZoom(id)} aria-label="Zoom in" tabIndex={-1}>
          •
        </button>
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
      </div>
      {expandable && !collapsed && (
        <ul className="tree" role="group">
          {children.map((child) => (
            <Row
              key={child.id}
              doc={doc}
              id={child.id}
              depth={depth + 1}
              isCollapsed={isCollapsed}
              registerEl={registerEl}
              onKeyDown={onKeyDown}
              onToggleCollapse={onToggleCollapse}
              onZoom={onZoom}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

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
