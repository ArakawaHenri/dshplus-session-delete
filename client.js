window.__ModuleLoader__.load({
  id: '@dshplus/session-delete',
  factory(require) {
    const React = require('react');
    const ui = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;
    const {
      Button,
      MenuItemButton,
      Modal,
      IconTrashOutlineRegular: TrashIcon,
    } = ui;

    const styles = `
      .dsh-sd-body {
        display: flex;
        flex-direction: column;
        gap: 6px;
        overflow-wrap: anywhere;
      }
      .dsh-sd-session {
        margin: 0;
        font-weight: 500;
      }
      .dsh-sd-id {
        font-size: 12px;
        line-height: 18px;
        color: var(--dsw-alias-label-secondary);
      }
      .dsh-sd-error {
        margin: 4px 0 0;
        color: var(--dsw-alias-state-error-primary);
        font-size: 13px;
      }
      .dsh-sd-danger {
        color: var(--dsw-alias-state-error-primary);
      }
    `;

    const remoteContribution = function remoteContribution() {
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
    };

    const dictionaries = {
      "en": {
        "delete": "Delete permanently…",
        "heading": "Delete archived session?",
        "untitled": "Untitled session",
        "description": "Permanently deletes this session's logs. Workspace files and attachments are kept.",
        "cancel": "Cancel",
        "confirm": "Delete",
        "deleting": "Deleting…",
        "close": "Close",
        "error.session-in-use": "Session is in use by another window or process",
        "error.not-archived": "Session is not archived",
        "error.session-active": "Session has running work or active reminders",
        "error.unsupported-format": "Open this session to migrate its format first",
        "error.unsupported-backend": "JSONL storage required",
        "error.unsupported-runtime": "Restart DSH before deleting this retained session",
        "error.session-unavailable": "Could not verify session log",
        "error.cleanup-failed": "Logs deleted, but record cleanup failed",
        "error.generic": "Delete failed"
      },
      "zh": {
        "delete": "永久删除…",
        "heading": "删除归档会话？",
        "untitled": "未命名会话",
        "description": "将永久删除此会话的对话日志，无法撤销。工作区文件与附件会保留。",
        "cancel": "取消",
        "confirm": "删除",
        "deleting": "删除中…",
        "close": "关闭",
        "error.session-in-use": "会话被占用，请先在其他窗口关闭",
        "error.not-archived": "会话未归档",
        "error.session-active": "会话仍有运行中的任务或提醒",
        "error.unsupported-format": "请先打开会话完成格式迁移",
        "error.unsupported-backend": "仅支持本地 JSONL 存储",
        "error.unsupported-runtime": "宿主不支持直接释放此会话，请重启后重试",
        "error.session-unavailable": "无法读取会话日志",
        "error.cleanup-failed": "日志已删除，但记录清理失败",
        "error.generic": "删除失败"
      }
    };

    function explain(error, t) {
      const code = String(error?.code || '').split('/').at(-1);
      const key = 'error.' + code;
      if (Object.hasOwn(dictionaries.en, key)) {
        const detail = code === 'cleanup-failed' && error?.details?.reason ? `: ${error.details.reason}` : '';
        return t(key) + detail;
      }
      return String(error?.message || error || t('error.generic'));
    }

    function mountUI(ctx) {
      ctx.effect(() => ctx.locale.register('dsh.sessionDelete', dictionaries));
      const t = ctx.locale.bind('dsh.sessionDelete');

      let state = { confirmation: null };
      let disposed = false;
      const listeners = new Set();
      const store = {
        getSnapshot: () => state,
        subscribe: fn => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      };

      function setState(next) {
        if (disposed) return;
        state = { ...state, ...next };
        for (const fn of listeners) fn();
      }

      ctx.effect(() => () => {
        disposed = true;
        listeners.clear();
        state = { confirmation: null };
      });

      async function refreshSessions(sessionId) {
        try {
          await ctx.sessions.refresh();
          if (sessionId && ctx.sessions.list?.getSnapshot?.().ids?.includes(sessionId)) {
            await ctx.sessions.refresh();
          }
        } catch (error) {
          console.warn('[dshplus-session-delete] List refresh failed:', error);
        }
      }

      ctx.effect(() => ctx.remote.$on('api-session/removed', (sessionId, source) => {
        if (source === 'dshplus-session-delete') return refreshSessions(sessionId);
      }));

      function showConfirmation(sessionId, title) {
        setState({
          confirmation: {
            sessionId,
            title: title || t('untitled'),
            busy: false,
            error: null,
          },
        });
      }

      function useTranslation() {
        React.useSyncExternalStore(
          fn => ctx.locale.subscribe(fn),
          () => ctx.locale.getSnapshot(),
        );
        return t;
      }

      function DeleteItem(props) {
        const translate = useTranslation();
        const archived = props.useWorkspaces(snapshot => snapshot.archivedSessionIds.includes(props.sessionId));
        const [, setMenuOpen] = props.useMenuOpenState();
        const allowed = props.useRemoteAccess('sessionDelete/deleteArchived');
        if (!archived || !allowed) return null;

        return h(
          MenuItemButton,
          {
            danger: true,
            icon: h(TrashIcon, { size: 14 }),
            onSelect: () => {
              setMenuOpen(false);
              showConfirmation(props.sessionId, props.displayTitle);
            },
          },
          translate('delete'),
        );
      }

      function Overlay() {
        const translate = useTranslation();
        const { confirmation: current } = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
        if (!current) return null;

        const dismiss = () => {
          if (!current.busy) setState({ confirmation: null });
        };

        const perform = async () => {
          if (state.confirmation !== current || current.busy) return;
          setState({ confirmation: { ...current, busy: true, error: null } });
          try {
            const response = await ctx.remote.sessionDelete.deleteArchived(current.sessionId);
            if (!response.ok) throw response.error;
            setState({ confirmation: null });
            for (const warning of response.value?.warnings || []) {
              console.warn('[dshplus-session-delete]', warning);
            }
          } catch (error) {
            setState({
              confirmation: {
                ...current,
                busy: false,
                error: explain(error, translate),
              },
            });
          } finally {
            void refreshSessions(current.sessionId);
          }
        };

        return h(
          React.Fragment,
          null,
          h('style', { 'data-session-delete-styles': true }, styles),
          h(
            Modal,
            {
              open: true,
              onClose: dismiss,
              title: translate('heading'),
              closeLabel: translate('close'),
              description: translate('description'),
              footer: h(
                React.Fragment,
                null,
                h(
                  Button,
                  {
                    variant: 'outline',
                    disabled: current.busy,
                    'data-modal-autofocus': true,
                    onClick: dismiss,
                  },
                  translate('cancel'),
                ),
                h(
                  Button,
                  {
                    variant: 'outline',
                    className: 'dsh-sd-danger',
                    disabled: current.busy,
                    onClick: perform,
                  },
                  translate(current.busy ? 'deleting' : 'confirm'),
                ),
              ),
            },
            h(
              'div',
              { className: 'dsh-sd-body' },
              h('p', { className: 'dsh-sd-session' }, current.title),
              h('code', { className: 'dsh-sd-id' }, current.sessionId),
              current.error && h('p', { role: 'alert', className: 'dsh-sd-error' }, current.error),
            ),
          ),
        );
      }

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register(
          {
            name: 'sidebar.workspaces.session.menu.item',
            id: 'dshplus-session-delete.delete',
            order: 500,
            label: () => t('delete'),
          },
          DeleteItem,
        ),
      );
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'dshplus-session-delete.dialog',
            order: 100,
          },
          Overlay,
        ),
      );
    }

    return {
      inject: ['remote'],
      async apply(ctx) {
        await ctx.remote.$mount(remoteContribution());
        ctx.inject(['slots', 'locale', 'remote', 'remote.sessionDelete', 'sessions'], mountUI);
      },
    };
  },
});
