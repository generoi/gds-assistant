import {DataViews} from '@wordpress/dataviews';
import {useEntityRecords} from '@wordpress/core-data';
import {useState, useCallback} from '@wordpress/element';
import {__} from '@wordpress/i18n';
import {edit, trash, plus} from '@wordpress/icons';
import {Button} from '@wordpress/components';
import apiFetch from '@wordpress/api-fetch';

const FIELDS = [
  {
    id: 'title',
    label: __('Title', 'gds-assistant'),
    enableSorting: true,
    enableGlobalSearch: true,
    render: ({item}) => <strong>{item.title?.rendered || item.title}</strong>,
  },
  {
    id: 'content',
    label: __('Content', 'gds-assistant'),
    enableGlobalSearch: true,
    render: ({item}) => {
      const text =
        item.content?.raw ||
        item.content?.rendered?.replace(/<[^>]*>/g, '') ||
        '';
      return (
        <span>{text.length > 120 ? text.slice(0, 117) + '...' : text}</span>
      );
    },
  },
  {
    id: 'source',
    label: __('Source', 'gds-assistant'),
    render: ({item}) => {
      const source = item.meta?._memory_source || 'manual';
      return (
        <span className={`gds-assistant-badge gds-assistant-badge--${source}`}>
          {source}
        </span>
      );
    },
    elements: [
      {value: 'auto', label: __('Auto-learned', 'gds-assistant')},
      {value: 'manual', label: __('Manual', 'gds-assistant')},
    ],
    filterBy: {operators: ['isAny']},
  },
  {
    id: 'date',
    label: __('Date', 'gds-assistant'),
    type: 'datetime',
    enableSorting: true,
    getValue: ({item}) => item.date,
  },
];

const DEFAULT_VIEW = {
  type: 'table',
  search: '',
  page: 1,
  perPage: 25,
  sort: {field: 'date', direction: 'desc'},
  filters: [],
  fields: ['title', 'content', 'source', 'date'],
};

export function MemoryDataView() {
  const [view, setView] = useState(DEFAULT_VIEW);

  const queryArgs = {
    per_page: view.perPage,
    page: view.page,
    orderby: view.sort?.field || 'date',
    order: view.sort?.direction || 'desc',
    search: view.search || undefined,
    context: 'edit',
    _embed: true,
  };

  const {records, totalItems, totalPages, isResolving} = useEntityRecords(
    'postType',
    'assistant_memory',
    queryArgs,
  );

  const handleDelete = useCallback(async (items) => {
    for (const item of items) {
      await apiFetch({
        path: `/wp/v2/assistant-memory/${item.id}?force=true`,
        method: 'DELETE',
      });
    }
    // Trigger re-fetch
    setView((v) => ({...v}));
  }, []);

  const actions = [
    {
      id: 'edit',
      label: __('Edit', 'gds-assistant'),
      icon: edit,
      isPrimary: true,
      callback: ([item]) => {
        window.location.href = `post.php?post=${item.id}&action=edit`;
      },
    },
    {
      id: 'delete',
      label: __('Delete', 'gds-assistant'),
      icon: trash,
      isDestructive: true,
      supportsBulk: true,
      callback: handleDelete,
    },
  ];

  return (
    <>
      <div style={{marginBottom: '16px'}}>
        <Button
          variant="primary"
          icon={plus}
          href="post-new.php?post_type=assistant_memory"
        >
          {__('Add Memory', 'gds-assistant')}
        </Button>
      </div>
      <DataViews
        data={records || []}
        fields={FIELDS}
        view={view}
        onChangeView={setView}
        paginationInfo={{
          totalItems: totalItems || 0,
          totalPages: totalPages || 1,
        }}
        isLoading={isResolving}
        actions={actions}
        getItemId={(item) => String(item.id)}
        defaultLayouts={{table: {}}}
      />
    </>
  );
}
