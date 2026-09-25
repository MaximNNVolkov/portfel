import 'dotenv/config'
import { Pool, types } from 'pg'
import { logError } from './logger.ts'
import { decryptToken } from './token-crypto.ts'
import { performTinkoffSync, recordSnapshot, refreshMarketPrices, regenerateForecastPayouts } from './daily-tasks.ts'
import { processNextDocument } from './ocr.ts'
import {
  failStaleProcessingDocuments, findBrokerConnection, listAllBrokerConnections, listAllPortfolios,
  updateBrokerConnectionSync, withTransaction,
} from './repository.ts'

// BUG-10: tesseract.js способен упасть необработанным исключением мимо try/catch внутри
// recognizeText (например, из своего внутреннего воркер-скрипта) — без этих обработчиков
// такое исключение убивало бы весь процесс планировщика, а вместе с ним и ocrLoop/dailyLoop
// для всех пользователей, а не только сломанный документ.
process.on('uncaughtException', (error) => {
  logError('scheduler.uncaught-exception', error)
})
process.on('unhandledRejection', (error) => {
  logError('scheduler.unhandled-rejection', error)
})

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
// Очередь OCR живёт в том же процессе, но в отдельном цикле: раз в сутки — неприемлемое
// ожидание для загруженного скриншота, а суточные задачи, наоборот, нечего гонять каждые
// две секунды. §34 требует именно асинхронного выполнения со статусом, а не быстрого.
const OCR_POLL_SECONDS = Number(process.env.OCR_POLL_SECONDS || 2)

// BUG-10: сколько документ может провисеть в processing (например, из-за падения процесса
// между claimPendingDocument и completeUploadedDocument), прежде чем считать его зависшим
// и пометить failed, чтобы очередь не блокировалась и пользователь увидел ошибку вместо
// вечного «В очереди на распознавание…».
const OCR_STALE_TIMEOUT_MINUTES = Number(process.env.OCR_STALE_TIMEOUT_MINUTES || 5)
const OCR_STALE_CHECK_SECONDS = Number(process.env.OCR_STALE_CHECK_SECONDS || 60)

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
    // §15/§22: плановые выплаты пересчитываются ежедневно, а не только при правке инструмента —
    // с течением времени часть прогноза становится прошлым, а вклад с автопролонгацией или
    // облигация с наступившей офертой меняют горизонт без всякого действия пользователя.
    await withTransaction(db, (client) => regenerateForecastPayouts(client, userId))
      .catch((error) => logError('scheduler.payout-forecast', error))
    // §21: снимок пишется безусловно, раз в сутки, независимо от того, обновились ли цены —
    // это единственное место, которое обеспечивает историю портфеля без действия пользователя.
    await withTransaction(db, (client) => recordSnapshot(client, userId))
      .catch((error) => logError('scheduler.snapshot', error))
  }

  console.log(`[scheduler] ${new Date().toISOString()} daily run: done (${connections.length} connections, ${portfolios.length} portfolios)`)
}

const sleep = (seconds: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, seconds * 1000))

async function dailyLoop(): Promise<void> {
  for (;;) {
    await runDailyTasks().catch((error) => logError('scheduler.run', error))
    await sleep(INTERVAL_SECONDS)
  }
}

// Очередь вычерпывается до конца, и только на пустой очереди воркер засыпает: несколько
// скриншотов, загруженных подряд, не должны ждать по такту опроса каждый.
async function ocrLoop(): Promise<void> {
  for (;;) {
    const processed = await processNextDocument(db).catch((error) => {
      logError('scheduler.ocr', error)
      return false
    })
    if (!processed) await sleep(OCR_POLL_SECONDS)
  }
}

// Отдельный редкий цикл, а не проверка на каждом такте ocrLoop (2с) — сам таймаут (минуты)
// на порядки больше такта опроса очереди, частая проверка только тратила бы запросы к БД.
async function staleDocumentLoop(): Promise<void> {
  for (;;) {
    await failStaleProcessingDocuments(db, OCR_STALE_TIMEOUT_MINUTES).catch((error) => {
      logError('scheduler.ocr-stale', error)
      return 0
    })
    await sleep(OCR_STALE_CHECK_SECONDS)
  }
}

dailyLoop()
ocrLoop()
staleDocumentLoop()
