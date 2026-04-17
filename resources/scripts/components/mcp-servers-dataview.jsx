import {DataViews} from '@wordpress/dataviews';
import {useState, useEffect, useCallback} from '@wordpress/element';
import {__} from '@wordpress/i18n';
import {Button, Notice} from '@wordpress/components';
import apiFetch from '@wordpress/api-fetch';

/**
 * List + connect/disconnect UI for remote MCP servers.
 *
 * Server list is read-only (configured via the `gds-assistant/mcp_servers`
 * PHP filter or `GDS_ASSISTANT_MCP_SERVERS` env var). This view is for
 * managing per-user OAuth connections to those servers.
 */
export function McpServersDataView() {
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(() => readInitialNotice());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch({path: '/gds-assistant/v1/mcp/servers'});
      setServers(Array.isArray(data) ? data : []);
    } catch (e) {
      setNotice({type: 'error', text: e.message || 'Failed to load'});
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const connect = useCallback(async (name) => {
    setBusy(name);
    try {
      const res = await apiFetch({
        path: `/gds-assistant/v1/mcp/${name}/connect`,
        method: 'POST',
      });
      if (res?.authorization_url) {
        window.location.href = res.authorization_url;
        return;
      }
      setNotice({type: 'error', text: 'No authorization URL returned'});
    } catch (e) {
      setNotice({type: 'error', text: e.message || 'Connect failed'});
    } finally {
      setBusy(null);
    }
  }, []);

  const disconnect = useCallback(
    async (name) => {
      // eslint-disable-next-line no-alert
      if (!window.confirm(__('Disconnect this MCP server?', 'gds-assistant'))) {
        return;
      }
      setBusy(name);
      try {
        await apiFetch({
          path: `/gds-assistant/v1/mcp/${name}/disconnect`,
          method: 'POST',
        });
        setNotice({
          type: 'success',
          text: __('Disconnected.', 'gds-assistant'),
        });
        load();
      } catch (e) {
        setNotice({type: 'error', text: e.message || 'Disconnect failed'});
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const fields = [
    {
      id: 'label',
      label: __('Server', 'gds-assistant'),
      enableGlobalSearch: true,
      render: ({item}) => <strong>{item.label}</strong>,
    },
    {
      id: 'url',
      label: __('URL', 'gds-assistant'),
      render: ({item}) => (
        <code style={{fontSize: '11px'}}>{item.url}</code>
      ),
    },
    {
      id: 'auth_type',
      label: __('Auth', 'gds-assistant'),
      render: ({item}) => <code>{item.auth_type}</code>,
    },
    {
      id: 'connected',
      label: __('Status', 'gds-assistant'),
      render: ({item}) => {
        if (!item.requires_oauth) {
          return (
            <span style={{color: 'green'}}>
              ● {__('Available', 'gds-assistant')}
            </span>
          );
        }
        return item.connected ? (
          <span style={{color: 'green'}}>
            ● {__('Connected', 'gds-assistant')}
          </span>
        ) : (
          <span style={{color: '#d63638'}}>
            ○ {__('Not connected', 'gds-assistant')}
          </span>
        );
      },
    },
    {
      id: 'actions',
      label: __('Actions', 'gds-assistant'),
      enableSorting: false,
      render: ({item}) => {
        if (!item.requires_oauth) {
          return <span style={{color: '#999'}}>—</span>;
        }
        return item.connected ? (
          <Button
            variant="link"
            isDestructive
            disabled={busy === item.name}
            onClick={() => disconnect(item.name)}
          >
            {__('Disconnect', 'gds-assistant')}
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={busy === item.name}
            onClick={() => connect(item.name)}
          >
            {busy === item.name
              ? __('Connecting…', 'gds-assistant')
              : __('Connect', 'gds-assistant')}
          </Button>
        );
      },
    },
  ];

  const view = {
    type: 'table',
    fields: ['label', 'url', 'auth_type', 'connected', 'actions'],
    layout: {},
  };

  return (
    <>
      <p className="description" style={{marginBottom: 16}}>
        {__(
          'Remote MCP servers whose tools are available in the assistant. Configure servers via the gds-assistant/mcp_servers filter or GDS_ASSISTANT_MCP_SERVERS env var. OAuth connections are per-user.',
          'gds-assistant',
        )}
      </p>

      {notice && (
        <Notice
          status={notice.type}
          onRemove={() => setNotice(null)}
          style={{marginBottom: 16}}
        >
          {notice.text}
        </Notice>
      )}

      {loading ? (
        <p>{__('Loading…', 'gds-assistant')}</p>
      ) : servers.length === 0 ? (
        <Notice status="info" isDismissible={false}>
          {__(
            'No MCP servers configured yet. Add some via the gds-assistant/mcp_servers filter.',
            'gds-assistant',
          )}
        </Notice>
      ) : (
        <DataViews
          data={servers}
          fields={fields}
          view={view}
          onChangeView={() => {}}
          defaultLayouts={{table: {}}}
          getItemId={(item) => item.id}
          paginationInfo={{totalItems: servers.length, totalPages: 1}}
          search={false}
          actions={[]}
        />
      )}
    </>
  );
}

/** Convert ?mcp_connect=success|error query args from the OAuth callback into a Notice. */
function readInitialNotice() {
  const params = new URLSearchParams(window.location.search);
  const status = params.get('mcp_connect');
  const msg = params.get('mcp_msg');
  if (status === 'success') {
    return {
      type: 'success',
      text: __('MCP connection established.', 'gds-assistant'),
    };
  }
  if (status === 'error') {
    return {
      type: 'error',
      text: msg
        ? decodeURIComponent(msg)
        : __('MCP connection failed.', 'gds-assistant'),
    };
  }
  return null;
}
