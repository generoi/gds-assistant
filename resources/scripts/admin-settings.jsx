import domReady from '@wordpress/dom-ready';
import {createRoot} from '@wordpress/element';
import {MemoryDataView} from './components/memory-dataview';
import {SkillsDataView} from './components/skills-dataview';
import {ConversationsDataView} from './components/conversations-dataview';
import '../styles/admin-settings.css';

domReady(() => {
  const memoryContainer = document.getElementById(
    'gds-assistant-memory-dataview',
  );
  if (memoryContainer) {
    const root = createRoot(memoryContainer);
    root.render(<MemoryDataView />);
  }

  const skillsContainer = document.getElementById(
    'gds-assistant-skills-dataview',
  );
  if (skillsContainer) {
    const root = createRoot(skillsContainer);
    root.render(<SkillsDataView />);
  }

  const conversationsContainer = document.getElementById(
    'gds-assistant-conversations-dataview',
  );
  if (conversationsContainer) {
    const root = createRoot(conversationsContainer);
    root.render(<ConversationsDataView />);
  }
});
