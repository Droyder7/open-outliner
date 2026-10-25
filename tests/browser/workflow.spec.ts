import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
test('capture, retrieve, trash, restore, export, import and checkpoint recovery', async ({
  page,
}) => {
  await page.goto('/');
  const rows = page.getByRole('tree').getByRole('textbox');
  await page.getByLabel('Document title', { exact: true }).fill('My thinking');
  await rows.first().fill('An idea worth keeping');
  await page.getByLabel('Item note', { exact: true }).fill('A supporting detail');
  await page.getByRole('button', { name: 'Save checkpoint', exact: true }).click();
  await page.getByLabel('Search library', { exact: true }).fill('supporting detail');
  await page.getByRole('button', { name: /An idea worth keeping.*A supporting detail/ }).click();
  await expect(rows.first()).toBeFocused();
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
  const original = await page.getByLabel('Open document').inputValue();
  await page.getByLabel('Import JSON', { exact: true }).setInputFiles({
    name: 'outline.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(data)),
  });
  await expect
    .poll(async () => ({
      options: await page.locator('select[aria-label="Open document"] option').count(),
      alerts: await page.getByRole('alert').allTextContents(),
    }))
    .toEqual({ options: 2, alerts: [] });
  await expect(page.getByLabel('Open document')).not.toHaveValue(original);
  await expect(rows.first()).toHaveText('An idea worth keeping');
  await page.getByLabel('Open document').selectOption(original);
  await page.getByText(/Recovery history \(/).click();
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
  const id = await page.getByLabel('Open document').inputValue();
  await page.getByLabel('Import JSON', { exact: true }).setInputFiles({
    name: 'bad.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"invalid":true}'),
  });
  await expect(page.getByRole('alert')).toContainText('Unsupported');
  await expect(page.getByLabel('Open document')).toHaveValue(id);
});
