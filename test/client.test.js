import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { Context } from '@deepseek-ai/cordis';
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import { deleteArchivedSession } from '../deletion.js';

const { ClientSessions } = await import(new URL(
  'types/client/sessions/service.js', import.meta.resolve('@deepseek-ai/dsh-api-session-controller'),
));

const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

function extractText(node) {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  return (node.children || []).map(extractText).filter(Boolean).join(' ');
}

function findNode(node, predicate) {
  if (!node || typeof node !== 'object') return undefined;
  if (predicate(node)) return node;
  return node.children?.map(child => findNode(child, predicate)).find(Boolean);
}

function snapshotStore(initial) {
  let snapshot = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    set(value) { snapshot = value; for (const listener of listeners) listener(); },
  };
}

async function mountClient(response, options = {}) {
  const components = new Map();
  const calls = [];
  const warnings = [];
  const remoteListeners = new Set();
  const disposers = [];
  let refreshes = 0;
  const sessions = options.sessions ?? {
    list: snapshotStore({ ids: [], byId: {}, phase: 'ready' }),
    refresh: async () => {},
  };
  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => {
      if (typeof type === 'function') return type({ ...(props || {}), children });
      return { type, props: props || {}, children };
    },
    useSyncExternalStore: (subscribe, snapshot) => {
      const unsubscribe = subscribe(() => {});
      try { return snapshot(); } finally { unsubscribe(); }
    },
  };
  const ui = {
    Button: ({ children = [], ...props }) => ({ type: 'button', props, children }),
    MenuItemButton: ({ children = [], icon, danger, disabled, onSelect }) => ({
      type: 'button',
      props: { role: 'menuitem', danger, disabled, onClick: onSelect },
      children: [icon, ...children],
    }),
    Modal: ({ open, onClose, title, closeLabel, description, footer, children = [] }) =>
      open
        ? {
            type: 'dialog',
            props: { role: 'dialog', onClose },
            children: [
              { type: 'h2', props: {}, children: [title] },
              { type: 'button', props: { 'aria-label': closeLabel, onClick: onClose }, children: [closeLabel] },
              { type: 'p', props: {}, children: [description] },
              ...children,
              footer,
            ],
          }
        : null,
    IconTrashOutlineRegular: () => ({ type: 'svg', props: {}, children: [] }),
  };

  let module;
  runInNewContext(clientSource, {
    console: { warn: (...args) => warnings.push(args) },
    window: {
      location: { reload: () => assert.fail('Deletion must not reload the UI') },
      __ModuleLoader__: {
        load(entry) {
          module = entry;
        },
      },
    },
  });
  assert.equal(module.id, '@dshplus/session-delete');

  const plugin = module.factory(name => {
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return ui;
    assert.fail(`Unexpected module: ${name}`);
  });

  let dictionaries;
  const services = new Map([
    [
      'slots',
      {
        inject: (_name, callback) => callback(),
        register: ({ name }, component) => components.set(name, component),
      },
    ],
    [
      'locale',
      {
        register: (_namespace, value) => {
          dictionaries = value;
        },
        bind: () => key => dictionaries.en[key],
        subscribe: () => () => {},
        getSnapshot: () => 'en',
      },
    ],
  ]);

  services.set('remote', {
    $on(event, listener) {
      assert.equal(event, 'api-session/removed');
      remoteListeners.add(listener);
      return () => remoteListeners.delete(listener);
    },
    async $mount(contribution) {
      assert.equal(contribution.descriptors[0].namespace, 'sessionDelete');
      await Promise.resolve();
      services.set('remote.sessionDelete', {
        async deleteArchived(id) {
          calls.push(id);
          const result = typeof response === 'function' ? await response(id) : response;
          options.onResponse?.(result);
          return result;
        },
      });
    },
  });
  services.set('sessions', {
    list: sessions.list,
    async refresh() { refreshes++; await sessions.refresh(); },
  });

  function createContext(inject) {
    const declared = new Set(inject);
    for (const name of declared) {
      assert.ok(services.has(name), `Service ${name} is not mounted`);
    }

    function get(name) {
      if (!declared.has(name)) {
        throw new Error(`cannot get property ${name} without inject`);
      }
      assert.ok(services.has(name), `Service ${name} is not mounted`);
      return services.get(name);
    }

    const remote = {
      $mount: contribution => get('remote').$mount(contribution),
      $on: (event, listener) => get('remote').$on(event, listener),
      get sessionDelete() {
        return get('remote.sessionDelete');
      },
    };

    return {
      get slots() {
        return get('slots');
      },
      get locale() {
        return get('locale');
      },
      get remote() {
        get('remote');
        return remote;
      },
      get sessions() { return get('sessions'); },
      effect: callback => { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose); return dispose; },
      inject: (names, callback) => callback(createContext(names)),
    };
  }

  await plugin.apply(createContext(plugin.inject));
  return {
    calls,
    warnings,
    sessions,
    refreshes: () => refreshes,
    async emitRemoved(id, source) {
      sessions.handleSessionRemoved?.(id);
      await Promise.all([...remoteListeners].map(listener => listener(id, source)));
    },
    dispose: () => { for (const dispose of disposers.reverse()) dispose(); },
    Menu: components.get('sidebar.workspaces.session.menu.item'),
    Overlay: components.get('shell.overlay'),
  };
}

function openMenu(client, id = 'fixture-only') {
  client.Menu({
    sessionId: id,
    displayTitle: 'Fixture session',
    useWorkspaces: selector => selector({ archivedSessionIds: [id] }),
    useMenuOpenState: () => [true, () => {}],
    useRemoteAccess: () => true,
  }).props.onClick();
}

function button(tree, label) {
  const node = findNode(tree, item => item.type === 'button' && extractText(item) === label);
  assert.ok(node, `Button ${label} must be visible`);
  return node;
}

for (const outcome of ['success', 'error']) {
  test(`client confirmation dialog handles ${outcome} response`, async () => {
    const id = 'selected-archived-session';
    const response =
      outcome === 'success'
        ? {
            ok: true,
            value: { warnings: ['Fixture cleanup warning'] },
          }
        : {
            ok: false,
            error: { code: 'session-delete/session-in-use', message: 'Fixture service error', details: {} },
          };

    const { calls, warnings, Menu, Overlay, refreshes } = await mountClient(response);
    assert.equal(typeof Menu, 'function');
    assert.equal(typeof Overlay, 'function');

    const menuChanges = [];
    const item = Menu({
      sessionId: id,
      displayTitle: 'Selected archived session',
      useWorkspaces: selector => selector({ archivedSessionIds: [id] }),
      useMenuOpenState: () => [true, value => menuChanges.push(value)],
      useRemoteAccess: path => {
        assert.equal(path, 'sessionDelete/deleteArchived');
        return true;
      },
    });

    assert.equal(item.props.role, 'menuitem');
    assert.equal(item.props.danger, true);
    item.props.onClick();
    assert.deepEqual(menuChanges, [false]);

    const confirmation = Overlay();
    assert.ok(findNode(confirmation, node => node.type === 'dialog'));
    assert.match(extractText(confirmation), /Delete archived session\?/);
    assert.match(extractText(confirmation), /Selected archived session/);
    assert.match(extractText(confirmation), new RegExp(id));
    assert.deepEqual(calls, []);

    const confirmButton = button(confirmation, 'Delete');
    await Promise.all([confirmButton.props.onClick(), confirmButton.props.onClick()]);

    const result = Overlay();
    assert.deepEqual(calls, [id]);

    if (outcome === 'success') {
      assert.equal(result, null);
      assert.deepEqual(warnings, [['[dshplus-session-delete]', 'Fixture cleanup warning']]);
      assert.equal(refreshes(), 1);
    } else {
      assert.ok(findNode(result, node => node.type === 'dialog'));
      assert.deepEqual(warnings, []);
      assert.equal(refreshes(), 1);
      assert.match(
        extractText(findNode(result, node => node.props.role === 'alert')),
        /Session is in use by another window or process/,
      );
    }
  });
}

test('cleanup failure keeps the dialog and allows retrying', async () => {
  let attempts = 0;
  const client = await mountClient(async () => ++attempts === 1
    ? { ok: false, error: { code: 'session-delete/cleanup-failed', message: 'Logs deleted', details: { reason: 'Disk is full' } } }
    : { ok: true, value: { warnings: [] } });
  openMenu(client);
  await button(client.Overlay(), 'Delete').props.onClick();
  const pending = client.Overlay();
  assert.match(extractText(findNode(pending, node => node.props.role === 'alert')), /Disk is full/);
  button(pending, 'Cancel');
  const retry = button(pending, 'Delete');
  await Promise.all([retry.props.onClick(), retry.props.onClick()]);
  assert.equal(attempts, 2);
  assert.equal(client.Overlay(), null);
});

test('a list refresh failure logs a warning and never resends a completed deletion', async () => {
  const client = await mountClient({ ok: true, value: { warnings: [] } }, {
    sessions: {
      list: snapshotStore({ ids: [], byId: {}, phase: 'ready' }),
      refresh: async () => { throw new Error('Disconnected'); },
    },
  });
  openMenu(client);
  await button(client.Overlay(), 'Delete').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(client.calls, ['fixture-only']);
  assert.equal(client.Overlay(), null);
  assert.match(String(client.warnings[0][1]), /Disconnected/);
});

async function createConnectedFixture(t, { subagent = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-delete-client-')));
  const host = new Context();
  const clients = [];
  const contexts = [];
  const deliveries = [];
  const id = 'connected-fixture';
  let cleanupFails = false;
  let mutations = 0;
  const workspaces = { list: snapshotStore({ items: [], phase: 'ready', archivedSessionIds: [id] }) };
  t.after(async () => {
    try {
      for (const client of clients) client.dispose();
      await Promise.all(deliveries);
      for (const context of contexts) await context.fiber.dispose();
      await host.fiber.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  const fiber = host.plugin(Jsonl, { root: join(root, 'sessions'), compression: 'none' });
  await fiber.await();
  assert.equal(fiber.state, 2);
  const writer = await host.sessionPersistence.create({
    version: SESSION_FORMAT_VERSION, id, createdAt: 1, cwd: root, isSeeded: false,
    ...(subagent ? { origin: 'subagent', parentSession: 'parent-fixture', delegationDepth: 1 } : {}),
  });
  await writer.flush();
  const path = host.sessionPersistence.locate(writer.header).path;
  await writer.close();
  host.provide('sessions', { get: () => undefined });
  host.provide('agents', { get: () => undefined });
  host.provide('workspaceRegistry', {
    get archivedSessionIds() { return workspaces.list.getSnapshot().archivedSessionIds; },
    list: () => [{ detachSession: async () => { if (cleanupFails) throw new Error('Workspace disk is full'); } }],
    async unarchiveSession(sessionId) {
      workspaces.list.set({ ...workspaces.list.getSnapshot(), archivedSessionIds: this.archivedSessionIds.filter(value => value !== sessionId) });
    },
  });
  host.on('api-session/removed', (sessionId, source) => {
    for (const client of clients) deliveries.push(client.emitRemoved(sessionId, source));
  });
  return {
    id, path, host, workspaces,
    mutations: () => mutations,
    failCleanup: value => { cleanupFails = value; },
    settleNotifications: () => Promise.all(deliveries),
    async connect({ onResponse } = {}) {
      const context = new Context();
      contexts.push(context);
      let holdNextList;
      const sessions = new ClientSessions(context, {
        session: {
          async list() {
            const gate = holdNextList;
            holdNextList = undefined;
            const items = (await host.sessionPersistence.list()).map(({ header }) => ({
              sessionId: header.id, updatedAt: header.createdAt, cwd: header.cwd,
              origin: header.origin, parentSessionId: header.parentSession,
              blank: false, running: false, agentAvailable: false,
            }));
            if (gate) { gate.entered.resolve(); await gate.release.promise; }
            return { ok: true, value: { items } };
          },
        },
      });
      await sessions.refresh();
      const client = await mountClient(async sessionId => {
        mutations++;
        try {
          return { ok: true, value: await deleteArchivedSession(host, sessionId) };
        } catch (error) {
          return { ok: false, error: { code: error.code, message: error.message, details: error.details } };
        }
      }, { sessions, onResponse });
      clients.push(client);
      return Object.assign(client, {
        nativeSessions: sessions,
        holdNextList() {
          const gate = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
          holdNextList = gate;
          return gate;
        },
      });
    },
  };
}

for (const subagent of [false, true]) {
  test(`deletion removes a ${subagent ? 'subagent' : 'session'} from two native client lists despite an older refresh`, async t => {
    const f = await createConnectedFixture(t, { subagent });
    const first = await f.connect();
    const second = await f.connect();
    assert.deepEqual(first.sessions.list.getSnapshot().ids, [f.id]);
    const gate = second.holdNextList();
    const staleRefresh = second.nativeSessions.refresh();
    await gate.entered.promise;
    try {
      openMenu(first, f.id);
      await button(first.Overlay(), 'Delete').props.onClick();
      assert.equal(existsSync(f.path), false);
    } finally {
      gate.release.resolve();
    }
    await staleRefresh;
    await f.settleNotifications();
    assert.deepEqual(first.sessions.list.getSnapshot().ids, []);
    assert.deepEqual(second.sessions.list.getSnapshot().ids, []);
    assert.deepEqual(f.workspaces.list.getSnapshot().archivedSessionIds, []);
    assert.equal(f.mutations(), 1);
  });
}

test('retry succeeds when the original deletion completed but its response was lost', async t => {
  const f = await createConnectedFixture(t);
  let responseLost = false;
  const client = await f.connect({
    onResponse(result) {
      if (result.ok && !responseLost) {
        responseLost = true;
        throw new Error('Fixture response lost');
      }
    },
  });
  openMenu(client, f.id);
  await button(client.Overlay(), 'Delete').props.onClick();
  await f.settleNotifications();
  assert.equal(existsSync(f.path), false);
  assert.deepEqual(f.workspaces.list.getSnapshot().archivedSessionIds, []);
  assert.match(extractText(client.Overlay()), /Fixture response lost/);
  await button(client.Overlay(), 'Delete').props.onClick();
  await f.settleNotifications();
  assert.equal(client.Overlay(), null);
  assert.equal(f.mutations(), 2);
});

for (const cleanupFails of [false, true]) {
  test(`a pending list request does not delay the ${cleanupFails ? 'cleanup error' : 'successful deletion'} UI`, async t => {
    const f = await createConnectedFixture(t);
    const responseReady = Promise.withResolvers();
    const client = await f.connect({ onResponse: responseReady.resolve });
    f.failCleanup(cleanupFails);
    const gate = client.holdNextList();
    const staleRefresh = client.nativeSessions.refresh();
    await gate.entered.promise;
    openMenu(client, f.id);
    let settled = false;
    const operation = button(client.Overlay(), 'Delete').props.onClick().then(() => { settled = true; });
    try {
      await responseReady.promise;
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, true, 'Deletion response must settle while the list request is still pending');
      assert.equal(existsSync(f.path), false);
      if (cleanupFails) {
        const overlay = client.Overlay();
        assert.match(extractText(overlay), /Workspace disk is full/);
        assert.equal(button(overlay, 'Delete').props.disabled, false);
        assert.equal(button(overlay, 'Cancel').props.disabled, false);
      } else {
        assert.equal(client.Overlay(), null);
      }
      assert.equal(f.mutations(), 1);
    } finally {
      gate.release.resolve();
      await staleRefresh;
      await operation;
      await f.settleNotifications();
    }
  });
}

test('ordinary subagent disposal does not trigger the deletion plugin list refresh', async t => {
  const f = await createConnectedFixture(t, { subagent: true });
  const client = await f.connect();
  await client.emitRemoved(f.id);
  assert.equal(client.refreshes(), 0);
  f.workspaces.list.set({ ...f.workspaces.list.getSnapshot(), archivedSessionIds: [] });
  await client.emitRemoved(f.id);
  assert.equal(client.refreshes(), 0);
  assert.equal(existsSync(f.path), true);
  assert.deepEqual(client.sessions.list.getSnapshot().ids, [f.id]);
  assert.equal(f.mutations(), 0);
});
