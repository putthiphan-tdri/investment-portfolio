import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const workerSource = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../manifest.webmanifest', import.meta.url), 'utf8'));

function worker(scope = 'https://example.com/funds/') {
  const handlers = {};
  const stores = new Map();
  const fetched = [];
  let claimed = false;
  let skipped = false;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async addAll(requests) { requests.forEach((request) => store.set(request.url, `cached:${request.url}`)); },
        async match(url) { return store.get(url); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  const context = vm.createContext({
    URL, Request, caches,
    fetch: async (request) => { fetched.push(request.url); return 'network'; },
    self: {
      registration: { scope },
      addEventListener: (name, handler) => { handlers[name] = handler; },
      clients: { claim: async () => { claimed = true; } },
      skipWaiting: () => { skipped = true; },
    },
  });
  vm.runInContext(workerSource, context);
  return {
    handlers, stores, fetched,
    get claimed() { return claimed; },
    get skipped() { return skipped; },
    async lifecycle(name) {
      let promise;
      handlers[name]({ waitUntil: (value) => { promise = value; } });
      await promise;
    },
    async request(url, { method = 'GET', mode = 'cors' } = {}) {
      let response;
      handlers.fetch({ request: { url, method, mode }, respondWith: (value) => { response = value; } });
      return response;
    },
  };
}

test('manifest uses portable standalone URLs and real icons of the declared size', () => {
  assert.equal(manifest.display, 'standalone');
  for (const field of ['id', 'start_url', 'scope']) assert.equal(manifest[field], './');
  assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192'));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512'));
  for (const icon of manifest.icons) {
    const data = readFileSync(new URL(`../${icon.src}`, import.meta.url));
    assert.equal(`${data.readUInt32BE(16)}x${data.readUInt32BE(20)}`, icon.sizes);
  }
});

test('complete shell is precached and reopens offline from a subdirectory with query parameters', async () => {
  const sw = worker();
  await sw.lifecycle('install');
  const urls = [...[...sw.stores.values()][0].keys()];
  for (const url of urls) {
    const path = new URL(url).pathname.replace('/funds/', '') || 'index.html';
    assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), `Missing shell file: ${path}`);
  }
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const linkedAssets = [...html.matchAll(/(?:src|href)="(\.\/[^\"]+)"/g)].map((match) => match[1]);
  linkedAssets.forEach((path) => assert.ok(urls.includes(new URL(path, 'https://example.com/funds/').href), `Not precached: ${path}`));
  for (const path of ['', '?source=dock', 'index.html?source=dock']) {
    assert.equal(await sw.request(`https://example.com/funds/${path}`, { mode: 'navigate' }), 'cached:https://example.com/funds/index.html');
  }
  const appURL = urls.find(url => new URL(url).pathname.endsWith('/app.js'));
  assert.equal(await sw.request(appURL), `cached:${appURL}`);
  assert.equal(sw.fetched.length, 0);
});

test('private data, cloud API, external resources and writes bypass the cache', async () => {
  const sw = worker();
  await sw.lifecycle('install');
  for (const url of [
    'https://example.com/api/portfolio',
    'https://example.com/funds/api/portfolio',
    'https://example.com/funds/my-portfolio.json',
    'https://fonts.googleapis.com/css2?family=Outfit',
    'https://example.com/other/',
  ]) assert.equal(await sw.request(url, { mode: 'navigate' }), undefined);
  assert.equal(await sw.request('https://example.com/funds/', { method: 'PUT' }), undefined);
});

test('activation only clears older caches for this scope and waits for explicit update consent', async () => {
  const sw = worker();
  await sw.lifecycle('install');
  assert.equal(sw.skipped, false);
  const prefix = `my-funds-shell-${encodeURIComponent('https://example.com/funds/')}-`;
  sw.stores.set(`${prefix}old`, new Map());
  sw.stores.set('another-app-cache', new Map());
  sw.stores.set(`my-funds-shell-${encodeURIComponent('https://example.com/other/')}-old`, new Map());
  await sw.lifecycle('activate');
  assert.equal(sw.stores.has(`${prefix}old`), false);
  assert.equal(sw.stores.size, 3);
  assert.equal(sw.claimed, true);
  sw.handlers.message({ data: { type: 'SKIP_WAITING' } });
  assert.equal(sw.skipped, true);
});
