/**
 * Mock SSE responses for chat endpoint testing.
 * These simulate LLM responses without calling real APIs.
 */

export const SIMPLE_TEXT_RESPONSE = [
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

export const TOOL_CALL_RESPONSE = [
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

export const ERROR_RESPONSE = [
  'event: conversation_start',
  'data: {"conversation_id":"test-conv-3","model":"anthropic:sonnet"}',
  '',
  'event: error',
  'data: {"message":"API returned HTTP 500: Internal server error"}',
  '',
].join('\n');
