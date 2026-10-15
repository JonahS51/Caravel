-- Caravel Cloud-Sync (Cloudflare D1)
-- Anwenden: npx wrangler d1 execute caravel-sync --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS accounts (
  id         TEXT PRIMARY KEY,    -- aus dem Sync-Code abgeleitet (32 Hex-Zeichen)
  token_hash TEXT NOT NULL,       -- SHA-256 des Zugriffstokens
  version    INTEGER NOT NULL,    -- steigt bei jedem Schreiben, dient als ETag
  size       INTEGER NOT NULL,
  created    INTEGER NOT NULL,
  updated    INTEGER NOT NULL
);

-- Die verschlüsselte Sync-Datei, in Stücke von höchstens 1 MB geteilt
CREATE TABLE IF NOT EXISTS chunks (
  id      TEXT NOT NULL,
  version INTEGER NOT NULL,
  n       INTEGER NOT NULL,
  data    TEXT NOT NULL,
  PRIMARY KEY (id, version, n)
);
