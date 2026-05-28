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
function stripHtml(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Block rich-text attributes can be one of two shapes depending on WP version:
 *  - an HTML string (legacy)
 *  - a RichTextValue object with `.text` + `.formats` (WP 7.0+)
 * Normalise both to plain text.
 */
function attrToPlainText(attrValue) {
  if (typeof attrValue === 'string') {
    const rich = window.wp?.richText?.create?.({html: attrValue});
    if (typeof rich?.text === 'string') return rich.text;
    return stripHtml(attrValue);
  }
  if (attrValue && typeof attrValue === 'object' && typeof attrValue.text === 'string') {
    return attrValue.text;
  }
  return '';
}

function getBlockText(clientId) {
  const block = window.wp?.data?.select?.('core/block-editor')?.getBlock?.(clientId);
  if (!block) return '';
  const attrs = block.attributes || {};
  const value = attrs.content ?? attrs.text ?? attrs.value;
  return attrToPlainText(value).replace(/\s+/g, ' ').trim();
}

/**
 * If the user has a non-empty text selection inside this block's rich-text
 * attribute, return just that substring. Otherwise return ''. wp.data keeps
 * the selection across toolbar clicks, so this works after the dropdown opens.
 */
function getBlockSelectionText(clientId) {
  const select = window.wp?.data?.select?.('core/block-editor');
  if (!select) return '';
  const start = select.getSelectionStart?.();
  const end = select.getSelectionEnd?.();
  if (!start || !end) return '';
  if (start.clientId !== clientId || end.clientId !== clientId) return '';
  if (start.attributeKey !== end.attributeKey) return '';
  if (start.offset == null || end.offset == null) return '';
  if (start.offset === end.offset) return '';

  const block = select.getBlock?.(clientId);
  const attrValue = block?.attributes?.[start.attributeKey];
  const text = attrToPlainText(attrValue);
  if (!text) return '';

  // Rich-text selection offsets index the plain text (not the source HTML).
  const from = Math.min(start.offset, end.offset);
  const to = Math.max(start.offset, end.offset);
  return text.slice(from, to).trim();
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
      // Prefer an in-block text selection over the whole block — so "Expand"
      // on a marked phrase rewrites just that phrase, not the entire paragraph.
      const selection = getBlockSelectionText(props.clientId);
      const text = selection || getBlockText(props.clientId);
      if (!text) {
        return `${action} the selected ${label}.`;
      }
      const target = selection
        ? `this selection inside the ${label}`
        : `this ${label}`;
      // Including the text + the block's clientId saves the assistant a
      // read_selection round-trip; the assistant can apply via
      // editor__update_block_attributes targeting clientId ${props.clientId}.
      return `${action} ${target} (block ${props.clientId}):\n\n"${text}"`;
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
          const selection = getBlockSelectionText(props.clientId);
          const text = selection || getBlockText(props.clientId);
          if (!text) {
            sendToChat(`Translate the selected ${label} to ${l.name}.`);
            return;
          }
          const target = selection
            ? `this selection inside the ${label}`
            : `this ${label}`;
          sendToChat(
            `Translate ${target} to ${l.name}, preserving tone (block ${props.clientId}):\n\n"${text}"`,
          );
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
