import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { Context, Service } from '@deepseek-ai/cordis';

const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const State = { PENDING: 0, LOADING: 1, ACTIVE: 2, FAILED: 3, DISPOSED: 4 };
const MENU_SLOT = 'sidebar.workspaces.session.menu.item';
const OVERLAY_SLOT = 'shell.overlay';

function loadPlugin(source = clientSource) {
  let entry;
  runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load(value) {
          entry = value;
        },
      },
    },
  });
  assert.equal(entry.id, '@dshplus/session-delete');
  return entry.factory(name => {
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {};
    assert.equal(name, 'react');
    return {
      createElement() {
        assert.fail('Startup must not render UI');
      },
    };
  });
}

function createFixture(t, { deferMount = false, lateNamespace = false } = {}) {
  const ctx = new Context();
  const slots = new Map();
  const dictionaries = new Map();
  const errors = [];
  const fibers = new Set();
  const counts = { mounts: 0, rpc: 0, refreshes: 0, localeDisposals: 0, slotDisposals: 0 };
  const entered = Promise.withResolvers();
  const mountGate = Promise.withResolvers();
  if (!deferMount) mountGate.resolve();

  ctx.logger.exporter({
    export(message) {
      if (message.type === 'error') errors.push(...message.args);
    },
  });
  ctx.on('internal/plugin', fiber => {
    fibers.add(fiber);
  });

  class Slots extends Service {
    constructor() {
      super(ctx, 'slots');
    }

    inject(name, callback) {
      assert.ok([MENU_SLOT, OVERLAY_SLOT].includes(name));
      return this.ctx.effect(callback);
    }

    register(options, component) {
      assert.equal(typeof component, 'function');
      return this.ctx.effect(() => {
        assert.equal(slots.has(options.name), false);
        slots.set(options.name, { ...options, component, owner: this.ctx.fiber });
        return () => {
          slots.delete(options.name);
          counts.slotDisposals++;
        };
      });
    }
  }

  class Locale extends Service {
    constructor() {
      super(ctx, 'locale');
    }

    register(namespace, value) {
      assert.equal(dictionaries.has(namespace), false);
      dictionaries.set(namespace, value);
      return () => {
        dictionaries.delete(namespace);
        counts.localeDisposals++;
      };
    }

    bind(namespace) {
      return key => dictionaries.get(namespace).en[key];
    }
  }

  function provideNamespace(owner) {
    return owner.provide('remote.sessionDelete', {
      deleteArchived() {
        counts.rpc++;
        assert.fail('Startup must never invoke a session action');
      },
    });
  }

  class Remote extends Service {
    constructor() {
      super(ctx, 'remote');
    }

    $on(event, listener) {
      assert.equal(event, 'api-session/removed');
      return this.ctx.on(event, listener);
    }

    async $mount(contribution) {
      counts.mounts++;
      assert.equal(contribution.package, '@dshplus/session-delete');
      assert.equal(contribution.descriptors[0].namespace, 'sessionDelete');
      entered.resolve();
      await mountGate.promise;
      if (!lateNamespace) provideNamespace(this.ctx);
    }
  }

  new Slots();
  new Locale();
  new Remote();
  ctx.provide('sessions', {
    refresh: async () => { counts.refreshes++; },
    list: { getSnapshot: () => ({ ids: [] }) },
    manager: { getListSnapshot: () => ({ state: 'idle', error: null }) },
  });
  ctx.provide('workspaces', { list: {} });

  t.after(async () => {
    mountGate.resolve();
    await ctx.fiber.dispose();
  });

  const root = ctx.plugin(loadPlugin());
  return {
    ctx,
    root,
    slots,
    dictionaries,
    counts,
    errors,
    entered: entered.promise,
    releaseMount: mountGate.resolve,
    children: () => [...fibers].filter(fiber => fiber.parent.fiber === root.ctx.fiber),
    provideNamespace: () => provideNamespace(root.ctx),
  };
}

function assertMounted(f, child) {
  assert.equal(f.root.state, State.ACTIVE);
  assert.equal(child.state, State.ACTIVE);
  assert.deepEqual([...f.slots.keys()].sort(), [MENU_SLOT, OVERLAY_SLOT].sort());
  assert.equal(f.slots.get(MENU_SLOT).id, 'dshplus-session-delete.delete');
  assert.equal(f.slots.get(OVERLAY_SLOT).id, 'dshplus-session-delete.dialog');
  for (const slot of f.slots.values()) {
    assert.equal(slot.owner, child);
  }
  assert.equal(f.dictionaries.size, 1);
  assert.equal(f.slots.get(MENU_SLOT).label(), 'Delete permanently…');
  assert.equal(f.counts.mounts, 1);
  assert.equal(f.counts.rpc, 0);
  assert.deepEqual(f.errors, []);
  assert.equal(typeof child.ctx.remote.sessionDelete.deleteArchived, 'function');
  assert.ok(Object.hasOwn(child.inject, 'remote.sessionDelete'));
  assert.ok(Object.hasOwn(child.inject, 'sessions'));
  assert.deepEqual(Object.keys(f.root.inject), ['remote']);
}

function assertReleased(f) {
  assert.equal(f.slots.size, 0);
  assert.equal(f.dictionaries.size, 0);
  assert.equal(f.counts.rpc, 0);
}

test('client plugin awaits $mount, activates UI child, and cleans up on dispose', async t => {
  const f = createFixture(t, { deferMount: true });
  await f.entered;
  assert.equal(f.root.state, State.LOADING);
  assert.equal(f.children().length, 0);
  assertReleased(f);

  f.releaseMount();
  await f.root.await();
  assert.equal(f.children().length, 1);

  const [child] = f.children();
  await child.await();
  assertMounted(f, child);
  await f.ctx.parallel('api-session/removed', 'fixture-only');
  assert.equal(f.counts.refreshes, 0);
  await f.ctx.parallel('api-session/removed', 'fixture-only', 'dshplus-session-delete');
  assert.equal(f.counts.refreshes, 1);

  await f.root.dispose();
  assert.equal(f.root.state, State.DISPOSED);
  assert.equal(child.state, State.DISPOSED);
  assertReleased(f);
  assert.equal(f.counts.localeDisposals, 1);
  assert.equal(f.counts.slotDisposals, 2);
  assert.equal(f.ctx.get('remote.sessionDelete'), undefined);
  await f.ctx.parallel('api-session/removed', 'fixture-only', 'dshplus-session-delete');
  assert.equal(f.counts.refreshes, 1, 'Disposed UI must unsubscribe from removal notifications');
  assert.deepEqual(f.errors, []);
});

test('client plugin waits for late RPC namespace and reloads UI when namespace restarts', async t => {
  const f = createFixture(t, { lateNamespace: true });
  await f.root.await();
  assert.equal(f.root.state, State.ACTIVE);
  assert.equal(f.children().length, 1);

  const [child] = f.children();
  await child.await();
  assert.equal(child.state, State.PENDING);
  assertReleased(f);

  const removeNamespace = f.provideNamespace();
  await child.await();
  assertMounted(f, child);

  await removeNamespace();
  await child.await();
  assert.equal(f.root.state, State.ACTIVE);
  assert.equal(child.state, State.PENDING);
  assertReleased(f);
  assert.equal(f.counts.localeDisposals, 1);
  assert.equal(f.counts.slotDisposals, 2);

  f.provideNamespace();
  await child.await();
  assertMounted(f, child);

  await f.root.dispose();
  assert.equal(child.state, State.DISPOSED);
  assertReleased(f);
  assert.equal(f.counts.localeDisposals, 2);
  assert.equal(f.counts.slotDisposals, 4);
  assert.deepEqual(f.errors, []);
});
