import { lstatSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';

function refuse(code, message) {
  throw new RemoteError(`session-delete/${code}`, message, {});
}

const LOG_FILE_PATTERN = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/;

function sessionPath(persistence, header) {
  if (typeof persistence.locate !== 'function' || typeof persistence.root !== 'string' || !isAbsolute(persistence.root)) {
    refuse('unsupported-backend', 'Session storage must expose a local JSONL root and locate(header).');
  }
  const location = persistence.locate(header);
  if (location?.kind !== 'jsonl' || typeof location.path !== 'string' || !isAbsolute(location.path)) {
    refuse('unsupported-backend', 'An absolute local JSONL path is required.');
  }

  // locate() encodes the header into safe path segments, so a lexical escape
  // (`..`) can only come from a foreign backend path — refuse it before any
  // filesystem access; the realpath comparison then rejects symlinked
  // directories that physically resolve outside the storage root.
  const path = resolve(location.path);
  const directory = dirname(path);
  const child = relative(resolve(persistence.root), directory);
  if (!child || child.startsWith('..') || realpathSync(directory) !== join(realpathSync(persistence.root), child)) {
    refuse('unsafe-path', 'Session storage resolves outside its expected directory.');
  }

  // DSH opens this file for writing before flock; a linked lock could truncate another file.
  try {
    const lock = lstatSync(join(directory, 'session.lock'));
    if (!lock.isFile() || lock.nlink !== 1) {
      refuse('unsafe-path', 'The session lock must be a regular file with one link.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return path;
}

function logFiles(path) {
  const directory = dirname(path);
  const files = readdirSync(directory, { withFileTypes: true })
    .filter(entry => LOG_FILE_PATTERN.test(entry.name))
    .map(entry => {
      if (!entry.isFile()) refuse('unsafe-path', 'Session logs must be regular files.');
      return join(directory, entry.name);
    });
  if (!files.includes(path)) refuse('session-unavailable', 'The current session log is missing.');
  // Keep the current log until all historical generations have been removed.
  return files.sort((a, b) => Number(a === path) - Number(b === path));
}

function checkArchived(registry, id) {
  if (!registry.archivedSessionIds.includes(id)) {
    refuse('not-archived', 'Archive the session before deleting it.');
  }
}

function checkSessionState(ctx, id, retiring) {
  const session = ctx.sessions.get(id);
  const agent = ctx.agents.get(id);
  // The native loop reports maintenance as idle, although it still owns work.
  if (agent?.status === 'running' || agent?.phase?.kind === 'maintenance') {
    refuse('session-active', 'The session still has running work or active reminders.');
  }
  if (agent && agent === retiring && agent.status === 'idle' && session === agent.session) return;
  if (session || agent) {
    refuse('session-in-use', 'Close this session in all windows and wait for its work to stop.');
  }
}

async function checkActivity(ctx, id) {
  const activity = await ctx.waterfall('workspace/session-activity', { sessionId: id }, async () => []);
  if (activity.length > 0) {
    refuse('session-active', 'The session still has running work or active reminders.');
  }
}

function idleAgentDisposer(ctx, id) {
  // Harness keeps created/resumed Agents until their owning plugin exits.
  // The labeled lifecycle effect drains the loop, disposes the scope, closes
  // the writer, and unregisters both objects. Disposing agent.ctx alone omits
  // the writer and registry cleanup. Use this exact native teardown.
  const label = `agentLoop.lifecycle(${id})`;
  const fibers = [ctx.root?.fiber];
  const runtimes = typeof ctx.registry?.values === 'function' ? ctx.registry.values() : [];
  for (const runtime of runtimes) {
    if (typeof runtime.fibers?.[Symbol.iterator] === 'function') fibers.push(...runtime.fibers);
  }
  for (const fiber of fibers) {
    if (typeof fiber?._disposables?.[Symbol.iterator] !== 'function') continue;
    for (const dispose of fiber._disposables) {
      if (typeof dispose === 'function' && dispose[Symbol.for('cordis.effect')]?.label === label) return dispose;
    }
  }
  refuse('unsupported-runtime', 'Harness did not expose a complete release action for this retained session. Restart Harness and retry.');
}

async function isMissing(persistence, id) {
  // stat() also returns undefined for an unreadable header. Only open()'s explicit
  // not-found error permits cleaning stale metadata, including after a restart.
  let handle;
  try {
    handle = await persistence.open(id, 'read');
  } catch (error) {
    if (error.name === 'SessionPersistenceNotFoundError') return true;
    throw error;
  } finally {
    await handle?.close();
  }
  return false;
}

export async function deleteArchivedSession(ctx, id) {
  const registry = ctx.workspaceRegistry;
  const persistence = ctx.sessionPersistence;
  if (typeof persistence.stat !== 'function' || typeof persistence.open !== 'function' || persistence.identity == null) {
    refuse('unsupported-backend', 'Session storage must expose stat(id), open(id, access), and a stable provider identity.');
  }
  const retiring = ctx.agents.get(id);
  checkSessionState(ctx, id, retiring);
  if (retiring) {
    checkArchived(registry, id);
    await checkActivity(ctx, id);
    // Activity providers can yield; archive state and the exact idle instance
    // must still match before invoking a teardown that cancels its driver.
    checkArchived(registry, id);
    checkSessionState(ctx, id, retiring);
    await idleAgentDisposer(ctx, id)();
    // Teardown changes the client list even if a later deletion step fails.
    ctx.emit('api-session/removed', id, 'dshplus-session-delete');
  }
  checkSessionState(ctx, id);

  const snapshot = await persistence.stat(id);
  let path;
  let handle;
  if (snapshot) {
    checkArchived(registry, id);
    if (snapshot.formatStatus !== 'current') {
      refuse('unsupported-format', 'Open this session to migrate it before deleting.');
    }
    path = sessionPath(persistence, snapshot.header);
    try {
      handle = await persistence.open(id, 'write');
    } catch (error) {
      if (error.name === 'SessionAlreadyOwnedError') {
        refuse('session-in-use', 'Another window or process owns this session. Close it before deleting.');
      }
      throw error;
    }
  } else if (!await isMissing(persistence, id)) {
    refuse('session-unavailable', 'The session log could not be verified.');
  }

  const warnings = [];
  try {
    await checkActivity(ctx, id);
    checkSessionState(ctx, id);
    // Provider teardown closes its handles and releases their locks.
    if (ctx.sessionPersistence.identity !== persistence.identity) {
      refuse('session-changed', 'Session storage changed during deletion preparation.');
    }
    if (handle) {
      checkArchived(registry, id);
      if (persistence.locate(handle.header).path !== path) {
        refuse('session-changed', 'The locked session path changed during deletion preparation.');
      }
      for (const file of logFiles(path)) unlinkSync(file);
    }
    // Once native storage confirms absence, cleanup is safe to repeat even if
    // another window already removed the archive entry or its reply was lost.
    // The native relay forwards extra arguments; native listeners consume only
    // the ID. Our source tag distinguishes deletion from ordinary disposal.
    ctx.emit('api-session/removed', id, 'dshplus-session-delete');
    try {
      for (const workspace of registry.list()) await workspace.detachSession(id);
      await registry.unarchiveSession(id);
    } catch (error) {
      throw new RemoteError('session-delete/cleanup-failed', 'Logs deleted; session record cleanup failed.', {
        reason: String(error?.message || error),
      });
    }
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        warnings.push(`Session lock release reported: ${error.message}`);
      }
    }
  }
  return { warnings };
}
