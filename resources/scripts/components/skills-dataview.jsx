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
    render: ({item}) => (
      <strong>{item.title?.rendered || item.title}</strong>
    ),
  },
  {
    id: 'slug',
    label: __('Slash Command', 'gds-assistant'),
    render: ({item}) => (
      <code>/{item.slug}</code>
    ),
  },
  {
    id: 'excerpt',
    label: __('Description', 'gds-assistant'),
    enableGlobalSearch: true,
    render: ({item}) => {
      const text =
        item.excerpt?.raw ||
        item.excerpt?.rendered?.replace(/<[^>]*>/g, '') ||
        '';
      return <span>{text.length > 100 ? text.slice(0, 97) + '...' : text}</span>;
    },
  },
  {
    id: 'model',
    label: __('Model', 'gds-assistant'),
    render: ({item}) => {
      const model = item.meta?._assistant_model || '';
      return model ? <code>{model}</code> : <span className="gds-assistant-muted">default</span>;
    },
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
  sort: {field: 'title', direction: 'asc'},
  filters: [],
  fields: ['title', 'slug', 'excerpt', 'model', 'date'],
};

export function SkillsDataView() {
  const [view, setView] = useState(DEFAULT_VIEW);

  const queryArgs = {
    per_page: view.perPage,
    page: view.page,
    orderby: view.sort?.field || 'title',
    order: view.sort?.direction || 'asc',
    search: view.search || undefined,
    context: 'edit',
    _embed: true,
  };

  const {records, totalItems, totalPages, isResolving} = useEntityRecords(
    'postType',
    'assistant_skill',
    queryArgs,
  );

  const handleDelete = useCallback(async (items) => {
    for (const item of items) {
      await apiFetch({
        path: `/wp/v2/assistant-skills/${item.id}?force=true`,
        method: 'DELETE',
      });
    }
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
          href="post-new.php?post_type=assistant_skill"
        >
          {__('Add New Skill', 'gds-assistant')}
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
