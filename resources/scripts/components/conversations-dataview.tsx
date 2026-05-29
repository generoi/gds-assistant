import { DataViews, type Field, type View } from "@wordpress/dataviews";
import { useState, useEffect, useCallback } from "@wordpress/element";
import { __ } from "@wordpress/i18n";
import { backup, external, download } from "@wordpress/icons";
import apiFetch from "@wordpress/api-fetch";

interface ConversationRow {
  uuid: string;
  title?: string;
  user_name?: string;
  model?: string;
  total_input_tokens?: number | string;
  total_output_tokens?: number | string;
  updated_at?: string;
  [key: string]: unknown;
}

/**
 * Trigger a client-side JSON file download.
 * @param data
 * @param filename
 */
function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Format relative time.
 * @param dateStr
 */
function timeAgo(dateStr: string | undefined): string {
  if (!dateStr) {
    return "—";
  }
  const date = new Date(dateStr + "Z");
  const now = new Date();
  const diffMin = Math.floor((now.getTime() - date.getTime()) / 60000);
  if (diffMin < 1) {
    return "just now";
  }
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) {
    return `${diffHr}h ago`;
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Estimate cost from tokens using full input price (no cache breakdown
 * available in stored history). Over-estimates slightly since real cost
 * had cache discounts, but is the safest approximation.
 * @param input
 * @param output
 * @param model
 */
function estimateCost(
  input: number,
  output: number,
  model: string | undefined,
): string {
  const pricing = window.gdsAssistant?.modelPricing?.[model || ""] || [3, 15];
  const cost = (input / 1e6) * pricing[0]! + (output / 1e6) * pricing[1]!;
  if (cost < 0.001) {
    return "<$0.001";
  }
  return `~$${cost.toFixed(3)}`;
}

const FIELDS: Field<ConversationRow>[] = [
  {
    id: "title",
    label: __("Title", "gds-assistant"),
    enableGlobalSearch: true,
    enableSorting: true,
    render: ({ item }) => (
      <button
        type="button"
        style={{
          all: "unset",
          cursor: "pointer",
          fontWeight: 600,
        }}
        onClick={() => {
          localStorage.setItem("gds-assistant-resume", item.uuid);
          window.dispatchEvent(
            new CustomEvent("gds-assistant-resume", {
              detail: { uuid: item.uuid },
            }),
          );
        }}
      >
        {item.title || "Untitled"}
      </button>
    ),
  },
  {
    id: "user_name",
    label: __("User", "gds-assistant"),
    render: ({ item }) => <>{item.user_name || "—"}</>,
  },
  {
    id: "model",
    label: __("Model", "gds-assistant"),
    render: ({ item }) => <code>{item.model || "—"}</code>,
  },
  {
    id: "tokens",
    label: __("Tokens", "gds-assistant"),
    render: ({ item }) => {
      const input = Number(item.total_input_tokens) || 0;
      const output = Number(item.total_output_tokens) || 0;
      if (!input && !output) {
        return <>—</>;
      }
      return <>{(input + output).toLocaleString()}</>;
    },
  },
  {
    id: "cost",
    label: __("Cost", "gds-assistant"),
    render: ({ item }) => {
      const input = Number(item.total_input_tokens) || 0;
      const output = Number(item.total_output_tokens) || 0;
      if (!input && !output) {
        return <>—</>;
      }
      return <>{estimateCost(input, output, item.model)}</>;
    },
  },
  {
    id: "updated_at",
    label: __("Last active", "gds-assistant"),
    enableSorting: true,
    getValue: ({ item }) => item.updated_at,
    render: ({ item }) => <>{timeAgo(item.updated_at)}</>,
  },
];

const DEFAULT_VIEW: View = {
  type: "table",
  search: "",
  page: 1,
  perPage: 25,
  sort: { field: "updated_at", direction: "desc" },
  filters: [],
  fields: ["title", "user_name", "model", "tokens", "cost", "updated_at"],
};

export function ConversationsDataView(): JSX.Element {
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [data, setData] = useState<ConversationRow[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = (await apiFetch({
        path: "/gds-assistant/v1/conversations?all=1",
        parse: false,
      })) as Response;
      const items = (await response.json()) as ConversationRow[];
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
    async (items: ConversationRow[]) => {
      for (const item of items) {
        await apiFetch({
          path: `/gds-assistant/v1/conversations/${item.uuid}`,
          method: "POST",
          data: { archived: true },
        });
      }
      fetchData();
    },
    [fetchData],
  );

  // Export full conversation(s) — including messages — as JSON. Fetches each
  // selected conversation's detail so the export is self-contained (the list
  // rows only carry metadata).
  const handleExport = useCallback(async (items: ConversationRow[]) => {
    const full: unknown[] = [];
    for (const item of items) {
      try {
        const response = (await apiFetch({
          path: `/gds-assistant/v1/conversations/${item.uuid}`,
          parse: false,
        })) as Response;
        full.push(await response.json());
      } catch {
        // Skip a conversation that fails to load rather than aborting.
      }
    }
    if (!full.length) {
      return;
    }
    const filename =
      full.length === 1
        ? `conversation-${(full[0] as { uuid?: string }).uuid}.json`
        : "gds-assistant-conversations.json";
    downloadJson(full, filename);
  }, []);

  const actions = [
    {
      id: "resume",
      label: __("Resume", "gds-assistant"),
      icon: external,
      isPrimary: true,
      callback: ([item]: ConversationRow[]) => {
        // Store the conversation UUID so the chat widget picks it up on next page
        localStorage.setItem("gds-assistant-resume", item!.uuid);
        // Chat widget is on this page too — trigger it directly
        window.dispatchEvent(
          new CustomEvent("gds-assistant-resume", {
            detail: { uuid: item!.uuid },
          }),
        );
      },
    },
    {
      id: "export",
      label: __("Export", "gds-assistant"),
      icon: download,
      supportsBulk: true,
      callback: handleExport,
    },
    {
      id: "archive",
      label: __("Archive", "gds-assistant"),
      icon: backup,
      supportsBulk: true,
      callback: handleArchive,
    },
  ];

  // Client-side sorting and pagination since API returns all
  const sorted = [...data].sort((a, b) => {
    const field = (view.sort?.field as keyof ConversationRow) || "updated_at";
    const dir = view.sort?.direction === "asc" ? 1 : -1;
    const aVal = (a[field] as unknown as string) || "";
    const bVal = (b[field] as unknown as string) || "";
    if (aVal > bVal) {
      return dir;
    }
    if (aVal < bVal) {
      return -dir;
    }
    return 0;
  });

  const start = ((view.page || 1) - 1) * (view.perPage || 25);
  const paged = sorted.slice(start, start + (view.perPage || 25));
  const totalPages = Math.ceil(total / (view.perPage || 25));

  return (
    <DataViews
      data={paged}
      fields={FIELDS}
      view={view}
      onChangeView={setView}
      paginationInfo={{ totalItems: total, totalPages }}
      isLoading={isLoading}
      actions={actions}
      getItemId={(item) => item.uuid}
      defaultLayouts={{ table: {} }}
    />
  );
}
