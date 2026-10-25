export function remoteContribution() {
  const packageName = '@dshplus/session-delete';

  const sessionIdCodec = {
    mode: 'strict',
    typeSymbol: `${packageName}#SessionId`,
    create: () => ({
      parse(value) {
        if (typeof value !== 'string' || !value.trim() || value.length > 512) {
          throw new TypeError('Expected a nonempty session ID.');
        }
        return value;
      },
    }),
    jsonSchema: { type: 'string', minLength: 1, maxLength: 512 },
  };

  return {
    package: packageName,
    descriptors: [
      {
        id: `${packageName}#sessionDelete/deleteArchived`,
        service: 'sessionDelete',
        namespace: 'sessionDelete',
        method: 'deleteArchived',
        invocation: { kind: 'direct' },
        parameters: [{ name: 'sessionId', wire: 'sessionId', source: 'json', codec: sessionIdCodec }],
        result: { mode: 'src-json' },
      },
    ],
  };
}
