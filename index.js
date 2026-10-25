import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { deleteArchivedSession } from './deletion.js';
import { remoteContribution } from './remote.js';

export const name = 'dshplus-session-delete';
export const inject = [
  'typert',
  'sessionPersistence',
  'sessions',
  'agents',
  'workspaceRegistry',
];

class SessionDeleteService extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, 'sessionDelete');
  }

  // Non-owner calls never reach this method: the Gateway consults remoteAccess
  // before dispatch, so access policy stays entirely in the platform's hands.
  async deleteArchived(sessionId) {
    return deleteArchivedSession(this.ctx, sessionId);
  }
}

export function apply(ctx) {
  new SessionDeleteService(ctx);

  const contribution = remoteContribution();
  ctx.typert.register({
    package: contribution.package,
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: contribution.descriptors,
  });
}
