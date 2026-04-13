# GDS-Assistant Security Review Memory

## Critical Issues Found

### 1. API Key Storage (CRITICAL)
- Keys stored in wp_options table (`gds_assistant_key_{name}`) with no encryption
- Any admin with `manage_options` can access via settings page or DB
- Recommendation: Use env vars only, or implement encrypted option storage

### 2. Conversation IDOR (CRITICAL)
- Returns 404 for both non-existent and unauthorized conversations
- Should return 403 Forbidden for authorization failures to prevent UUID enumeration
- No rate limiting on `/conversations/{uuid}` endpoint allows brute-force UUID guessing

### 3. Unsafe Ability Execution (HIGH)
- `AbilitiesToolProvider::executeTool()` doesn't check user capabilities
- LLM can execute any ability regardless of user role if jailbroken
- Add explicit `current_user_can()` check before ability execution

### 4. Unrestricted Skills/Memory CRUD (HIGH)
- Post type `assistant_skill` and `assistant_memory` use `'capability_type' => 'post'`
- This means users with `edit_posts` can create/modify skills and memory
- Malicious skills can contain prompt injection payloads
- Should use custom capability type or explicit capability checks in tools

### 5. Rate Limiting Race Condition (MEDIUM)
- `set_transient()` not atomic — concurrent requests can bypass 60 req/5min limit
- Transient TTL not reset on each request — allows sliding window bypass
- No IP-based rate limiting, only user-based

### 6. Tool Input Validation Missing (MEDIUM)
- SkillsToolProvider and MemoryToolProvider accept LLM input without validation
- No length limits, format validation, or slug format checking
- Long strings could cause DB issues

### 7. SSE Headers (MEDIUM)
- Missing `X-Content-Type-Options: nosniff` header
- Should explicitly set CORS headers for defense-in-depth

### 8. Audit Log Plaintext Storage (HIGH)
- Tool inputs/results stored unencrypted in audit log table
- Could expose API keys if passed as tool arguments
- No REST API to access (good), but should sanitize sensitive data before storing

## Code Locations Summary
- API keys: `src/Admin/SettingsPage.php:167-170, 214-219`
- Conversation access: `src/Api/ConversationEndpoint.php:50-68`
- Ability execution: `src/Bridge/AbilitiesToolProvider.php:76-103`
- Skills CRUD: `src/Bridge/SkillsToolProvider.php:89-162`
- Memory CRUD: `src/Bridge/MemoryToolProvider.php:80-114`
- Rate limiting: `src/Api/RateLimiter.php:12-44`
- SSE headers: `src/Api/ChatEndpoint.php:336-359`
- Audit log: `src/Storage/AuditLog.php`

## Positive Findings
- SQL injection protection: Proper use of `$wpdb->prepare()`
- Nonce validation: Uses WordPress REST API's built-in nonce validation
- Conversation ownership check: Correctly validates user_id before returning
- List endpoint: Correctly filters conversations by current user

## Priority Fixes (in order)
1. Encrypt API keys or move to env-only
2. Change 404 → 403 for unauthorized conversation access
3. Add `current_user_can('manage_options')` to ability execution
4. Change post type capability to custom type or add explicit checks
5. Fix rate limiter with atomic increment
6. Add input validation to skills/memory tools
