import {createRoot} from '@wordpress/element';
import '../styles/admin-chat.css';
import {App} from './app';

document.addEventListener('DOMContentLoaded', () => {
  const container = document.createElement('div');
  container.id = 'gds-assistant-root';
  container.className = 'gds-assistant';
  document.body.appendChild(container);

  const root = createRoot(container);
  root.render(<App />);
});
