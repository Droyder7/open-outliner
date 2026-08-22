/**
 * Caret helpers for a single-line contentEditable row. Offsets are plain-text
 * character positions; the outliner's structural commands are caret-position
 * driven (Enter split, Backspace merge, boundary nav), so every keymap decision
 * reads/writes the caret through here.
 */

/** Character offset of the caret within `el`, or 0 if there is no selection in it. */
export function getCaretOffset(el: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return 0;
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

/** True iff the caret is collapsed at the very start of `el`. */
export function isCaretAtStart(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed) return false;
  return getCaretOffset(el) === 0;
}

/** True iff the caret is collapsed at the end of `el`. */
export function isCaretAtEnd(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed) return false;
  return getCaretOffset(el) === (el.textContent?.length ?? 0);
}

/** Place the caret at character `offset` in `el`, clamped to its text length. */
export function setCaretOffset(el: HTMLElement, offset: number): void {
  el.focus();
  const len = el.textContent?.length ?? 0;
  const off = Math.max(0, Math.min(offset, len));
  const range = document.createRange();
  const sel = window.getSelection();
  // The row's text may be split across several text nodes (browser splits or
  // merged content from structural edits), so resolve the offset by walking
  // them — setting it on `el.firstChild` can exceed that node's length.
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  let remaining = off;
  let target: Node | null = null;
  while (node) {
    const nodeLen = node.textContent?.length ?? 0;
    if (remaining <= nodeLen) {
      target = node;
      break;
    }
    remaining -= nodeLen;
    node = walker.nextNode();
  }
  if (target) {
    range.setStart(target, remaining);
  } else {
    range.setStart(el, 0);
  }
  range.collapse(true);
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** Sentinel offset meaning "place the caret at the end of the target row". */
export const CARET_END = Number.MAX_SAFE_INTEGER;
