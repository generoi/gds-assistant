import {createRoot} from '@wordpress/element';
import '../styles/admin-chat.css';
import {App} from './app';
// Side-effect import: registers the `editor.BlockEdit` filter that adds an "AI
// assistant" dropdown to the default Gutenberg block toolbar.
import './editor/block-toolbar-actions';

document.addEventListener('DOMContentLoaded', () => {
  const container = document.createElement('div');
  container.id = 'gds-assistant-root';
  container.className = 'gds-assistant';
  document.body.appendChild(container);

  const root = createRoot(container);
  root.render(<App />);
});
