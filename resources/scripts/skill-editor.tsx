// `@wordpress/editor` + `@wordpress/plugins` ship typings under
// @types/wordpress__editor / @types/wordpress__plugins, but those packages
// drag in their own @wordpress/components / media-utils peer trees that
// resolve to different transitive versions on CI vs local, breaking
// `npm ci`. The runtime modules are externalised by webpack from
// `window.wp.*` anyway — declare the narrow surface we use in
// `types/wp-editor.d.ts`.
import { PluginDocumentSettingPanel } from "@wordpress/editor";
import { SelectControl } from "@wordpress/components";
import { useEntityProp } from "@wordpress/core-data";
import { useSelect } from "@wordpress/data";
import { registerPlugin } from "@wordpress/plugins";
import { __ } from "@wordpress/i18n";

interface SkillMeta {
  _assistant_model?: string;
  _assistant_schedule?: string;
}

interface SkillModelProvider {
  label: string;
  models?: Array<{ label: string; value: string }>;
}

declare global {
  interface Window {
    gdsAssistantSkill?: { models?: SkillModelProvider[] };
  }
}

function SkillSettingsPanel(): JSX.Element | null {
  // `useSelect` from @wordpress/data is generic; the local block-editor store
  // typings are loose, so the callback param is `any`. Cast inside the lambda
  // so the call-site reads cleanly.
  const postType = useSelect(
    (select) =>
      (
        select("core/editor") as { getCurrentPostType?: () => string }
      ).getCurrentPostType?.(),
    [],
  );

  const [meta, setMeta] = useEntityProp("postType", "assistant_skill", "meta");
  const skillMeta = (meta as SkillMeta | undefined) || {};

  if (postType !== "assistant_skill") {
    return null;
  }

  const model = skillMeta._assistant_model || "";
  const schedule = skillMeta._assistant_schedule || "";

  // `SelectControl` types its `label` field as a branded `TranslatableText`
  // (since WP 6.7) and its `value`/`options[].value` as a literal union per
  // option array. Both `__()` and our dynamic provider list yield plain
  // `string`s, so we cast at the option-array boundary — the runtime is
  // happy with strings on every supported WP release.
  type SelectOption = { label: string; value: string };
  const modelOptions: SelectOption[] = [
    { label: __("Default (user selection)", "gds-assistant"), value: "" },
  ];

  const providers = window.gdsAssistantSkill?.models || [];
  for (const provider of providers) {
    for (const m of provider.models || []) {
      modelOptions.push({
        label: `${provider.label}: ${m.label}`,
        value: m.value,
      });
    }
  }

  const scheduleOptions: SelectOption[] = [
    { label: __("None", "gds-assistant"), value: "" },
    { label: __("Hourly", "gds-assistant"), value: "hourly" },
    { label: __("Daily", "gds-assistant"), value: "daily" },
    { label: __("Weekly", "gds-assistant"), value: "weekly" },
  ];

  return (
    <PluginDocumentSettingPanel
      name="gds-assistant-skill-settings"
      title={__("Skill Settings", "gds-assistant")}
    >
      <SelectControl
        label={__("Model", "gds-assistant")}
        value={model}
        options={modelOptions as never}
        onChange={(value) =>
          setMeta({ ...skillMeta, _assistant_model: value as string })
        }
      />
      <SelectControl
        label={__("Schedule", "gds-assistant")}
        value={schedule}
        options={scheduleOptions as never}
        onChange={(value) =>
          setMeta({ ...skillMeta, _assistant_schedule: value as string })
        }
      />
    </PluginDocumentSettingPanel>
  );
}

registerPlugin("gds-assistant-skill-settings", {
  render: SkillSettingsPanel,
});
