/**
 * Mock SSE responses for chat endpoint testing.
 * These simulate LLM responses without calling real APIs.
 */

const SIMPLE_TEXT_RESPONSE = [
  'event: conversation_start',
  'data: {"conversation_id":"test-conv-1","model":"anthropic:sonnet"}',
  '',
  'event: text_delta',
  'data: {"text":"Hello! "}',
  '',
  'event: text_delta',
  'data: {"text":"I can help you manage your site."}',
  '',
  'event: usage',
  'data: {"input_tokens":500,"output_tokens":20}',
  '',
  'event: message_stop',
  'data: {"stop_reason":"end_turn"}',
  '',
].join('\n');

const TOOL_CALL_RESPONSE = [
  'event: conversation_start',
  'data: {"conversation_id":"test-conv-2","model":"anthropic:sonnet"}',
  '',
  'event: text_delta',
  'data: {"text":"Let me list the pages for you."}',
  '',
  'event: tool_use_start',
  'data: {"id":"toolu_test1","name":"gds__content-list","input":{}}',
  '',
  'event: tool_result',
  'data: {"tool_use_id":"toolu_test1","result":{"posts":[{"id":1,"title":"Home"}],"total":1},"is_error":false}',
  '',
  'event: text_delta',
  'data: {"text":"\\n\\nFound 1 page: Home (ID 1)."}',
  '',
  'event: usage',
  'data: {"input_tokens":1000,"output_tokens":50}',
  '',
  'event: message_stop',
  'data: {"stop_reason":"end_turn"}',
  '',
].join('\n');

const ERROR_RESPONSE = [
  'event: conversation_start',
  'data: {"conversation_id":"test-conv-3","model":"anthropic:sonnet"}',
  '',
  'event: error',
  'data: {"message":"API returned HTTP 500: Internal server error"}',
  '',
].join('\n');

const TOOL_APPROVAL_RESPONSE = [
  'event: conversation_start',
  'data: {"conversation_id":"test-conv-4","model":"anthropic:sonnet"}',
  '',
  'event: text_delta',
  'data: {"text":"I will clear the cache."}',
  '',
  'event: tool_approval_required',
  'data: {"tool_use_id":"toolu_approve1","tool_name":"gds/cache-clear","input":{}}',
  '',
  'event: message_stop',
  'data: {"stop_reason":"end_turn"}',
  '',
].join('\n');

// A reversible action: tool_result carries undoable + audit_id + undo_label,
// which drives the per-tool Undo button on the tool-call message.
const TOOL_UNDO_RESPONSE = [
  'event: conversation_start',
  'data: {"conversation_id":"test-conv-undo","model":"anthropic:sonnet"}',
  '',
  'event: text_delta',
  'data: {"text":"Creating the draft page."}',
  '',
  'event: tool_use_start',
  'data: {"id":"toolu_undo1","name":"gds__content-create","input":{"type":"pages","title":"Undo Test"}}',
  '',
  'event: tool_result',
  'data: {"tool_use_id":"toolu_undo1","result":{"id":123,"title":"Undo Test"},"is_error":false,"undoable":true,"audit_id":555,"undo_label":"Remove the created page"}',
  '',
  'event: text_delta',
  'data: {"text":"\\n\\nCreated the draft page."}',
  '',
  'event: usage',
  'data: {"input_tokens":800,"output_tokens":40}',
  '',
  'event: message_stop',
  'data: {"stop_reason":"end_turn"}',
  '',
].join('\n');

// An approval-gated DESTRUCTIVE-but-reversible action (delete a page). The
// resolution carries undo metadata, so after approval the tool-call card must
// flip to Done and show an Undo button — exercising the approval→history→undo
// path that previously rendered as throwaway text with no record.
const TOOL_APPROVAL_DELETE_RESPONSE = [
  'event: conversation_start',
  'data: {"conversation_id":"test-conv-del","model":"anthropic:sonnet"}',
  '',
  'event: text_delta',
  'data: {"text":"I will delete page 13589."}',
  '',
  'event: tool_approval_required',
  'data: {"tool_use_id":"toolu_del1","tool_name":"gds__content-delete","input":{"type":"pages","id":13589}}',
  '',
  'event: message_stop',
  'data: {"stop_reason":"end_turn"}',
  '',
].join('\n');

// Realistic approval flow: the provider streams tool_use_start for the tool,
// then MessageLoop flags it with tool_approval_required (same id). The UI must
// show ONE card, not two (one stuck on "Running" after approval).
const TOOL_APPROVAL_WITH_USE_START = [
  'event: conversation_start',
  'data: {"conversation_id":"test-conv-del","model":"anthropic:sonnet"}',
  '',
  'event: text_delta',
  'data: {"text":"I will delete page 22405 again."}',
  '',
  'event: tool_use_start',
  'data: {"id":"toolu_del1","name":"gds__content-delete","input":{"type":"pages","id":22405}}',
  '',
  'event: tool_approval_required',
  'data: {"tool_use_id":"toolu_del1","tool_name":"gds__content-delete","input":{"type":"pages","id":22405}}',
  '',
  'event: message_stop',
  'data: {"stop_reason":"end_turn"}',
  '',
].join('\n');

const TOOL_APPROVAL_DELETE_RESOLVED = [
  'event: conversation_start',
  'data: {"conversation_id":"test-conv-del","model":"anthropic:sonnet"}',
  '',
  'event: tool_result',
  'data: {"tool_use_id":"toolu_del1","result":{"deleted":true,"id":13589},"is_error":false,"undoable":true,"audit_id":777,"undo_label":"Restore the deleted page"}',
  '',
  'event: text_delta',
  'data: {"text":"Deleted page 13589."}',
  '',
  'event: usage',
  'data: {"input_tokens":400,"output_tokens":15}',
  '',
  'event: message_stop',
  'data: {"stop_reason":"end_turn"}',
  '',
].join('\n');

// Two distinct tool calls that REUSE the same tool id — some connectors (seen
// with Gemini) do this. assistant-ui keys content parts by toolCallId and used
// to crash with "Duplicate key … in tapResources"; the adapter now suffixes
// repeats so both cards render and each gets its own result.
const TOOL_DUPLICATE_ID_RESPONSE = [
  'event: conversation_start',
  'data: {"conversation_id":"test-conv-dup","model":"google:gemini"}',
  '',
  'event: text_delta',
  'data: {"text":"Deleting both pages."}',
  '',
  'event: tool_use_start',
  'data: {"id":"gemini_dup","name":"gds__content-delete","input":{"type":"pages","id":13589}}',
  '',
  'event: tool_result',
  'data: {"tool_use_id":"gemini_dup","result":{"deleted":true,"id":13589},"is_error":false}',
  '',
  'event: tool_use_start',
  'data: {"id":"gemini_dup","name":"gds__content-delete","input":{"type":"pages","id":14410}}',
  '',
  'event: tool_result',
  'data: {"tool_use_id":"gemini_dup","result":{"deleted":true,"id":14410},"is_error":false}',
  '',
  'event: text_delta',
  'data: {"text":"\\n\\nDeleted both pages."}',
  '',
  'event: usage',
  'data: {"input_tokens":900,"output_tokens":40}',
  '',
  'event: message_stop',
  'data: {"stop_reason":"end_turn"}',
  '',
].join('\n');

// The follow-up stream after the user DENIES toolu_approve1: the server
// resolves the tool as denied and the assistant acknowledges — crucially it
// does NOT re-surface another approval prompt, so the bar stays hidden.
const TOOL_DENIAL_RESOLVED = [
  'event: conversation_start',
  'data: {"conversation_id":"test-conv-4","model":"anthropic:sonnet"}',
  '',
  'event: tool_result',
  'data: {"tool_use_id":"toolu_approve1","result":{"denied":true},"is_error":true}',
  '',
  'event: text_delta',
  'data: {"text":"Okay, I will not clear the cache."}',
  '',
  'event: usage',
  'data: {"input_tokens":300,"output_tokens":10}',
  '',
  'event: message_stop',
  'data: {"stop_reason":"end_turn"}',
  '',
].join('\n');

// The follow-up stream after the user approves toolu_approve1: the server
// resolves the pending tool and the assistant continues.
const TOOL_APPROVAL_RESOLVED = [
  'event: conversation_start',
  'data: {"conversation_id":"test-conv-4","model":"anthropic:sonnet"}',
  '',
  'event: tool_result',
  'data: {"tool_use_id":"toolu_approve1","result":{"cleared":true},"is_error":false}',
  '',
  'event: text_delta',
  'data: {"text":"Cache cleared."}',
  '',
  'event: usage',
  'data: {"input_tokens":300,"output_tokens":10}',
  '',
  'event: message_stop',
  'data: {"stop_reason":"end_turn"}',
  '',
].join('\n');

module.exports = {
  SIMPLE_TEXT_RESPONSE,
  TOOL_CALL_RESPONSE,
  ERROR_RESPONSE,
  TOOL_APPROVAL_RESPONSE,
  TOOL_APPROVAL_RESOLVED,
  TOOL_DENIAL_RESOLVED,
  TOOL_APPROVAL_DELETE_RESPONSE,
  TOOL_APPROVAL_DELETE_RESOLVED,
  TOOL_APPROVAL_WITH_USE_START,
  TOOL_DUPLICATE_ID_RESPONSE,
  TOOL_UNDO_RESPONSE,
};
