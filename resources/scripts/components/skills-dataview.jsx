import {DataViews} from '@wordpress/dataviews';
import {useEntityRecords} from '@wordpress/core-data';
import {useState, useCallback, useRef} from '@wordpress/element';
import {__} from '@wordpress/i18n';
import {edit, trash, plus, download, upload} from '@wordpress/icons';
import {Button} from '@wordpress/components';
import apiFetch from '@wordpress/api-fetch';

// ── Helpers ─────────────────────────────────────────────────

/**
 * Convert a skill record to export format.
 *
 * @param {Object} item Skill record from REST API.
 * @return {Object} Portable skill object.
 */
function toExportFormat(item) {
  return {
    title: item.title?.raw || item.title?.rendered || item.title || '',
    slug: item.slug || '',
    description:
      item.excerpt?.raw ||
      item.excerpt?.rendered?.replace(/<[^>]*>/g, '').trim() ||
      '',
    prompt:
      item.content?.raw ||
      item.content?.rendered?.replace(/<[^>]*>/g, '').trim() ||
      '',
    model: item.meta?._assistant_model || '',
  };
}

/**
 * Download JSON as a file.
 *
 * @param {Object|Array} data     Data to export.
 * @param {string}       filename Filename.
 */
function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Fields ──────────────────────────────────────────────────

const FIELDS = [
  {
    id: 'title',
    label: __('Title', 'gds-assistant'),
    enableSorting: true,
    enableGlobalSearch: true,
    render: ({item}) => <strong>{item.title?.rendered || item.title}</strong>,
  },
  {
    id: 'slug',
    label: __('Slash Command', 'gds-assistant'),
    render: ({item}) => <code>/{item.slug}</code>,
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
      return (
        <span>{text.length > 100 ? text.slice(0, 97) + '...' : text}</span>
      );
    },
  },
  {
    id: 'model',
    label: __('Model', 'gds-assistant'),
    render: ({item}) => {
      const model = item.meta?._assistant_model || '';
      return model ?
          <code>{model}</code>
        : <span className="gds-assistant-muted">default</span>;
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

// ── Component ───────────────────────────────────────────────

export function SkillsDataView() {
  const [view, setView] = useState(DEFAULT_VIEW);
  const fileInputRef = useRef(null);

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

  // Export all skills
  const handleExportAll = useCallback(async () => {
    const allSkills = await apiFetch({
      path: '/wp/v2/assistant-skills?per_page=100&context=edit',
    });
    const exported = allSkills.map(toExportFormat);
    downloadJson(exported, 'gds-assistant-skills.json');
  }, []);

  // Export selected skills (single or bulk)
  const handleExport = useCallback((items) => {
    const exported = items.map(toExportFormat);
    const filename =
      items.length === 1 ?
        `skill-${items[0].slug || items[0].id}.json`
      : `gds-assistant-skills-${items.length}.json`;
    downloadJson(exported, filename);
  }, []);

  // Import skills from JSON file
  const handleImport = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      let skills = JSON.parse(text);

      // Support both single skill and array
      if (!Array.isArray(skills)) {
        skills = [skills];
      }

      let imported = 0;
      for (const skill of skills) {
        if (!skill.title || !skill.prompt) continue;

        await apiFetch({
          path: '/wp/v2/assistant-skills',
          method: 'POST',
          data: {
            title: skill.title,
            slug: skill.slug || '',
            content: skill.prompt,
            excerpt: skill.description || '',
            status: 'publish',
          },
        });
        imported++;
      }

      // eslint-disable-next-line no-alert
      window.alert(`Imported ${imported} skill${imported !== 1 ? 's' : ''}.`);
      setView((v) => ({...v})); // Refresh
    } catch (err) {
      // eslint-disable-next-line no-alert
      window.alert(`Import failed: ${err.message}`);
    }

    // Reset file input
    e.target.value = '';
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
      id: 'export',
      label: __('Export', 'gds-assistant'),
      icon: download,
      supportsBulk: true,
      callback: handleExport,
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
      <div
        style={{
          marginBottom: '16px',
          display: 'flex',
          gap: '8px',
          alignItems: 'center',
        }}
      >
        <Button
          variant="primary"
          icon={plus}
          href="post-new.php?post_type=assistant_skill"
        >
          {__('Add New Skill', 'gds-assistant')}
        </Button>
        <Button variant="secondary" icon={download} onClick={handleExportAll}>
          {__('Export All', 'gds-assistant')}
        </Button>
        <Button variant="secondary" icon={upload} onClick={handleImport}>
          {__('Import', 'gds-assistant')}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          style={{display: 'none'}}
          onChange={handleFileChange}
        />
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
