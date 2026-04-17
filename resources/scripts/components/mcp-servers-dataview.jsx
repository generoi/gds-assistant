import {DataViews} from '@wordpress/dataviews';
import {useState, useEffect, useCallback} from '@wordpress/element';
import {__} from '@wordpress/i18n';
import {
  Button,
  Notice,
  Modal,
  TextControl,
  SelectControl,
} from '@wordpress/components';
import apiFetch from '@wordpress/api-fetch';

/**
 * List + connect/disconnect + add/delete UI for MCP servers.
 *
 * Servers come from three sources, displayed via an origin badge:
 *   - builtin: gds-mcp local abilities (read-only placeholder row)
 *   - code: declared via `gds-assistant/mcp_servers` filter or env var
 *   - admin: added through this UI, persisted to wp_options
 * Only `admin`-origin servers can be edited or deleted from the UI.
 */
export function McpServersDataView() {
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(() => readInitialNotice());
  const [editing, setEditing] = useState(null); // null = closed, {} = add, server-row = edit

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

  const remove = useCallback(
    async (name) => {
      // eslint-disable-next-line no-alert
      if (
        !window.confirm(
          __(
            'Delete this MCP server and any stored tokens for it?',
            'gds-assistant',
          ),
        )
      ) {
        return;
      }
      setBusy(name);
      try {
        await apiFetch({
          path: `/gds-assistant/v1/mcp/servers/${name}`,
          method: 'DELETE',
        });
        setNotice({type: 'success', text: __('Removed.', 'gds-assistant')});
        load();
      } catch (e) {
        setNotice({type: 'error', text: e.message || 'Delete failed'});
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
      render: ({item}) => (
        <span>
          <strong>{item.label}</strong>{' '}
          <OriginBadge origin={item.origin} />
        </span>
      ),
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
      render: ({item}) => (
        <div style={{display: 'flex', gap: 8}}>
          {item.requires_oauth && !item.connected && (
            <Button
              variant="primary"
              disabled={busy === item.name}
              onClick={() => connect(item.name)}
            >
              {busy === item.name
                ? __('Connecting…', 'gds-assistant')
                : __('Connect', 'gds-assistant')}
            </Button>
          )}
          {item.requires_oauth && item.connected && (
            <Button
              variant="link"
              isDestructive
              disabled={busy === item.name}
              onClick={() => disconnect(item.name)}
            >
              {__('Disconnect', 'gds-assistant')}
            </Button>
          )}
          {item.editable && (
            <Button
              variant="link"
              disabled={busy === item.name}
              onClick={() => setEditing(item)}
            >
              {__('Edit', 'gds-assistant')}
            </Button>
          )}
          {item.deletable && (
            <Button
              variant="link"
              isDestructive
              disabled={busy === item.name}
              onClick={() => remove(item.name)}
            >
              {__('Delete', 'gds-assistant')}
            </Button>
          )}
          {!item.requires_oauth && !item.editable && !item.deletable && (
            <span style={{color: '#999'}}>—</span>
          )}
        </div>
      ),
    },
  ];

  const view = {
    type: 'table',
    fields: ['label', 'url', 'auth_type', 'connected', 'actions'],
    layout: {},
  };

  return (
    <>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: 16,
          gap: 16,
        }}
      >
        <p className="description" style={{flex: 1, margin: 0}}>
          {__(
            'Remote MCP servers whose tools are available in the assistant. Add via this UI, or configure in code via the gds-assistant/mcp_servers filter or GDS_ASSISTANT_MCP_SERVERS env var. OAuth connections are per-user.',
            'gds-assistant',
          )}
        </p>
        <Button variant="primary" onClick={() => setEditing({})}>
          {__('Add MCP Server', 'gds-assistant')}
        </Button>
      </div>

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
            'No MCP servers yet. Click "Add MCP Server" above to configure one (e.g. Asana at https://mcp.asana.com/v2/mcp with OAuth).',
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

      {editing && (
        <ServerModal
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            const wasEdit = !!editing.name;
            setEditing(null);
            setNotice({
              type: 'success',
              text: wasEdit
                ? __('Server updated.', 'gds-assistant')
                : __('Server added.', 'gds-assistant'),
            });
            load();
          }}
        />
      )}
    </>
  );
}

function OriginBadge({origin}) {
  if (!origin || origin === 'admin') return null;
  const label =
    origin === 'code'
      ? __('code', 'gds-assistant')
      : origin === 'env'
        ? __('env', 'gds-assistant')
        : origin === 'builtin'
          ? __('built-in', 'gds-assistant')
          : origin;
  return (
    <span
      style={{
        fontSize: 10,
        padding: '1px 6px',
        borderRadius: 3,
        background: '#eee',
        color: '#555',
        marginLeft: 6,
        verticalAlign: 'middle',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
      }}
      title={__(
        'This server is configured outside the UI and can\'t be edited here.',
        'gds-assistant',
      )}
    >
      {label}
    </span>
  );
}

function ServerModal({initial, onClose, onSaved}) {
  // initial = {} for add, or a server row (with auth_detail) for edit.
  const isEdit = !!initial?.name;
  const detail = initial?.auth_detail || {};

  const [name, setName] = useState(initial?.name || '');
  const [label, setLabel] = useState(initial?.label || '');
  const [url, setUrl] = useState(initial?.url || '');
  const [authType, setAuthType] = useState(
    initial?.auth_type || detail.type || 'oauth',
  );
  const [scopes, setScopes] = useState(
    Array.isArray(detail.scopes) ? detail.scopes.join(' ') : '',
  );
  const [envName, setEnvName] = useState(detail.env || '');
  const [clientId, setClientId] = useState(detail.client_id || '');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Callback URL for this server-to-be. Shown so admins can copy it into
  // the OAuth provider's redirect-URI field when registering the app.
  const previewCallback = name
    ? `${window.location.origin}/wp-json/gds-assistant/v1/mcp/${name}/callback`
    : null;

  const save = async () => {
    setError(null);
    if (!name || !url) {
      setError(__('Name and URL are required.', 'gds-assistant'));
      return;
    }
    const auth = {type: authType};
    if (authType === 'oauth') {
      if (scopes.trim()) {
        auth.scopes = scopes
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean);
      }
      if (clientId.trim()) {
        auth.client_id = clientId.trim();
      }
      if (clientSecret.trim()) {
        auth.client_secret = clientSecret.trim();
      }
    }
    if (authType === 'bearer') {
      if (!envName) {
        setError(
          __('Env var name is required for bearer auth.', 'gds-assistant'),
        );
        return;
      }
      auth.env = envName;
    }

    setSaving(true);
    try {
      await apiFetch({
        path: '/gds-assistant/v1/mcp/servers',
        method: 'POST',
        data: {name, label: label || null, url, auth},
      });
      onSaved();
    } catch (e) {
      setError(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={
        isEdit
          ? __('Edit MCP Server', 'gds-assistant')
          : __('Add MCP Server', 'gds-assistant')
      }
      onRequestClose={onClose}
      style={{maxWidth: 600}}
    >
      {error && (
        <Notice status="error" isDismissible={false}>
          {error}
        </Notice>
      )}
      <TextControl
        label={__('Name (slug)', 'gds-assistant')}
        help={
          isEdit
            ? __(
                'Name cannot be changed — delete and re-add to rename.',
                'gds-assistant',
              )
            : __(
                'Lowercase identifier used internally. Example: "asana" or "jira".',
                'gds-assistant',
              )
        }
        value={name}
        onChange={(v) => setName(v.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
        disabled={isEdit}
        readOnly={isEdit}
      />
      <TextControl
        label={__('Label (optional)', 'gds-assistant')}
        help={__(
          'Human-readable display name. Defaults to the capitalized slug.',
          'gds-assistant',
        )}
        value={label}
        onChange={setLabel}
      />
      <TextControl
        label={__('URL', 'gds-assistant')}
        help={__(
          'Streamable HTTP MCP endpoint. Example: https://mcp.asana.com/v2/mcp',
          'gds-assistant',
        )}
        value={url}
        onChange={setUrl}
        type="url"
      />
      <SelectControl
        label={__('Authentication', 'gds-assistant')}
        value={authType}
        options={[
          {value: 'none', label: __('None (public)', 'gds-assistant')},
          {
            value: 'oauth',
            label: __('OAuth 2.1 + PKCE', 'gds-assistant'),
          },
          {
            value: 'bearer',
            label: __('Bearer token (static)', 'gds-assistant'),
          },
        ]}
        onChange={setAuthType}
      />
      {authType === 'oauth' && (
        <>
          <TextControl
            label={__('OAuth scopes (optional)', 'gds-assistant')}
            help={__(
              'Space or comma-separated list of scopes. Leave empty when the provider says not to send a scope parameter (e.g. Asana MCP apps).',
              'gds-assistant',
            )}
            value={scopes}
            onChange={setScopes}
            placeholder="default"
          />
          {previewCallback && (
            <p
              className="description"
              style={{margin: '4px 0 12px', fontSize: 12}}
            >
              {__('Register this redirect URI with the provider:', 'gds-assistant')}{' '}
              <code style={{fontSize: 11}}>{previewCallback}</code>
            </p>
          )}
          <TextControl
            label={__('Client ID (optional)', 'gds-assistant')}
            help={__(
              'Required for providers that don\'t support dynamic client registration (RFC 7591). Asana, for example, issues a client_id when you create an MCP app in their developer console. Leave empty to let the plugin register dynamically.',
              'gds-assistant',
            )}
            value={clientId}
            onChange={setClientId}
            autoComplete="off"
          />
          <TextControl
            label={__('Client Secret (optional)', 'gds-assistant')}
            help={
              detail.has_client_secret
                ? __(
                    'Leave empty to keep the existing secret. Encrypted at rest.',
                    'gds-assistant',
                  )
                : __(
                    'Paired with Client ID when the provider issues a confidential client. Encrypted at rest.',
                    'gds-assistant',
                  )
            }
            value={clientSecret}
            onChange={setClientSecret}
            type="password"
            autoComplete="off"
            placeholder={detail.has_client_secret ? '••••••••' : ''}
          />
        </>
      )}
      {authType === 'bearer' && (
        <TextControl
          label={__('Env var name', 'gds-assistant')}
          help={__(
            'Name of the environment variable holding the bearer token. Set it in .env — it\'s never stored in the database.',
            'gds-assistant',
          )}
          value={envName}
          onChange={(v) => setEnvName(v.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
          placeholder="INTERNAL_MCP_TOKEN"
        />
      )}
      <div style={{display: 'flex', gap: 8, marginTop: 16}}>
        <Button variant="primary" onClick={save} disabled={saving}>
          {saving
            ? __('Saving…', 'gds-assistant')
            : isEdit
              ? __('Update', 'gds-assistant')
              : __('Save', 'gds-assistant')}
        </Button>
        <Button variant="tertiary" onClick={onClose}>
          {__('Cancel', 'gds-assistant')}
        </Button>
      </div>
    </Modal>
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
