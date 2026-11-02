CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL);
INSERT INTO state VALUES (1,0,'{"stocks":{},"paused":false}');
CREATE TABLE updates (id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE outbox (
 id TEXT PRIMARY KEY, body TEXT NOT NULL, symbol TEXT, generation TEXT,
 kind TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 next_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
 claim TEXT, lease_until INTEGER, error TEXT
);
CREATE INDEX outbox_due ON outbox(status,next_at);
CREATE TABLE leases (id TEXT PRIMARY KEY, owner TEXT NOT NULL, until_at INTEGER NOT NULL);
