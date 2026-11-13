DROP FUNCTION IF EXISTS auth_reset_password(text, text), auth_reset_create(text, text, interval), auth_session_get(text), auth_find_user(text);
DROP TABLE IF EXISTS audit_logs, rate_limits, auth_throttle, password_reset_tokens, sessions, user_permissions, users;
DROP FUNCTION IF EXISTS search_text(text), app_user_id(), forbid_mutation();
