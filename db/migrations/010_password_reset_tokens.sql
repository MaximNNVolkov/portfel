-- Восстановление пароля по почте. Токен сам по себе не хранится — только его sha256,
-- по тому же принципу, что и sessions.token_hash: утечка базы не даёт готовую ссылку
-- для сброса пароля. used_at отдельным полем (а не удалением строки) — чтобы повторное
-- использование уже применённого токена можно было явно отличить от несуществующего.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token_hash ON password_reset_tokens (token_hash);
