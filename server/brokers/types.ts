// SPEC §19: «Добавление нового брокера не должно требовать изменения бизнес-логики
// расчёта портфеля» — единый интерфейс, которому должен соответствовать любой коннектор.
// TinkoffConnector — единственная реализация на MVP; BCS/Sber/Alfa — v2.

export interface BrokerAccount {
  externalId: string
  name?: string
  currency: string
}

export interface BrokerInstrument {
  externalId: string
  isin?: string
  ticker?: string
  name: string
  currency: string
  assetType: 'bond' | 'share' | 'fund' | 'deposit' | 'other'
  nominal?: number
  maturityDate?: string
  couponRate?: number
}

export interface BrokerPosition {
  accountExternalId: string
  instrument: BrokerInstrument
  quantity: number
  averagePrice: number | null
  currentPrice: number | null
  currentValue: number | null
  // НКД на всю позицию (§14), в валюте инструмента; null — у бумаги его нет.
  accruedInterest?: number | null
}

export interface BrokerOperation {
  externalId: string
  accountExternalId: string
  instrumentExternalId?: string
  type: 'BUY' | 'SELL' | 'DEPOSIT' | 'WITHDRAW' | 'COUPON' | 'DIVIDEND' | 'INTEREST' | 'FEE' | 'TAX' | 'REDEMPTION' | 'OTHER'
  date: string
  quantity?: number
  price?: number
  amount: number
  currency: string
  commission?: number
  tax?: number
  description?: string
}

export interface BrokerSyncResult {
  accounts: BrokerAccount[]
  positions: BrokerPosition[]
  operations: BrokerOperation[]
}

export interface BrokerConnector {
  readonly providerId: string
  validateToken(token: string): Promise<boolean>
  fetchSyncData(token: string): Promise<BrokerSyncResult>
}
