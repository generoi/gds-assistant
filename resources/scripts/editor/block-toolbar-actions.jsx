/**
 * Adds an "AI assistant" dropdown to the default Gutenberg block toolbar (on
 * text-bearing blocks). Each option sends a message into the chat as if the
 * user typed it — the assistant then handles the edit using the existing
 * editor tools, so the rewrite/translation appears in the conversation and the
 * applied block edit gets the usual change-highlight.
 *
 * Registered via the `editor.BlockEdit` filter so it works for every block
 * without us shipping a separate gutenberg-side bundle.
 */

import {addFilter} from '@wordpress/hooks';
import {createHigherOrderComponent} from '@wordpress/compose';
import {BlockControls} from '@wordpress/block-editor';
import {ToolbarGroup, ToolbarDropdownMenu} from '@wordpress/components';
import {Fragment} from '@wordpress/element';

const TEXT_BLOCKS = new Set([
  'core/paragraph',
  'core/heading',
  'core/list',
  'core/list-item',
  'core/quote',
  'core/pullquote',
  'core/preformatted',
  'core/verse',
]);

// Friendly block label for the user message (e.g. "core/paragraph" → "paragraph").
function blockLabel(name) {
  return (name || '').replace(/^core\//, '').replace(/-/g, ' ');
}

/** Strip HTML + collapse whitespace, for a clean snippet in the chat message. */
function plainText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getBlockText(clientId) {
  const block = window.wp?.data?.select?.('core/block-editor')?.getBlock?.(clientId);
  if (!block) return '';
  const attrs = block.attributes || {};
  return plainText(attrs.content || attrs.text || attrs.value || '');
}

/** Open the chat panel if it's closed, then send the message as the user. */
function sendToChat(message) {
  if (!message) return;
  window.gdsAssistant?.openChat?.();
  window.gdsAssistant?.sendChatMessage?.(message);
}

const AiIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2.5l2.2 5.8 5.8 2.2-5.8 2.2L12 18.5l-2.2-5.8L4 10.5l5.8-2.2L12 2.5z" />
  </svg>
);

const withAssistantBlockToolbar = createHigherOrderComponent(
  (BlockEdit) => (props) => {
    if (!TEXT_BLOCKS.has(props.name)) {
      return <BlockEdit {...props} />;
    }

    const langs = window.gdsAssistant?.voiceLanguages || [];
    const pagePrimary = (document.documentElement.lang || '')
      .toLowerCase()
      .split('-')[0];
    const translateTargets = langs.filter(
      (l) => l.code.toLowerCase().split('-')[0] !== pagePrimary,
    );

    const label = blockLabel(props.name);

    const buildMessage = (action) => {
      const text = getBlockText(props.clientId);
      if (!text) {
        return `${action} the selected ${label}.`;
      }
      // Including the text + the block's clientId saves the assistant a
      // read_selection round-trip; the assistant can apply via
      // editor__update_block_attributes targeting clientId ${props.clientId}.
      return `${action} this ${label} (block ${props.clientId}):\n\n"${text}"`;
    };

    const controls = [
      {
        title: 'Rewrite',
        onClick: () => sendToChat(buildMessage('Rewrite')),
      },
      {
        title: 'Shorten',
        onClick: () => sendToChat(buildMessage('Shorten')),
      },
      {
        title: 'Expand',
        onClick: () => sendToChat(buildMessage('Expand')),
      },
      {
        title: 'Improve clarity',
        onClick: () => sendToChat(buildMessage('Improve the clarity and flow of')),
      },
      ...translateTargets.map((l) => ({
        title: `Translate to ${l.name}`,
        onClick: () => {
          const text = getBlockText(props.clientId);
          const msg = text
            ? `Translate this ${label} to ${l.name}, preserving tone (block ${props.clientId}):\n\n"${text}"`
            : `Translate the selected ${label} to ${l.name}.`;
          sendToChat(msg);
        },
      })),
    ];

    return (
      <Fragment>
        <BlockEdit {...props} />
        <BlockControls group="other">
          <ToolbarGroup>
            <ToolbarDropdownMenu
              icon={AiIcon}
              label="AI assistant"
              controls={controls}
            />
          </ToolbarGroup>
        </BlockControls>
      </Fragment>
    );
  },
  'withAssistantBlockToolbar',
);

addFilter(
  'editor.BlockEdit',
  'gds-assistant/block-toolbar',
  withAssistantBlockToolbar,
);
