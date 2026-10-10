-- Rate-limit bucket for access requests (IPv6 by /64).
ALTER TABLE access_codes ADD COLUMN ip_bucket TEXT NOT NULL DEFAULT '';
UPDATE access_codes SET ip_bucket = ip WHERE ip_bucket = '';

-- Login attempts are counted per e-mail (a valid login on the same device must not reset
-- someone else's counter).
DROP TABLE login_attempts;
CREATE TABLE login_attempts (
  email TEXT NOT NULL,
  at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX login_attempts_email ON login_attempts(email, at);
