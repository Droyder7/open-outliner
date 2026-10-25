import { test, expect } from '@playwright/test';
import * as Y from '../../packages/client/node_modules/yjs';
import {
  writeMove,
  writeContent,
  deleteItem,
  getChildren,
} from '../../packages/crdt/dist/index.js';
import { ROOT_PARENT_SENTINEL, rankAfter } from '../../packages/shared/dist/index.js';
import { randomUUID } from 'node:crypto';

test.use({ serviceWorkers: 'block' });

async function populate(page: import('@playwright/test').Page, count: number, deep = false) {
  await page.goto('/');
  await expect(page.getByRole('tree').getByRole('textbox').first()).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Saved locally');
  const id = (await page
    .locator('[data-document-id][aria-current="page"]')
    .getAttribute('data-document-id'))!;
  const prior = await page.evaluate(
    async (id) =>
      new Promise<number[][]>((resolve, reject) => {
        const open = indexedDB.open(`oo:personal:v2:local:${id}`);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('updates', 'readonly');
          const request = tx.objectStore('updates').getAll();
          request.onsuccess = () => {
            resolve(request.result.map((bytes) => Array.from(bytes)));
            db.close();
          };
        };
      }),
    id,
  );
  const pending = await page.evaluate(
    async (id) =>
      new Promise<number[][]>((resolve, reject) => {
        const open = indexedDB.open('oo-personal');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction('pending', 'readonly').objectStore('pending').getAll();
          request.onsuccess = () => {
            resolve(
              request.result
                .filter((u) => u.documentId === id && u.accountId === 'local')
                .map((u) => Array.from(u.bytes)),
            );
            db.close();
          };
        };
      }),
    id,
  );
  prior.push(...pending);
  // Stop the live provider before seeding its database; its compaction must not
  // race an out-of-band fixture write.
  await page.route('**/fixture.html', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body>Fixture preparation</body></html>',
    }),
  );
  await page.goto('/fixture.html');
  const doc = new Y.Doc();
  for (const update of prior) Y.applyUpdate(doc, new Uint8Array(update));
  for (const child of getChildren(doc, id))
    deleteItem(doc, child.id, { replicaId: 'fixture', now: () => 1 });
  let lastRank: string | null = null;
  doc.getMap('meta').set('schemaVersion', 2);
  doc.getMap('meta').set('rootId', id);
  writeMove(doc, id, {
    parentId: ROOT_PARENT_SENTINEL,
    rank: 'a0',
    hlc: { wallMs: 1, counter: 0, replicaId: 'perf' },
  });
  let parent = id;
  Y.transact(doc, () => {
    for (let i = 0; i < count; i++) {
      const item = randomUUID();
      writeMove(doc, item, {
        parentId: deep ? parent : id,
        rank: (lastRank = rankAfter(lastRank, item)),
        hlc: { wallMs: 1, counter: i, replicaId: 'perf' },
      });
      writeContent(doc, item, `Item ${i}`);
      if (deep) parent = item;
    }
  });
  const bytes = [...Y.encodeStateAsUpdate(doc)];
  doc.destroy();
  await page.evaluate(
    async ({ id, bytes }) => {
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(`oo:personal:v2:local:${id}`);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('updates', 'readwrite');
          tx.objectStore('updates').add(new Uint8Array(bytes));
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      });
    },
    { id, bytes },
  );
  await page.goto('/');
  await expect(page.getByRole('tree').getByRole('textbox').first()).toHaveText('Item 0');
  return id;
}
async function measure(page: import('@playwright/test').Page, key: string, ctrl = false) {
  return page.evaluate(
    async ({ key, ctrl }) => {
      const el = document.activeElement!;
      const start = performance.now();
      el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ctrlKey: ctrl }));
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      return performance.now() - start;
    },
    { key, ctrl },
  );
}
function p95(values: number[]) {
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;
}

test('10k outline meets browser interaction budgets with bounded DOM', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await populate(page, 10000);
  expect(await page.getByRole('treeitem').count()).toBeLessThanOrEqual(32);
  const row = page.getByRole('tree').getByRole('textbox').first();
  await row.focus();
  const typing: number[] = [];
  const navigation: number[] = [];
  const moves: number[] = [];
  const zoom: number[] = [];
  for (let i = 0; i < 20; i++) {
    typing.push(
      await page.evaluate(async () => {
        const el = document.activeElement as HTMLElement;
        const start = performance.now();
        el.textContent = (el.textContent ?? '') + 'x';
        el.dispatchEvent(
          new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'x' }),
        );
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        return performance.now() - start;
      }),
    );
    navigation.push(await measure(page, 'ArrowDown'));
  }
  for (let i = 0; i < 20; i++) moves.push(await measure(page, 'ArrowDown', true));
  for (let i = 0; i < 20; i++) {
    const bullet = page.getByRole('button', { name: 'Zoom in', exact: true }).first();
    zoom.push(
      await bullet.evaluate(async (el) => {
        const start = performance.now();
        (el as HTMLElement).click();
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        return performance.now() - start;
      }),
    );
    await page.getByRole('button', { name: 'Home', exact: true }).click();
  }
  console.log(
    JSON.stringify({
      typingP95: p95(typing),
      navigationP95: p95(navigation),
      moveP95: p95(moves),
      zoomP95: p95(zoom),
    }),
  );
  expect(errors).toEqual([]);
  expect(p95(typing)).toBeLessThan(50);
  expect(p95(navigation)).toBeLessThan(50);
  expect(p95(moves)).toBeLessThan(100);
  expect(p95(zoom)).toBeLessThan(100);
});

test('a 1000-level outline opens and scrolls without recursive rendering', async ({ page }) => {
  await populate(page, 1000, true);
  await page.locator('.outline-scroll').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.getByText('Item 999', { exact: true })).toBeVisible();
  expect(await page.getByRole('treeitem').count()).toBeLessThanOrEqual(32);
});
