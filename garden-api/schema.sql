CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread TEXT NOT NULL,
  parent_id INTEGER NULL,
  user_id INTEGER NOT NULL,
  login TEXT NOT NULL,
  name TEXT,
  avatar TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_comments_thread_created ON comments (thread, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments (parent_id);

CREATE TABLE IF NOT EXISTS post_log (
  login TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_post_log_login_at ON post_log (login, at);
