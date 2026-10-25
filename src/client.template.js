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

    /* REMOTE_CONTRIBUTION */

    /* DICTIONARIES */

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
