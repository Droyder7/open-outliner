import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import * as Y from 'yjs';
import { writeMove, writeContent, readAllSnapshots } from '../../crdt/dist/index.js';
import { ROOT_PARENT_SENTINEL } from '../../shared/dist/index.js';
const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:8080';
const cookies = new Map();
let csrf = '';
async function rpc(method, params) {
  const response = await fetch(`${base}/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
      Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
    },
    body: JSON.stringify({ method, params, requestId: crypto.randomUUID() }),
  });
  for (const cookie of response.headers.getSetCookie()) {
    const [key, value] = cookie.split(';')[0].split('=');
    cookies.set(key, value);
  }
  const body = await response.json();
  if (!body.ok) throw new Error(`${method}: ${body.error?.message}`);
  if (body.result?.csrfToken) csrf = body.result.csrfToken;
  return body.result;
}
const email = `selfhost-${crypto.randomUUID()}@smoke.test`;
const password = crypto.randomUUID();
await rpc('Signup', { email, password });
const who = await rpc('WhoAmI', {});
const { documentId } = await rpc('CreateDocument', {
  workspaceId: who.workspaceIds[0],
  title: 'Restore drill',
});
const itemId = crypto.randomUUID();
const marker = `Recovered outline ${crypto.randomUUID()}`;
const doc = new Y.Doc();
doc.getMap('meta').set('schemaVersion', 2);
doc.getMap('meta').set('rootId', documentId);
doc.getMap('meta').set('title', 'Restore drill');
for (const [id, parentId, content] of [
  [documentId, ROOT_PARENT_SENTINEL, ''],
  [itemId, documentId, marker],
]) {
  writeMove(doc, id, {
    parentId,
    rank: 'a0',
    hlc: { wallMs: Date.now(), counter: 0, replicaId: 'smoke' },
  });
  writeContent(doc, id, content);
}
const params = {
  documentId,
  batchId: crypto.randomUUID(),
  schemaVersion: 2,
  update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'),
};
const first = await rpc('PersistDocumentUpdate', params);
const retry = await rpc('PersistDocumentUpdate', params);
assert.equal(first.revision, retry.revision);
let projected = false;
for (let i = 0; i < 150; i++) {
  const result = await rpc('GetItems', { documentId, depth: 2 });
  if (result.items.some((item) => item.id === itemId && item.content === marker)) {
    projected = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.ok(projected, 'Committed content must reach the relational projection');
await rpc('Logout', {});
await rpc('Login', { email, password });
const state = await rpc('GetDocumentState', { documentId, schemaVersion: 2 });
const reloaded = new Y.Doc();
Y.applyUpdate(reloaded, Buffer.from(state.update, 'base64'));
assert.ok(readAllSnapshots(reloaded).some((node) => node.id === itemId && node.content === marker));
assert.equal((await (await fetch(`${base}/health`)).json()).status, 'ok');
if (process.env.SMOKE_TEXT_ONLY !== 'false') {
  await assert.rejects(
    () => rpc('PresignUpload', { documentId, itemId, mime: 'text/plain', size: 1 }),
    /not configured/,
  );
}
const fixture = { documentId, itemId, marker, committedRevision: first.revision, verified: true };
if (process.env.SMOKE_FIXTURE_FILE)
  await writeFile(process.env.SMOKE_FIXTURE_FILE, JSON.stringify(fixture));
console.log(JSON.stringify(fixture));
doc.destroy();
reloaded.destroy();
