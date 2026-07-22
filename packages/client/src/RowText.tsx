import { useCallback, useEffect, useRef } from 'react';
import * as Y from 'yjs';
import { getCaretOffset, setCaretOffset } from './caret.js';

/**
 * A single outline row's text: an uncontrolled contentEditable bound directly to
 * the item's content `Y.Text` (the pinned schema stores content as `Y.Text`, not
 * a ProseMirror fragment — ADR-0008). Local edits are applied as a minimal
 * prefix/suffix diff so concurrent character edits merge cleanly; remote/CRDT
 * changes are reflected back into the DOM with the caret preserved.
 */

export interface RowTextProps {
  readonly id: string;
  readonly text: Y.Text;
  readonly placeholder?: string;
  registerEl(id: string, el: HTMLElement | null): void;
  onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void;
}

/** Apply `next` to `ytext` as a single delete+insert over the changed middle. */
function applyTextEdit(ytext: Y.Text, next: string): void {
  const prev = ytext.toString();
  if (prev === next) return;

  let start = 0;
  const min = Math.min(prev.length, next.length);
  while (start < min && prev[start] === next[start]) start++;

  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
    endPrev--;
    endNext--;
  }

  const doc = ytext.doc;
  const mutate = (): void => {
    if (endPrev > start) ytext.delete(start, endPrev - start);
    if (endNext > start) ytext.insert(start, next.slice(start, endNext));
  };
  if (doc) Y.transact(doc, mutate);
  else mutate();
}

export function RowText({ id, text, placeholder, registerEl, onKeyDown }: RowTextProps): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);

  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      ref.current = el;
      registerEl(id, el);
    },
    [id, registerEl],
  );

  // Y.Text -> DOM. Runs on mount and on every (local or remote) text change,
  // restoring the caret when this row is the focused one.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const render = (): void => {
      const str = text.toString();
      if (el.textContent === str) return;
      const focused = document.activeElement === el;
      const caret = focused ? getCaretOffset(el) : null;
      el.textContent = str;
      if (caret !== null) setCaretOffset(el, caret);
    };
    render();
    text.observe(render);
    return () => text.unobserve(render);
  }, [text]);

  const onInput = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // Single-line content: strip any newlines the browser may have inserted.
    applyTextEdit(text, (el.textContent ?? '').replace(/\n/g, ''));
  }, [text]);

  return (
    <div
      ref={setRef}
      className="row-text"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      spellCheck
      data-placeholder={placeholder ?? ''}
      onInput={onInput}
      onKeyDown={onKeyDown}
    />
  );
}
