import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
test('capture, retrieve, trash, restore, export, import and checkpoint recovery', async ({
  page,
}) => {
  await page.goto('/');
  const rows = page.getByRole('tree').getByRole('textbox');
  await page.getByLabel('Document title', { exact: true }).fill('My thinking');
  await rows.first().fill('An idea worth keeping');
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await page.getByLabel('Item note', { exact: true }).fill('A supporting detail');
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByRole('button', { name: 'Save checkpoint', exact: true }).click();
  await page.getByLabel('Search library', { exact: true }).fill('supporting detail');
  await page.getByRole('button', { name: /An idea worth keeping.*A supporting detail/ }).click();
  await expect(rows.first()).toBeFocused();
  await page.getByRole('button', { name: 'Document options', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const downloaded = await downloadPromise;
  const data = JSON.parse(await readFile((await downloaded.path())!, 'utf8'));
  expect(data.title).toBe('My thinking');
  expect(
    data.items.filter((item: { parentId: string | null }) => item.parentId === null),
  ).toHaveLength(1);
  expect(data.items.some((i: { note: string }) => i.note === 'A supporting detail')).toBe(true);
  await page.getByRole('button', { name: 'Move to trash', exact: true }).first().click();
  await page.getByText(/Trash \(1\)/).click();
  await page.getByRole('button', { name: 'Restore An idea worth keeping', exact: true }).click();
  await expect(rows.first()).toHaveText('An idea worth keeping');
  const original = (await page
    .locator('[data-document-id][aria-current="page"]')
    .getAttribute('data-document-id'))!;
  await page.getByLabel('Import JSON', { exact: true }).setInputFiles({
    name: 'outline.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(data)),
  });
  await expect
    .poll(async () => ({
      options: await page.locator('[data-document-id]').count(),
      alerts: await page.getByRole('alert').allTextContents(),
    }))
    .toEqual({ options: 2, alerts: [] });
  await expect(page.locator('[data-document-id][aria-current="page"]')).not.toHaveAttribute(
    'data-document-id',
    original,
  );
  await expect(rows.first()).toHaveText('An idea worth keeping');
  await page.locator(`[data-document-id="${original}"]`).click();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByRole('button', { name: 'Recover as new document', exact: true }).first().click();
  await expect(page.getByLabel('Document title', { exact: true })).toHaveValue(
    'Recovered My thinking',
  );
  await expect(rows.first()).toHaveText('An idea worth keeping');
});

test('search reveals a hidden nested item and invalid import leaves the library unchanged', async ({
  page,
}) => {
  await page.goto('/');
  const rows = page.getByRole('tree').getByRole('textbox');
  await rows.first().fill('Parent');
  await rows.first().press('End');
  await rows.first().press('Enter');
  await rows.nth(1).fill('Hidden needle');
  await rows.nth(1).press('Tab');
  await page.getByRole('button', { name: 'Collapse', exact: true }).click();
  await expect(rows).toHaveCount(1);
  await page.getByLabel('Search library', { exact: true }).fill('Hidden needle');
  await page.getByRole('button', { name: 'Hidden needle', exact: true }).click();
  await expect(rows).toHaveCount(2);
  const id = (await page
    .locator('[data-document-id][aria-current="page"]')
    .getAttribute('data-document-id'))!;
  await page.getByRole('button', { name: 'Document options', exact: true }).click();
  await page.getByLabel('Import JSON', { exact: true }).setInputFiles({
    name: 'bad.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"invalid":true}'),
  });
  await expect(page.getByRole('alert')).toContainText('Unsupported');
  await expect(page.locator('[data-document-id][aria-current="page"]')).toHaveAttribute(
    'data-document-id',
    id,
  );
});

test('compact library, search, notes and sign-in remain usable on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const row = page.getByRole('tree').getByRole('textbox').first();
  await page.getByLabel('Document title', { exact: true }).fill('Pocket notes');
  await row.fill('A thought on the go');
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await page.getByLabel('Item note', { exact: true }).fill('Keep this context');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Notes', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await page.keyboard.press('Control+k');
  await expect(page.getByLabel('Search library', { exact: true })).toBeFocused();
  await page.getByLabel('Search library', { exact: true }).fill('A thought on the go');
  await page.getByRole('button', { name: /A thought on the go.*Keep this context/ }).click();
  await expect(row).toBeFocused();
  await expect(page.getByRole('button', { name: 'Open library', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await page.getByRole('button', { name: 'Open library', exact: true }).click();
  await page.getByRole('button', { name: 'New document', exact: true }).click();
  await expect(page.getByLabel('Document title', { exact: true })).toHaveValue('Untitled');
  await page.getByRole('button', { name: 'Open library', exact: true }).click();
  await page.getByRole('button', { name: 'Open Pocket notes', exact: true }).click();
  await expect(row).toHaveText('A thought on the go');
  await page.getByRole('button', { name: 'Open library', exact: true }).click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
