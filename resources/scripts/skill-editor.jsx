import {PluginDocumentSettingPanel} from '@wordpress/editor';
import {SelectControl} from '@wordpress/components';
import {useEntityProp} from '@wordpress/core-data';
import {useSelect} from '@wordpress/data';
import {registerPlugin} from '@wordpress/plugins';
import {__} from '@wordpress/i18n';

function SkillSettingsPanel() {
  const postType = useSelect(
    (select) => select('core/editor').getCurrentPostType(),
    [],
  );

  const [meta, setMeta] = useEntityProp('postType', 'assistant_skill', 'meta');

  if (postType !== 'assistant_skill') {
    return null;
  }

  const model = meta?._assistant_model || '';
  const schedule = meta?._assistant_schedule || '';

  const modelOptions = [
    {label: __('Default (user selection)', 'gds-assistant'), value: ''},
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

  return (
    <PluginDocumentSettingPanel
      name="gds-assistant-skill-settings"
      title={__('Skill Settings', 'gds-assistant')}
    >
      <SelectControl
        label={__('Model', 'gds-assistant')}
        value={model}
        options={modelOptions}
        onChange={(value) => setMeta({...meta, _assistant_model: value})}
      />
      <SelectControl
        label={__('Schedule', 'gds-assistant')}
        value={schedule}
        options={[
          {label: __('None', 'gds-assistant'), value: ''},
          {label: __('Hourly', 'gds-assistant'), value: 'hourly'},
          {label: __('Daily', 'gds-assistant'), value: 'daily'},
          {label: __('Weekly', 'gds-assistant'), value: 'weekly'},
        ]}
        onChange={(value) => setMeta({...meta, _assistant_schedule: value})}
      />
    </PluginDocumentSettingPanel>
  );
}

registerPlugin('gds-assistant-skill-settings', {
  render: SkillSettingsPanel,
});
