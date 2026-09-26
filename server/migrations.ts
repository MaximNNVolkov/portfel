import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { Pool, type PoolClient } from 'pg'

export type Migration = { id: string; name: string; sql: string }

const MIGRATIONS_DIR = resolve(process.cwd(), 'db/migrations')
const MIGRATION_LOCK_ID = 4242424242

export async function loadMigrations(directory = MIGRATIONS_DIR): Promise<Migration[]> {
  const entries = await readdir(directory).catch(() => [] as string[])
  const files = entries.filter((file) => file.endsWith('.sql')).sort()
  const migrations: Migration[] = []
  for (const file of files) {
    const id = file.match(/^(\d+)/)?.[1]
    if (!id) throw new Error(`Migration file must start with a numeric id: ${file}`)
    if (migrations.some((migration) => migration.id === id)) throw new Error(`Duplicate migration id ${id} in ${file}`)
    migrations.push({ id, name: file.replace(/\.sql$/, ''), sql: await readFile(resolve(directory, file), 'utf8') })
  }
  return migrations
}

async function ensureMigrationsTable(client: PoolClient) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
}

async function applyMigration(client: PoolClient, migration: Migration) {
  try {
    await client.query('BEGIN')
    await client.query(migration.sql)
    await client.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [migration.id, migration.name])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw new Error(`Migration ${migration.name} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function runMigrations(db: Pool, directory = MIGRATIONS_DIR): Promise<Migration[]> {
  const migrations = await loadMigrations(directory)
  const client = await db.connect()
  const applied: Migration[] = []
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID])
    await ensureMigrationsTable(client)
    const executed = await client.query('SELECT id FROM schema_migrations')
    const executedIds = new Set<string>(executed.rows.map((row) => row.id))
    for (const migration of migrations) {
      if (executedIds.has(migration.id)) continue
      await applyMigration(client, migration)
      applied.push(migration)
      console.log(`Applied migration ${migration.name}`)
    }
    if (!applied.length) console.log(`Database schema is up to date (${migrations.length} migrations)`)
    return applied
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined)
    client.release()
  }
}

// Миграции применяет только API при старте. Процессы, которые его не заменяют (планировщик),
// спрашивают здесь, догнала ли база схему из db/migrations, — иначе после деплоя с новой
// миграцией их первые запросы падают на ещё не созданных колонках.
export async function listPendingMigrations(db: Pool, directory = MIGRATIONS_DIR): Promise<Migration[]> {
  const migrations = await loadMigrations(directory)
  const table = await db.query("SELECT to_regclass('schema_migrations') AS name")
  if (!table.rows[0]?.name) return migrations
  const executed = await db.query('SELECT id FROM schema_migrations')
  const executedIds = new Set<string>(executed.rows.map((row) => row.id))
  return migrations.filter((migration) => !executedIds.has(migration.id))
}

const isDirectRun = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false
if (isDirectRun) {
  const db = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://portfel:portfel@localhost:5432/portfel', max: 1 })
  runMigrations(db)
    .catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
    .finally(() => db.end())
}
