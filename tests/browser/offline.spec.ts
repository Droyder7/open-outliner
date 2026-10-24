import { test, expect } from '@playwright/test';
test('local capture survives a cold offline reload', async ({ page, context }) => {
  await page.goto('/');
  await page.getByRole('textbox').first().fill('A thought to keep offline');
  await expect(page.getByRole('status')).toContainText('Saved locally');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('textbox').first()).toHaveText('A thought to keep offline');
  await page.getByRole('textbox').first().fill('Developed without a network');
  await expect(page.getByRole('status')).toContainText('Saved locally');
  await page.reload();
  await expect(page.getByRole('textbox').first()).toHaveText('Developed without a network');
});

test('cached account opens offline while server authentication is unavailable', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await page.evaluate(() =>
    localStorage.setItem(
      'oo:personal-account',
      JSON.stringify({
        id: '11111111-1111-4111-8111-111111111111',
        workspaceId: '22222222-2222-4222-8222-222222222222',
      }),
    ),
  );
  await page.reload();
  await page.getByRole('textbox').first().fill('Cached account thought');
  await expect(page.getByRole('status')).toContainText(/Pending sync|Reconnect|Sync error/);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('textbox').first()).toHaveText('Cached account thought');
});

test('quota failure never becomes a successful save claim', async ({ page }) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'pending') throw new DOMException('Storage full', 'QuotaExceededError');
      return put.apply(this, args);
    };
  });
  await page.goto('/');
  await page.getByRole('textbox').first().fill('Work with failed persistence');
  await expect(page.getByRole('status')).toContainText('Storage error');
});

test('offline account updates survive reload and get a committed receipt on reconnect', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: "Don't have an account? Sign up" }).click();
  await page.getByLabel('Email').fill(`browser-${Date.now()}@offline.test`);
  await page.getByLabel('Password').fill('hunter2hunter2');
  await page.getByRole('button', { name: 'Sign up', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Log out', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Saved on server');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.getByRole('textbox').first().fill('Durable offline edit');
  await expect(page.getByRole('status')).toContainText('Pending sync');
  await page.reload();
  await expect(page.getByRole('textbox').first()).toHaveText('Durable offline edit');
  await context.setOffline(false);
  await expect(page.getByRole('status')).toContainText('Saved on server', { timeout: 15000 });
  await page.reload();
  await expect(page.getByRole('textbox').first()).toHaveText('Durable offline edit');
});

test('a different authenticated account never receives cached pending work', async ({ page }) => {
  let uploads = 0;
  await page.route('**/rpc', async (route) => {
    const body = route.request().postDataJSON();
    if (body.method === 'PersistDocumentUpdate') uploads++;
    if (body.method === 'WhoAmI')
      return route.fulfill({
        json: { ok: true, result: { userId: 'other-account', workspaceIds: [] } },
      });
    return route.abort();
  });
  await page.goto('/');
  await page.evaluate(() =>
    localStorage.setItem('oo:personal-account', JSON.stringify({ id: 'cached-account' })),
  );
  await page.reload();
  await page.getByRole('textbox').first().fill('Do not send to another account');
  await expect(page.getByRole('status')).toContainText('Reconnect to sync');
  expect(uploads).toBe(0);
});

test('structural undo and redo keep the original text recoverable', async ({ page }) => {
  await page.goto('/');
  const row = page.getByRole('textbox').first();
  await row.fill('A recoverable idea');
  await row.press('End');
  await row.press('Enter');
  await expect(page.getByRole('textbox')).toHaveCount(2);
  await page.keyboard.press('Control+z');
  await expect(page.getByRole('textbox')).toHaveCount(1);
  await expect(page.getByRole('textbox').first()).toHaveText('A recoverable idea');
  await page.keyboard.press('Control+Shift+z');
  await expect(page.getByRole('textbox')).toHaveCount(2);
});
