import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../pwa.js', import.meta.url), 'utf8');

function eventTarget(extra = {}) {
  const listeners = {};
  return {
    ...extra,
    addEventListener(name, handler) { (listeners[name] ||= []).push(handler); },
    async emit(name) { await Promise.all((listeners[name] || []).map(handler => handler({}))); },
  };
}

function worker(version, state = 'installed') {
  return eventTarget({
    state, messages: [],
    postMessage(message, ports) {
      this.messages.push(message.type);
      if (message.type === 'GET_VERSION' && version) ports[0].reply({ version });
    },
  });
}

async function app({ waiting = null, controller = worker('current', 'activated') } = {}) {
  const elements = new Map();
  for (const id of ['installAppButton', 'installDialog', 'nativeInstallButton', 'installAvailability',
    'offlineNotice', 'updateNotice', 'applyUpdateButton']) {
    elements.set(`#${id}`, eventTarget({ hidden: true, disabled: false, querySelector: () => ({}) }));
  }
  const timers = new Map();
  let timerId = 0;
  let reloads = 0;
  let openDialog = false;
  const registration = eventTarget({ waiting, installing: null, update: async () => {} });
  const serviceWorker = eventTarget({ controller, register: async () => registration });
  const window = eventTarget({
    isSecureContext: true,
    matchMedia: () => eventTarget({ matches: true }),
    location: { reload: () => { reloads++; } },
    setInterval: fn => { window.poll = fn; },
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInNewContext(source, {
    URL, window, navigator: { onLine: true, serviceWorker }, location: { protocol: 'https:' },
    document: {
      currentScript: { src: 'https://example.com/funds/pwa.js?v=current' },
      querySelector: selector => selector === 'dialog[open]' ? (openDialog ? {} : null) : elements.get(selector),
    },
    MessageChannel: class {
      constructor() {
        this.port1 = { close() {} };
        this.port2 = { reply: data => this.port1.onmessage({ data }) };
      }
    },
  });
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  await flush();
  return {
    registration, serviceWorker, window, flush,
    notice: elements.get('#updateNotice'), button: elements.get('#applyUpdateButton'),
    get reloads() { return reloads; },
    set openDialog(value) { openDialog = value; },
    async expire(delay) {
      for (const [id, timer] of [...timers]) {
        if (timer.delay === delay) { timers.delete(id); timer.fn(); }
      }
      await flush();
    },
  };
}

test('same-release waiting worker stays quiet through repeated focus, polls, and a fresh page', async () => {
  const duplicate = worker('current');
  const page = await app({ waiting: duplicate });
  for (let i = 0; i < 5; i++) {
    await page.window.emit('focus');
    await page.window.poll();
    await page.flush();
    assert.equal(page.notice.hidden, true);
  }
  await page.button.emit('click');
  assert.equal(page.reloads, 0);
  assert.deepEqual(duplicate.messages, ['GET_VERSION']);
  assert.equal((await app({ waiting: duplicate })).notice.hidden, true);
});

test('different release prompts and reloads exactly once only after consent and activation', async () => {
  const next = worker('next');
  const page = await app({ waiting: next });
  assert.equal(page.notice.hidden, false);
  assert.equal(page.reloads, 0);
  await page.button.emit('click');
  await page.button.emit('click');
  assert.equal(page.button.disabled, true);
  assert.equal(page.notice.hidden, true);
  assert.deepEqual(next.messages, ['GET_VERSION', 'SKIP_WAITING']);
  assert.equal(page.reloads, 0);
  page.registration.waiting = null;
  page.serviceWorker.controller = next;
  next.state = 'activated';
  await page.serviceWorker.emit('controllerchange');
  await page.serviceWorker.emit('controllerchange');
  assert.equal(page.reloads, 1);
});

test('first install and absent, activating, redundant, or already controlling workers never prompt', async () => {
  assert.equal((await app()).notice.hidden, true);
  assert.equal((await app({ waiting: worker('next'), controller: null })).notice.hidden, true);
  for (const state of ['installing', 'activating', 'activated', 'redundant']) {
    assert.equal((await app({ waiting: worker('next', state) })).notice.hidden, true);
  }
  const same = worker('next');
  assert.equal((await app({ waiting: same, controller: same })).notice.hidden, true);
});

test('open forms prevent update activation', async () => {
  const next = worker('next');
  const page = await app({ waiting: next });
  page.openDialog = true;
  await page.button.emit('click');
  assert.deepEqual(next.messages, ['GET_VERSION']);
  assert.equal(page.reloads, 0);
  page.openDialog = false;
  await page.button.emit('click');
  assert.ok(next.messages.includes('SKIP_WAITING'));
});

test('legacy workers without version replies can still be updated', async () => {
  const old = worker(null);
  const page = await app({ waiting: old });
  await page.expire(1500);
  assert.equal(page.notice.hidden, false);
  await page.button.emit('click');
  assert.ok(old.messages.includes('SKIP_WAITING'));
});

test('a delayed version check cannot revive an activated or replaced update', async () => {
  const page = await app({ waiting: worker(null) });
  page.registration.waiting = null;
  await page.window.poll();
  await page.expire(1500);
  assert.equal(page.notice.hidden, true);
  page.registration.waiting = worker('current');
  await page.window.poll();
  assert.equal(page.notice.hidden, true);
});

test('an update from another window never forces this page to reload', async () => {
  const page = await app({ waiting: worker('next') });
  page.registration.waiting = null;
  await page.serviceWorker.emit('controllerchange');
  assert.equal(page.notice.hidden, true);
  assert.equal(page.reloads, 0);
});

test('failed activation allows retry without an automatic reload loop', async () => {
  const page = await app({ waiting: worker('next') });
  await page.button.emit('click');
  await page.expire(10000);
  assert.equal(page.button.disabled, false);
  assert.equal(page.notice.hidden, false);
  assert.equal(page.reloads, 0);
});
