import 'dotenv/config'
import { Pool, types } from 'pg'
import { logError } from './logger.ts'
import { decryptToken } from './token-crypto.ts'
import { performTinkoffSync, recordSnapshot, refreshMarketPrices } from './daily-tasks.ts'
import {
  findBrokerConnection, listAllBrokerConnections, listAllPortfolios,
  updateBrokerConnectionSync, withTransaction,
} from './repository.ts'

// Планировщик фоновых задач (§19/§21/§32) — раньше снимки портфеля, синхронизация брокера
// и обновление цен MOEX происходили только по явному действию пользователя (кнопка/переход
// на страницу), а не автоматически раз в сутки, как того требуют §19/§21. Отдельный процесс,
// а не Celery/Redis (см. «Решение (контекст)» в плане: вариант B — Express/TS-стек без
// очередей) — по тому же паттерну, что уже используют сервисы backup/certbot в docker-compose:
// лёгкий скрипт с бесконечным циклом вместо полноценного джоб-раннера.

types.setTypeParser(1082, (value) => value)

const databaseUrl = process.env.DATABASE_URL || 'postgresql://portfel:portfel@localhost:5432/portfel'
const db = new Pool({ connectionString: databaseUrl, max: 5 })

const INTERVAL_SECONDS = Number(process.env.SCHEDULER_INTERVAL_SECONDS || 86400)

// §19: MVP поддерживает единственного брокера (Т-Инвестиции) — интерфейс BrokerConnector
// (server/brokers/types.ts) уже спроектирован под несколько коннекторов, но сам планировщик
// не должен придумывать общий диспетчер ради одной ветки; добавление второго брокера (v2)
// потребует одной новой ветки здесь, а не переработки структуры.
async function syncBrokerConnection(userId: string, brokerType: string): Promise<void> {
  if (brokerType !== 'tinkoff') return
  const connection = await findBrokerConnection(db, userId, brokerType)
  if (!connection || !connection.encryptedToken) return
  try {
    const token = decryptToken(connection.encryptedToken)
    await withTransaction(db, (client) => performTinkoffSync(client, userId, token))
    await updateBrokerConnectionSync(db, userId, brokerType, {
      status: 'connected', lastSyncAt: new Date().toISOString(), lastError: null,
    })
  } catch (error) {
    // §40.2 B/C: сбой синхронизации помечает статус, но не трогает ранее загруженные данные —
    // withTransaction откатывает только эту попытку, зеркалирует POST /api/brokers/tinkoff/sync.
    logError('scheduler.broker-sync', error)
    await updateBrokerConnectionSync(db, userId, brokerType, {
      status: 'error', lastError: 'Не удалось получить данные от Т-Инвестиций',
    }).catch((updateError) => logError('scheduler.broker-sync.status', updateError))
  }
}

async function runDailyTasks(): Promise<void> {
  console.log(`[scheduler] ${new Date().toISOString()} daily run: start`)

  const connections = await listAllBrokerConnections(db)
  for (const { userId, brokerType } of connections) {
    await syncBrokerConnection(userId, brokerType).catch((error) => logError('scheduler.broker-sync.outer', error))
  }

  const portfolios = await listAllPortfolios(db)
  for (const { userId } of portfolios) {
    await withTransaction(db, (client) => refreshMarketPrices(client, userId))
      .catch((error) => logError('scheduler.market-prices', error))
    // §21: снимок пишется безусловно, раз в сутки, независимо от того, обновились ли цены —
    // это единственное место, которое обеспечивает историю портфеля без действия пользователя.
    await withTransaction(db, (client) => recordSnapshot(client, userId))
      .catch((error) => logError('scheduler.snapshot', error))
  }

  console.log(`[scheduler] ${new Date().toISOString()} daily run: done (${connections.length} connections, ${portfolios.length} portfolios)`)
}

async function loop(): Promise<void> {
  for (;;) {
    await runDailyTasks().catch((error) => logError('scheduler.run', error))
    await new Promise((resolveDelay) => setTimeout(resolveDelay, INTERVAL_SECONDS * 1000))
  }
}

loop()
