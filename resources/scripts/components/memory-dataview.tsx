import {
  DataViews,
  type View,
  type Operator,
  type Field,
} from "@wordpress/dataviews";
import { useEntityRecords } from "@wordpress/core-data";
import { useState, useCallback } from "@wordpress/element";
import { __ } from "@wordpress/i18n";
import { pencil, trash, plus } from "@wordpress/icons";
import { Button } from "@wordpress/components";
import apiFetch from "@wordpress/api-fetch";

/** A row in `assistant_memory` as fetched from `/wp/v2/assistant-memory`. */
interface MemoryRecord {
  id: number;
  title?: { rendered?: string } | string;
  content?: { raw?: string; rendered?: string };
  meta?: { _memory_source?: "auto" | "manual" };
  date?: string;
}

interface FieldRenderArgs {
  item: MemoryRecord;
}

const FIELDS: Field<MemoryRecord>[] = [
  {
    id: "title",
    label: __("Title", "gds-assistant"),
    enableSorting: true,
    enableGlobalSearch: true,
    render: ({ item }: FieldRenderArgs) => (
      <strong>
        {typeof item.title === "string"
          ? item.title
          : item.title?.rendered || ""}
      </strong>
    ),
  },
  {
    id: "content",
    label: __("Content", "gds-assistant"),
    enableGlobalSearch: true,
    render: ({ item }: FieldRenderArgs) => {
      const text =
        item.content?.raw ||
        item.content?.rendered?.replace(/<[^>]*>/g, "") ||
        "";
      return (
        <span>{text.length > 120 ? text.slice(0, 117) + "..." : text}</span>
      );
    },
  },
  {
    id: "source",
    label: __("Source", "gds-assistant"),
    render: ({ item }: FieldRenderArgs) => {
      const source = item.meta?._memory_source || "manual";
      return (
        <span className={`gds-assistant-badge gds-assistant-badge--${source}`}>
          {source}
        </span>
      );
    },
    elements: [
      { value: "auto", label: __("Auto-learned", "gds-assistant") },
      { value: "manual", label: __("Manual", "gds-assistant") },
    ],
    filterBy: { operators: ["isAny"] as Operator[] },
  },
  {
    id: "date",
    label: __("Date", "gds-assistant"),
    type: "datetime",
    enableSorting: true,
    getValue: ({ item }: FieldRenderArgs) => item.date,
  },
];

const DEFAULT_VIEW: View = {
  type: "table",
  search: "",
  page: 1,
  perPage: 25,
  sort: { field: "date", direction: "desc" },
  filters: [],
  fields: ["title", "content", "source", "date"],
};

export function MemoryDataView(): JSX.Element {
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [refreshKey, setRefreshKey] = useState(0);

  const queryArgs = {
    per_page: view.perPage,
    page: view.page,
    orderby: view.sort?.field || "date",
    order: view.sort?.direction || "desc",
    search: view.search || undefined,
    context: "edit",
    _embed: true,
    _refresh: refreshKey,
  };

  const { records, totalItems, totalPages, isResolving } = useEntityRecords(
    "postType",
    "assistant_memory",
    queryArgs,
  );

  const handleDelete = useCallback(async (items: MemoryRecord[]) => {
    for (const item of items) {
      await apiFetch({
        path: `/wp/v2/assistant-memory/${item.id}?force=true`,
        method: "DELETE",
      });
    }
    setRefreshKey((k) => k + 1);
  }, []);

  const actions = [
    {
      id: "edit",
      label: __("Edit", "gds-assistant"),
      icon: pencil,
      isPrimary: true,
      callback: ([item]: MemoryRecord[]) => {
        window.location.href = `post.php?post=${item!.id}&action=edit`;
      },
    },
    {
      id: "delete",
      label: __("Delete", "gds-assistant"),
      icon: trash,
      isDestructive: true,
      supportsBulk: true,
      callback: handleDelete,
    },
  ];

  return (
    <>
      <div style={{ marginBottom: "16px" }}>
        <Button
          variant="primary"
          icon={plus}
          href="post-new.php?post_type=assistant_memory"
        >
          {__("Add Memory", "gds-assistant")}
        </Button>
      </div>
      <DataViews
        data={(records as MemoryRecord[] | undefined) || []}
        fields={FIELDS}
        view={view}
        onChangeView={setView}
        paginationInfo={{
          totalItems: totalItems || 0,
          totalPages: totalPages || 1,
        }}
        isLoading={isResolving}
        actions={actions}
        getItemId={(item: MemoryRecord) => String(item.id)}
        defaultLayouts={{ table: {} }}
      />
    </>
  );
}
