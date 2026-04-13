import {DataViews} from '@wordpress/dataviews';
import {useState, useEffect, useCallback} from '@wordpress/element';
import {__} from '@wordpress/i18n';
import {backup, external} from '@wordpress/icons';
import apiFetch from '@wordpress/api-fetch';

/**
 * Format relative time.
 *
 * @param {string} dateStr Date string.
 * @return {string} Formatted time.
 */
function timeAgo(dateStr) {
  const date = new Date(dateStr + 'Z');
  const now = new Date();
  const diffMin = Math.floor((now - date) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Estimate cost from tokens.
 *
 * @param {number} input  Input tokens.
 * @param {number} output Output tokens.
 * @return {string} Formatted cost.
 */
function estimateCost(input, output) {
  const cost = (input / 1e6) * 3 + (output / 1e6) * 15;
  if (cost < 0.001) return '<$0.001';
  return `~$${cost.toFixed(3)}`;
}

const FIELDS = [
  {
    id: 'title',
    label: __('Title', 'gds-assistant'),
    enableGlobalSearch: true,
    enableSorting: true,
    render: ({item}) => <strong>{item.title || 'Untitled'}</strong>,
  },
  {
    id: 'model',
    label: __('Model', 'gds-assistant'),
    render: ({item}) => <code>{item.model || '—'}</code>,
  },
  {
    id: 'tokens',
    label: __('Tokens', 'gds-assistant'),
    render: ({item}) => {
      const input = Number(item.total_input_tokens) || 0;
      const output = Number(item.total_output_tokens) || 0;
      if (!input && !output) return '—';
      return `${(input + output).toLocaleString()}`;
    },
  },
  {
    id: 'cost',
    label: __('Cost', 'gds-assistant'),
    render: ({item}) => {
      const input = Number(item.total_input_tokens) || 0;
      const output = Number(item.total_output_tokens) || 0;
      if (!input && !output) return '—';
      return estimateCost(input, output);
    },
  },
  {
    id: 'updated_at',
    label: __('Last active', 'gds-assistant'),
    enableSorting: true,
    getValue: ({item}) => item.updated_at,
    render: ({item}) => timeAgo(item.updated_at),
  },
];

const DEFAULT_VIEW = {
  type: 'table',
  search: '',
  page: 1,
  perPage: 25,
  sort: {field: 'updated_at', direction: 'desc'},
  filters: [],
  fields: ['title', 'model', 'tokens', 'cost', 'updated_at'],
};

export function ConversationsDataView() {
  const [view, setView] = useState(DEFAULT_VIEW);
  const [data, setData] = useState([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await apiFetch({
        path: '/gds-assistant/v1/conversations',
        parse: false,
      });
      const items = await response.json();
      setData(items);
      setTotal(items.length);
    } catch {
      setData([]);
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleArchive = useCallback(
    async (items) => {
      for (const item of items) {
        await apiFetch({
          path: `/gds-assistant/v1/conversations/${item.uuid}`,
          method: 'POST',
          data: {archived: true},
        });
      }
      fetchData();
    },
    [fetchData],
  );

  const actions = [
    {
      id: 'resume',
      label: __('Resume', 'gds-assistant'),
      icon: external,
      isPrimary: true,
      callback: ([item]) => {
        // Store the conversation UUID so the chat widget picks it up on next page
        localStorage.setItem('gds-assistant-resume', item.uuid);
        // Chat widget is on this page too — trigger it directly
        window.dispatchEvent(
          new CustomEvent('gds-assistant-resume', {detail: {uuid: item.uuid}}),
        );
      },
    },
    {
      id: 'archive',
      label: __('Archive', 'gds-assistant'),
      icon: backup,
      supportsBulk: true,
      callback: handleArchive,
    },
  ];

  // Client-side sorting and pagination since API returns all
  const sorted = [...data].sort((a, b) => {
    const field = view.sort?.field || 'updated_at';
    const dir = view.sort?.direction === 'asc' ? 1 : -1;
    const aVal = a[field] || '';
    const bVal = b[field] || '';
    return (
      aVal > bVal ? dir
      : aVal < bVal ? -dir
      : 0
    );
  });

  const start = (view.page - 1) * view.perPage;
  const paged = sorted.slice(start, start + view.perPage);
  const totalPages = Math.ceil(total / view.perPage);

  return (
    <DataViews
      data={paged}
      fields={FIELDS}
      view={view}
      onChangeView={setView}
      paginationInfo={{totalItems: total, totalPages}}
      isLoading={isLoading}
      actions={actions}
      getItemId={(item) => item.uuid}
      defaultLayouts={{table: {}}}
    />
  );
}
