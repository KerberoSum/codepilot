PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS vm_agent_chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'read',
  web INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS vm_agent_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'read',
  web INTEGER NOT NULL DEFAULT 0,
  error INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (chat_id) REFERENCES vm_agent_chats(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_vm_agent_messages_chat_created
  ON vm_agent_messages(chat_id, created_at);
