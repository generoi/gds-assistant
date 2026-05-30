import { DataViews, type Field, type View } from "@wordpress/dataviews";
import { useEntityRecords } from "@wordpress/core-data";
import { useState, useCallback, useRef } from "@wordpress/element";
import { __ } from "@wordpress/i18n";
import { pencil, trash, plus, download, upload } from "@wordpress/icons";
import { Button, Modal, SelectControl } from "@wordpress/components";
import apiFetch from "@wordpress/api-fetch";

// ── Types ──────────────────────────────────────────────────

/** Raw skill row as returned by `/wp/v2/assistant-skills` with `context=edit`. */
interface SkillRow {
  id: number;
  slug?: string;
  title?: { raw?: string; rendered?: string } | string;
  excerpt?: { raw?: string; rendered?: string };
  content?: { raw?: string; rendered?: string };
  meta?: {
    _assistant_model?: string;
    _assistant_schedule?: string;
  };
  date?: string;
}

/** Portable skill record used by Export / Import. */
interface ExportedSkill {
  title: string;
  slug: string;
  description: string;
  prompt: string;
  model: string;
}

interface EditingSkill {
  id: number;
  title: string;
  model: string;
  schedule: string;
}

// ── Helpers ─────────────────────────────────────────────────

/**
 * Convert a skill record to export format.
 * @param item
 */
function toExportFormat(item: SkillRow): ExportedSkill {
  const titleField = item.title;
  const title =
    typeof titleField === "string"
      ? titleField
      : titleField?.raw || titleField?.rendered || "";
  return {
    title,
    slug: item.slug || "",
    description:
      item.excerpt?.raw ||
      item.excerpt?.rendered?.replace(/<[^>]*>/g, "").trim() ||
      "",
    prompt:
      item.content?.raw ||
      item.content?.rendered?.replace(/<[^>]*>/g, "").trim() ||
      "",
    model: item.meta?._assistant_model || "",
  };
}

/**
 * Download JSON as a file.
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

// ── Fields ──────────────────────────────────────────────────

const FIELDS: Field<SkillRow>[] = [
  {
    id: "title",
    label: __("Title", "gds-assistant"),
    enableSorting: true,
    enableGlobalSearch: true,
    render: ({ item }) => {
      const t = item.title;
      const text = typeof t === "string" ? t : t?.rendered || t?.raw || "";
      return <strong>{text}</strong>;
    },
  },
  {
    id: "slug",
    label: __("Slash Command", "gds-assistant"),
    render: ({ item }) => <code>/{item.slug}</code>,
  },
  {
    id: "excerpt",
    label: __("Description", "gds-assistant"),
    enableGlobalSearch: true,
    render: ({ item }) => {
      const text =
        item.excerpt?.raw ||
        item.excerpt?.rendered?.replace(/<[^>]*>/g, "") ||
        "";
      return (
        <span>{text.length > 100 ? text.slice(0, 97) + "..." : text}</span>
      );
    },
  },
  {
    id: "model",
    label: __("Model", "gds-assistant"),
    render: ({ item }) => {
      const model = item.meta?._assistant_model || "";
      return model ? (
        <code>{model}</code>
      ) : (
        <span className="gds-assistant-muted">default</span>
      );
    },
  },
  {
    id: "schedule",
    label: __("Schedule", "gds-assistant"),
    render: ({ item }) => {
      const schedule = item.meta?._assistant_schedule || "";
      return schedule ? (
        <code>{schedule}</code>
      ) : (
        <span className="gds-assistant-muted">-</span>
      );
    },
  },
  {
    id: "date",
    label: __("Date", "gds-assistant"),
    type: "datetime",
    enableSorting: true,
    getValue: ({ item }) => item.date,
  },
];

const DEFAULT_VIEW: View = {
  type: "table",
  search: "",
  page: 1,
  perPage: 25,
  sort: { field: "title", direction: "asc" },
  filters: [],
  fields: ["title", "slug", "excerpt", "model", "schedule", "date"],
};

// ── Component ───────────────────────────────────────────────

export function SkillsDataView(): JSX.Element {
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [editingSkill, setEditingSkill] = useState<EditingSkill | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const queryArgs = {
    per_page: view.perPage,
    page: view.page,
    orderby: view.sort?.field || "title",
    order: view.sort?.direction || "asc",
    search: view.search || undefined,
    context: "edit",
    _embed: true,
    _refresh: refreshKey, // Cache-bust key to force refetch after mutations
  };

  const { records, totalItems, totalPages, isResolving } = useEntityRecords(
    "postType",
    "assistant_skill",
    queryArgs,
  );

  const handleDelete = useCallback(async (items: SkillRow[]) => {
    for (const item of items) {
      await apiFetch({
        path: `/wp/v2/assistant-skills/${item.id}?force=true`,
        method: "DELETE",
      });
    }
    setRefreshKey((k) => k + 1);
  }, []);

  // Export all skills
  const handleExportAll = useCallback(async () => {
    // apiFetch returns the parsed JSON body by default; cast to our row shape.
    const allSkills = (await apiFetch({
      path: "/wp/v2/assistant-skills?per_page=100&context=edit",
    })) as SkillRow[];
    const exported = allSkills.map(toExportFormat);
    downloadJson(exported, "gds-assistant-skills.json");
  }, []);

  // Export selected skills (single or bulk)
  const handleExport = useCallback((items: SkillRow[]) => {
    const exported = items.map(toExportFormat);
    const filename =
      items.length === 1
        ? `skill-${items[0]!.slug || items[0]!.id}.json`
        : `gds-assistant-skills-${items.length}.json`;
    downloadJson(exported, filename);
  }, []);

  // Import skills from JSON file
  const handleImport = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) {
        return;
      }

      try {
        const text = await file.text();
        const parsed: unknown = JSON.parse(text);
        // Support both single skill and array
        const skills: ExportedSkill[] = Array.isArray(parsed)
          ? (parsed as ExportedSkill[])
          : [parsed as ExportedSkill];

        let imported = 0;
        for (const skill of skills) {
          if (!skill.title || !skill.prompt) {
            continue;
          }

          await apiFetch({
            path: "/wp/v2/assistant-skills",
            method: "POST",
            data: {
              title: skill.title,
              slug: skill.slug || "",
              content: skill.prompt,
              excerpt: skill.description || "",
              status: "publish",
            },
          });
          imported++;
        }

        // eslint-disable-next-line no-alert
        window.alert(`Imported ${imported} skill${imported !== 1 ? "s" : ""}.`);
        setRefreshKey((k) => k + 1);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-alert
        window.alert(`Import failed: ${message}`);
      }

      // Reset file input
      e.target.value = "";
    },
    [],
  );

  const actions = [
    {
      id: "edit",
      label: __("Edit", "gds-assistant"),
      icon: pencil,
      isPrimary: true,
      callback: ([item]: SkillRow[]) => {
        window.location.href = `post.php?post=${item!.id}&action=edit`;
      },
    },
    {
      id: "settings",
      label: __("Model & Schedule", "gds-assistant"),
      callback: ([item]: SkillRow[]) => {
        const t = item!.title;
        const title = typeof t === "string" ? t : t?.raw || t?.rendered || "";
        setEditingSkill({
          id: item!.id,
          title,
          model: item!.meta?._assistant_model || "",
          schedule: item!.meta?._assistant_schedule || "",
        });
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
      <div
        style={{
          marginBottom: "16px",
          display: "flex",
          gap: "8px",
          alignItems: "center",
        }}
      >
        <Button
          variant="primary"
          icon={plus}
          href="post-new.php?post_type=assistant_skill"
        >
          {__("Add New Skill", "gds-assistant")}
        </Button>
        <Button variant="secondary" icon={download} onClick={handleExportAll}>
          {__("Export All", "gds-assistant")}
        </Button>
        <Button variant="secondary" icon={upload} onClick={handleImport}>
          {__("Import", "gds-assistant")}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          style={{ display: "none" }}
          onChange={handleFileChange}
        />
      </div>
      <DataViews
        data={(records as SkillRow[] | undefined) || []}
        fields={FIELDS}
        view={view}
        onChangeView={setView}
        paginationInfo={{
          totalItems: totalItems || 0,
          totalPages: totalPages || 1,
        }}
        isLoading={isResolving}
        actions={actions}
        getItemId={(item: SkillRow) => String(item.id)}
        defaultLayouts={{ table: {} }}
      />
      {editingSkill && (
        <SkillEditModal
          skill={editingSkill}
          onClose={() => setEditingSkill(null)}
          onSave={async (data) => {
            await apiFetch({
              path: `/wp/v2/assistant-skills/${data.id}`,
              method: "POST",
              data: {
                meta: {
                  _assistant_model: data.model,
                  _assistant_schedule: data.schedule,
                },
              },
            });
            setEditingSkill(null);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </>
  );
}

interface SkillEditModalProps {
  skill: EditingSkill;
  onClose: () => void;
  onSave: (data: EditingSkill) => Promise<void> | void;
}

function SkillEditModal({
  skill,
  onClose,
  onSave,
}: SkillEditModalProps): JSX.Element {
  const [model, setModel] = useState(skill.model);
  const [schedule, setSchedule] = useState(skill.schedule);
  const [saving, setSaving] = useState(false);

  const modelOptions: Array<{ label: string; value: string }> = [
    { label: __("Default (user selection)", "gds-assistant"), value: "" },
  ];
  // `models` lives on the window global; surface what we read here. (The
  // canonical shape is duplicated locally rather than augmenting the global
  // type to avoid coupling this file to other entry points.)
  const providers =
    (
      window.gdsAssistant as
        | {
            models?: {
              providers?: Array<{
                label: string;
                models?: Array<{ label: string; value: string }>;
              }>;
            };
          }
        | undefined
    )?.models?.providers || [];
  for (const provider of providers) {
    for (const m of provider.models || []) {
      modelOptions.push({
        label: `${provider.label}: ${m.label}`,
        value: m.value,
      });
    }
  }

  return (
    <Modal title={`Edit: ${skill.title}`} onRequestClose={onClose}>
      <SelectControl
        label={__("Model", "gds-assistant")}
        value={model}
        options={modelOptions}
        onChange={setModel}
      />
      {/* SelectControl narrows `value` to the literal-union of option values;
          our stored `schedule` is a plain string from REST so cast at the
          boundary rather than threading the literal union through state. */}
      <SelectControl
        label={__("Schedule", "gds-assistant")}
        value={schedule as "" | "hourly" | "daily" | "weekly"}
        options={[
          { label: __("None", "gds-assistant"), value: "" },
          { label: __("Hourly", "gds-assistant"), value: "hourly" },
          { label: __("Daily", "gds-assistant"), value: "daily" },
          { label: __("Weekly", "gds-assistant"), value: "weekly" },
        ]}
        onChange={setSchedule}
      />
      <div
        style={{
          marginTop: "16px",
          display: "flex",
          gap: "8px",
          justifyContent: "flex-end",
        }}
      >
        <Button variant="secondary" onClick={onClose}>
          {__("Cancel", "gds-assistant")}
        </Button>
        <Button
          variant="primary"
          isBusy={saving}
          onClick={async () => {
            setSaving(true);
            await onSave({ id: skill.id, title: skill.title, model, schedule });
            setSaving(false);
          }}
        >
          {__("Save", "gds-assistant")}
        </Button>
      </div>
    </Modal>
  );
}
