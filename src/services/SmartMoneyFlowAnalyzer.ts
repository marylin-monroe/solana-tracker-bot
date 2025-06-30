// src/services/SmartMoneyFlowAnalyzer.ts - 🔥 ПРОТОКОЛ "ПОЛНЫЙ КОНТРОЛЬ" - ИНТЕГРАЦИЯ С АГРЕГИРОВАННЫМИ ПОЗИЦИЯМИ
import { SmartMoneyDatabase } from './SmartMoneyDatabase';
import { Database } from './Database';
import { TelegramNotifier } from './TelegramNotifier';
import { TokenMetadataService } from './TokenMetadataService';
import { SolanaMonitor } from './SolanaMonitor';
import { Logger } from '../utils/Logger';
import { TokenSwap, SmartMoneyFlow, HotNewToken, SmartMoneyWallet } from '../types';

export interface FlowAnalysisResult {
  inflows: SmartMoneyFlow[];
  outflows: SmartMoneyFlow[];
  hotNewTokens: HotNewToken[];
  topInflowsLastHour: SmartMoneyFlow[];
}

export interface TokenHolding {
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  uniqueWalletCount: number;
  sniperWallets: number;
  hunterWallets: number;
  traderWallets: number;
  totalBalanceUSD: number;
  avgBalancePerWallet: number;
  maxSingleHolding: number;
  fdv: number | null;
  marketCap: number | null;
  priceChange24h: number | null;
  liquidityScore: number;
  firstSeenAt: Date;
  avgHoldingDays: number;
  totalBuyVolume: number;
  totalSellVolume: number;
  netFlow: number;
  topHolders: Array<{
    address: string;
    category: 'sniper' | 'hunter' | 'trader';
    balanceUSD: number;
    holdingDays: number;
  }>;
}

export interface HoldingsReport {
  byWalletCount: TokenHolding[];
  byBalance: TokenHolding[];
  totalTokens: number;
  totalValueUSD: number;
  analysisTime: Date;
  summary: {
    topTokenByWallets: string;
    topTokenByValue: string;
    avgHoldingDays: number;
    totalUniqueWallets: number;
    totalFDV: number;
    avgTokenFDV: number;
  };
}

export interface WalletPerformanceMetrics {
  address: string;
  currentPnL: number;
  last30DaysPnL: number;
  last7DaysPnL: number;
  profitFactor: number;
  maxDrawdown: number;
  avgHoldTime: number;
  recentWinRate: number;
  volumeWeightedPrice: number;
  riskAdjustedReturn: number;
  realTimeScore: number;
  trendDirection: 'up' | 'down' | 'stable';
  hotStreak: number;
  recentHitRate: number;
}

interface WalletTokenData {
  category: 'sniper' | 'hunter' | 'trader';
  buyVolume: number;
  sellVolume: number;
  netPosition: number;
  firstBuyTime: Date;
  lastActivityTime: Date;
  transactions: any[];
}

interface TokenData {
  tokenAddress: string;
  wallets: Map<string, WalletTokenData>;
  firstSeenAt: Date;
}

export class SmartMoneyFlowAnalyzer {
  private smDatabase: SmartMoneyDatabase;
  private database: Database;
  private telegramNotifier: TelegramNotifier;
  private readonly tokenMetadataService: TokenMetadataService;
  private solanaMonitor: SolanaMonitor | null = null; // 🔥 ДОБАВЛЕН SolanaMonitor
  private logger: Logger;
  private readonly CONCURRENT_ENRICH_CALLS = 3;
  private readonly DELAY_BETWEEN_SUB_BATCHES = 500

  // 🚀 ОПТИМИЗИРОВАННЫЕ КЕШИ
  private holdingsCache = new Map<string, { data: TokenHolding[]; timestamp: number }>();
  private enrichedTokenCache = new Map<string, {
    symbol: string; name: string; price: number | null; fdv: number | null; marketCap: number | null; timestamp: number;
  }>();
  private walletPerformanceCache = new Map<string, { metrics: WalletPerformanceMetrics; timestamp: number }>();
  
  private readonly HOLDINGS_CACHE_TTL = 15 * 60 * 1000; // 15 минут
  private readonly TOKEN_CACHE_TTL = 10 * 60 * 1000; // 10 минут
  private readonly WALLET_PERFORMANCE_TTL = 30 * 60 * 1000; // 30 минут

  // 🚀 PROFIT-FIRST конфигурация (компактная)
  private readonly PROFIT_CONFIG = {
    minFDV: 1_000_000, maxFDV: 500_000_000,
    optimalFDVRange: { min: 5_000_000, max: 100_000_000 },
    minSmBuyVolume: 25_000, minUniqueWallets: 3,
    performanceWeights: { recentPnL: 0.4, winRate: 0.25, profitFactor: 0.2, consistency: 0.15 }
  };

  constructor(smDatabase: SmartMoneyDatabase, telegramNotifier: TelegramNotifier, database: Database, tokenMetadataService: TokenMetadataService, solanaMonitor?: SolanaMonitor) {
    this.smDatabase = smDatabase;
    this.database = database;
    this.telegramNotifier = telegramNotifier;
    this.tokenMetadataService = tokenMetadataService;
    this.solanaMonitor = solanaMonitor || null; // 🔥 ИНТЕГРАЦИЯ С SolanaMonitor
    this.logger = Logger.getInstance();
    this.logger.info('📊 SmartMoneyFlowAnalyzer initialized with 🔥 ЕДИНЫЙ РАСЧЕТНЫЙ ЦЕНТР + Position Aggregation Integration');
  }

  // 🔥🔥🔥 ПРОТОКОЛ "ПОЛНЫЙ КОНТРОЛЬ" - ФИНАЛЬНАЯ ЛОГИКА АНАЛИЗА ПОТОКОВ 🔥🔥🔥
  async analyzeSmartMoneyFlows(): Promise<FlowAnalysisResult> {
    this.logger.info('🔍 Starting ПРОТОКОЛ "ПОЛНЫЙ КОНТРОЛЬ" Smart Money Flow Analysis...');

    try {
      const smartWallets = await this.smDatabase.getAllActiveSmartWallets();
      this.logger.info(`Analyzing flows for ${smartWallets.length} wallets with AGGREGATED POSITIONS`);

      // 🆕 Оптимизированное обновление метрик (только 10 кошельков)
      await this.updateWalletPerformanceMetricsOptimized(smartWallets);

      // 🔥 ШАГИ ПРОТОКОЛА "ПОЛНЫЙ КОНТРОЛЬ":
      // Шаг 1: Сбор Одиночных Сделок
      // Шаг 2: Запрос Агрегированных Данных
      // Шаг 3: Объединение Данных
      // Шаг 4: Анализ Outflows (каждая отдельная продажа)
      // Шаг 5: Финальный Фильтр

      // Параллельный анализ потоков с новой логикой
      const [hourlyFlows, dailyFlows] = await Promise.all([
        this.calculateFlowsWithAggregatedPositions(smartWallets, '1h'),
        this.calculateFlowsWithAggregatedPositions(smartWallets, '24h')
      ]);

      // 🚀 Hot New Tokens с оптимизированным батчингом FDV
      const hotNewTokens = await this.findProfitableHotNewTokensBatched(smartWallets);

      const topInflowsLastHour = hourlyFlows.inflows
        .sort((a, b) => b.totalInflowUSD - a.totalInflowUSD)
        .slice(0, 10);

      const result: FlowAnalysisResult = {
        inflows: [...hourlyFlows.inflows, ...dailyFlows.inflows],
        outflows: [...hourlyFlows.outflows, ...dailyFlows.outflows],
        hotNewTokens,
        topInflowsLastHour
      };

      this.logger.info(`✅ ПРОТОКОЛ "ПОЛНЫЙ КОНТРОЛЬ" COMPLETE: ${result.inflows.length} inflows, ${result.hotNewTokens.length} hot tokens`);
      return result;
    } catch (error) {
      this.logger.error('❌ Error in ПРОТОКОЛ "ПОЛНЫЙ КОНТРОЛЬ" flow analysis:', error);
      throw error;
    }
  }

  // 🔥🔥🔥 НОВАЯ ЛОГИКА РАСЧЕТА ПОТОКОВ С АГРЕГИРОВАННЫМИ ПОЗИЦИЯМИ + ОПТИМИЗАЦИЯ БД 🔥🔥🔥
  private async calculateFlowsWithAggregatedPositions(smartWallets: SmartMoneyWallet[], period: '1h' | '24h'): Promise<{ inflows: SmartMoneyFlow[]; outflows: SmartMoneyFlow[] }> {
    const hours = period === '1h' ? 1 : 24;
    const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);

    this.logger.info(`🔥 [ПРОТОКОЛ "ПОЛНЫЙ КОНТРОЛЬ"] Starting ${period} flow analysis with aggregated positions...`);

    const tokenFlows = new Map<string, {
      tokenAddress: string; tokenSymbol: string; tokenName: string;
      totalBuyUSD: number; totalSellUSD: number;
      uniqueBuyers: Set<string>; uniqueSellers: Set<string>;
      transactions: TokenSwap[]; fdv: number | null; marketCap: number | null;
      aggregatedPositionsUSD: number; // 🔥 НОВОЕ ПОЛЕ для агрегированных позиций
      walletsWithAggregatedPositions: Set<string>; // 🔥 НОВОЕ ПОЛЕ
    }>();

    // 🚀 ШАГ 1: СБОР ОДИНОЧНЫХ СДЕЛОК
    // 🔥 ИСПРАВЛЕНО: Убран несуществующий метод getTransactionsForMultipleWallets
    // Используем Promise.all для параллельных запросов
    this.logger.info(`🔥 [ПРОТОКОЛ "ПОЛНЫЙ КОНТРОЛЬ"] Fetching transactions for ${smartWallets.length} wallets with parallel queries...`);
    
    const walletAddresses = smartWallets.map(w => w.address);
    
    // 🔥 ИСПРАВЛЕНО: Используем только рабочий метод с Promise.all
    const transactionPromises = smartWallets.map(wallet => 
      this.getWalletTransactionsAfter(wallet.address, cutoffTime)
    );
    
    const transactionArrays = await Promise.all(transactionPromises);
    const allTransactions = transactionArrays.flat();
    this.logger.info(`✅ [PARALLEL] Got ${allTransactions.length} transactions with ${smartWallets.length} parallel queries`);

    // Обрабатываем все транзакции
    const allTokens = new Set<string>();
    for (const tx of allTransactions) {
      allTokens.add(tx.tokenAddress);
      const key = tx.tokenAddress;
      
      if (!tokenFlows.has(key)) {
        tokenFlows.set(key, {
          tokenAddress: tx.tokenAddress, tokenSymbol: '', tokenName: '',
          totalBuyUSD: 0, totalSellUSD: 0,
          uniqueBuyers: new Set(), uniqueSellers: new Set(),
          transactions: [], fdv: null, marketCap: null,
          aggregatedPositionsUSD: 0, // 🔥 НОВОЕ ПОЛЕ
          walletsWithAggregatedPositions: new Set() // 🔥 НОВОЕ ПОЛЕ
        });
      }

      const flow = tokenFlows.get(key)!;
      flow.transactions.push(tx);

      if (this.isBuyTransaction(tx)) {
        flow.totalBuyUSD += tx.amountUSD;
        flow.uniqueBuyers.add(tx.walletAddress);
      } else {
        flow.totalSellUSD += tx.amountUSD;
        flow.uniqueSellers.add(tx.walletAddress);
      }
    }

    // 🚀 ШАГ 2: ЗАПРОС АГРЕГИРОВАННЫХ ДАННЫХ
    if (this.solanaMonitor) {
      this.logger.info(`🔥 [ПРОТОКОЛ "ПОЛНЫЙ КОНТРОЛЬ"] Requesting aggregated positions from SolanaMonitor...`);
      
      const aggregatedPositions = this.solanaMonitor.getAggregatedPositionsForWallets(walletAddresses);
      
      let totalAggregatedPositions = 0;
      let totalAggregatedUSD = 0;

      // 🚀 ШАГ 3: ОБЪЕДИНЕНИЕ ДАННЫХ
      for (const [walletAddress, positions] of aggregatedPositions) {
        for (const position of positions) {
          const key = position.tokenAddress;
          totalAggregatedPositions++;
          totalAggregatedUSD += position.totalUSD;
          
          if (!tokenFlows.has(key)) {
            tokenFlows.set(key, {
              tokenAddress: position.tokenAddress, tokenSymbol: position.tokenSymbol, tokenName: position.tokenName,
              totalBuyUSD: 0, totalSellUSD: 0,
              uniqueBuyers: new Set(), uniqueSellers: new Set(),
              transactions: [], fdv: null, marketCap: null,
              aggregatedPositionsUSD: 0,
              walletsWithAggregatedPositions: new Set()
            });
          }

          const flow = tokenFlows.get(key)!;
          
          // 🔥 ДОБАВЛЯЕМ ПОЛНЫЕ СУММЫ НАКОПЛЕННЫХ ПОЗИЦИЙ
          flow.aggregatedPositionsUSD += position.totalUSD;
          flow.walletsWithAggregatedPositions.add(walletAddress);
          flow.uniqueBuyers.add(walletAddress); // Учитываем кошелек как покупателя
          
          // Обновляем метаданные если есть
          if (position.tokenSymbol && !flow.tokenSymbol) {
            flow.tokenSymbol = position.tokenSymbol;
            flow.tokenName = position.tokenName;
          }
        }
      }

      this.logger.info(`🔥 [ПРОТОКОЛ "ПОЛНЫЙ КОНТРОЛЬ"] Integrated ${totalAggregatedPositions} aggregated positions worth ${this.formatNumber(totalAggregatedUSD)}`);
    } else {
      this.logger.warn(`⚠️ [ПРОТОКОЛ "ПОЛНЫЙ КОНТРОЛЬ"] SolanaMonitor not available - skipping aggregated positions`);
    }

    // 🚀 4. БАТЧ-запрос FDV для всех токенов ОДНОВРЕМЕННО
    this.logger.info(`🔥 Batching FDV requests for ${allTokens.size} tokens`);
    const tokenMetadata = await this.batchGetTokenMetadata(Array.from(allTokens));

    // 🚀 5. Обогащаем потоки данными из батча
    for (const [tokenAddress, flow] of tokenFlows) {
      const metadata = tokenMetadata.get(tokenAddress);
      if (metadata) {
        flow.tokenSymbol = metadata.symbol;
        flow.tokenName = metadata.name;
        flow.fdv = metadata.fdv;
        flow.marketCap = metadata.marketCap;
      } else if (!flow.tokenSymbol) {
        flow.tokenSymbol = `TOKEN_${tokenAddress.slice(0, 6)}`;
        flow.tokenName = 'Unknown Token';
      }
    }

    // 🚀 ШАГ 4: АНАЛИЗ OUTFLOWS (каждая отдельная продажа = outflow)
    // 🚀 ШАГ 5: ФИНАЛЬНЫЙ ФИЛЬТР

    // Преобразуем в SmartMoneyFlow с учетом агрегированных позиций
    const inflows: SmartMoneyFlow[] = [];
    const outflows: SmartMoneyFlow[] = [];

    for (const [_, flow] of tokenFlows) {
      // 🔥 ОБЪЕДИНЯЕМ ОДИНОЧНЫЕ ПОКУПКИ + АГРЕГИРОВАННЫЕ ПОЗИЦИИ
      const totalInflowUSD = flow.totalBuyUSD + flow.aggregatedPositionsUSD;
      const netFlowUSD = totalInflowUSD - flow.totalSellUSD;
      
      // 🔥 ОБЪЕДИНЯЕМ УНИКАЛЬНЫЕ КОШЕЛЬКИ
      const uniqueWallets = new Set([
        ...flow.uniqueBuyers,
        ...flow.uniqueSellers,
        ...flow.walletsWithAggregatedPositions
      ]).size;

      // 🔥 ФИНАЛЬНЫЙ ФИЛЬТР: минимум 3 разных Smart Money кошелька и общий объем > $1000
      if (uniqueWallets < this.PROFIT_CONFIG.minUniqueWallets) continue;

      // FDV фильтрация
      if (flow.fdv && (flow.fdv < this.PROFIT_CONFIG.minFDV || flow.fdv > this.PROFIT_CONFIG.maxFDV)) {
        continue;
      }

      const smartMoneyFlow: SmartMoneyFlow = {
        tokenAddress: flow.tokenAddress, tokenSymbol: flow.tokenSymbol, tokenName: flow.tokenName,
        period, totalInflowUSD, totalOutflowUSD: flow.totalSellUSD,
        netFlowUSD, uniqueWallets,
        avgTradeSize: totalInflowUSD / uniqueWallets,
        topWallets: this.getTopWalletsFromFlow(flow)
      };

      // 🔥 ФИНАЛЬНЫЙ ФИЛЬТР: только токены с общим объемом > $1000
      if (netFlowUSD > 0 && totalInflowUSD > 1000) {
        inflows.push(smartMoneyFlow);
        this.logger.debug(`🔥 [INFLOW] ${flow.tokenSymbol}: ${this.formatNumber(totalInflowUSD)} (Single: ${this.formatNumber(flow.totalBuyUSD)}, Aggregated: ${this.formatNumber(flow.aggregatedPositionsUSD)}, Wallets: ${uniqueWallets})`);
      } else if (netFlowUSD < 0 && flow.totalSellUSD > 1000) {
        outflows.push(smartMoneyFlow);
        this.logger.debug(`🔥 [OUTFLOW] ${flow.tokenSymbol}: ${this.formatNumber(flow.totalSellUSD)} (Wallets: ${uniqueWallets})`);
      }
    }

    this.logger.info(`🔥 [ПРОТОКОЛ "ПОЛНЫЙ КОНТРОЛЬ"] ${period} flows: ${inflows.length} inflows, ${outflows.length} outflows`);

    return {
      inflows: inflows.sort((a, b) => b.totalInflowUSD - a.totalInflowUSD),
      outflows: outflows.sort((a, b) => b.totalOutflowUSD - a.totalOutflowUSD)
    };
  }

  // 🚨 КЛЮЧЕВОЙ МЕТОД: КОНТРОЛИРУЕМЫЙ БАТЧИНГ FDV (БЕЗ ВЗРЫВНОЙ НАГРУЗКИ!)
  private async batchGetTokenMetadata(tokens: string[]): Promise<Map<string, any>> {
    const results = new Map();
    
    this.logger.info(`[BatchMetadata] Processing ${tokens.length} tokens with controlled batching (max ${this.CONCURRENT_ENRICH_CALLS} concurrent calls)...`);

    // 🔥 КОНТРОЛИРУЕМОЕ обработка под-батчами (НЕ взрывная нагрузка!)
    for (let i = 0; i < tokens.length; i += this.CONCURRENT_ENRICH_CALLS) {
      const subBatch = tokens.slice(i, i + this.CONCURRENT_ENRICH_CALLS);
      this.logger.debug(`[BatchMetadata] Processing sub-batch ${Math.floor(i/this.CONCURRENT_ENRICH_CALLS) + 1}: [${subBatch.map(t => t.slice(0,8)).join(', ')}]`);

      const batchPromises = subBatch.map(async (token) => {
        try {
          this.logger.debug(`[BatchMetadata] → Requesting enriched info for ${token.slice(0,8)}...`);
          const startTime = Date.now();
          
          // 🔥 Каждый getEnrichedTokenInfoWithFDV делает 2-3 fetch, но мы ограничиваем количество одновременных вызовов
          const data = await this.getEnrichedTokenInfoWithFDV(token);
          
          const duration = Date.now() - startTime;
          if (data) {
            this.logger.debug(`[BatchMetadata] ✅ Received enriched info for ${token.slice(0,8)} (${duration}ms)`);
          } else {
            this.logger.warn(`[BatchMetadata] ⚠️ No enriched data received for ${token.slice(0,8)} (${duration}ms)`);
          }
          
          return { token, data };
        } catch (error) {
          this.logger.warn(`[BatchMetadata] ❌ Failed to get enriched metadata for ${token.slice(0,8)}:`, error);
          return { token, data: null };
        }
      });

      // 🔥 Ждем завершения под-батча (максимум 3 одновременных запроса)
      const batchResults = await Promise.allSettled(batchPromises);

      batchResults.forEach((result) => {
        if (result.status === 'fulfilled' && result.value.data) {
          results.set(result.value.token, result.value.data);
        }
      });

      // 🔥 Пауза между под-батчами (даем API передышку)
      if (i + this.CONCURRENT_ENRICH_CALLS < tokens.length) {
        this.logger.debug(`[BatchMetadata] 💤 Pausing ${this.DELAY_BETWEEN_SUB_BATCHES}ms between sub-batches...`);
        await this.sleep(this.DELAY_BETWEEN_SUB_BATCHES);
      }
    }
    
    this.logger.info(`✅ [BatchMetadata] Controlled batching completed: ${tokens.length} tokens processed, ${results.size} successful enrichments`);
    return results;
  }

  // 🚀 ОПТИМИЗИРОВАННЫЙ Hot New Tokens с ЭКОНОМИЕЙ API
  async findProfitableHotNewTokensBatched(smartWallets: SmartMoneyWallet[]): Promise<HotNewToken[]> {
    const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const hotTokens = new Map<string, {
      tokenAddress: string; tokenSymbol: string; tokenName: string;
      fdv: number | null; smStakeUSD: number; ageHours: number;
      buyVolumeUSD: number; sellVolumeUSD: number; buyCount: number; sellCount: number;
      uniqueSmWallets: Set<string>; topBuyers: Array<{ address: string; amountUSD: number; category: string; }>;
      marketCap: number | null; currentPrice: number | null; profitScore: number;
    }>();

    // 🚀 1. ПЕРВИЧНЫЙ СБОР БЕЗ FDV
    const allHotTokens = new Set<string>();
    for (const wallet of smartWallets) {
      const transactions = await this.getWalletTransactionsAfter(wallet.address, cutoffTime);
      
      for (const tx of transactions) {
        const key = tx.tokenAddress;
        allHotTokens.add(key);
        
        if (!hotTokens.has(key)) {
          hotTokens.set(key, {
            tokenAddress: tx.tokenAddress, tokenSymbol: '', tokenName: '',
            fdv: null, smStakeUSD: 0, ageHours: this.calculateTokenAge(tx.timestamp),
            buyVolumeUSD: 0, sellVolumeUSD: 0, buyCount: 0, sellCount: 0,
            uniqueSmWallets: new Set(), topBuyers: [],
            marketCap: null, currentPrice: null, profitScore: 0
          });
        }

        const token = hotTokens.get(key)!;
        token.uniqueSmWallets.add(tx.walletAddress);

        if (this.isBuyTransaction(tx)) {
          token.buyVolumeUSD += tx.amountUSD;
          token.buyCount++;
          token.smStakeUSD += tx.amountUSD;
          token.topBuyers.push({
            address: tx.walletAddress, amountUSD: tx.amountUSD,
            category: this.getWalletCategory(wallet)
          });
        } else {
          token.sellVolumeUSD += tx.amountUSD;
          token.sellCount++;
          token.smStakeUSD -= tx.amountUSD;
        }
      }
    }

    // 🚀 2. ПЕРВИЧНАЯ ФИЛЬТРАЦИЯ БЕЗ FDV (экономия API)
    const candidateTokens = [];
    for (const [tokenAddress, token] of hotTokens) {
      // Базовые фильтры без FDV
      if (token.ageHours > 24 || 
          token.uniqueSmWallets.size < this.PROFIT_CONFIG.minUniqueWallets || 
          token.buyVolumeUSD < this.PROFIT_CONFIG.minSmBuyVolume) {
        continue;
      }
      candidateTokens.push(tokenAddress);
    }

    this.logger.info(`🔥 Pre-filtered to ${candidateTokens.length}/${allHotTokens.size} hot tokens (saved ${allHotTokens.size - candidateTokens.length} API calls)`);

    // 🚀 3. БАТЧИНГ FDV только для ЛУЧШИХ кандидатов
    const topCandidates = candidateTokens
      .sort((a, b) => {
        const tokenA = hotTokens.get(a)!;
        const tokenB = hotTokens.get(b)!;
        return tokenB.buyVolumeUSD - tokenA.buyVolumeUSD;
      })
      .slice(0, 15); // Только топ-15 для FDV запросов

    this.logger.info(`🔥 Getting FDV for TOP ${topCandidates.length} candidates only`);
    const topTokenMetadata = await this.batchGetTokenMetadata(topCandidates);

    // 🚀 4. Обогащаем ТОЛЬКО топ кандидатов
    const result: HotNewToken[] = [];
    
    for (const tokenAddress of topCandidates) {
      const token = hotTokens.get(tokenAddress)!;
      const metadata = topTokenMetadata.get(tokenAddress);
      
      if (metadata) {
        token.tokenSymbol = metadata.symbol;
        token.tokenName = metadata.name;
        token.fdv = metadata.fdv;
        token.marketCap = metadata.marketCap;
        token.currentPrice = metadata.price;
      } else {
        // Базовые данные если нет метаданных
        token.tokenSymbol = `TOKEN_${tokenAddress.slice(0, 6)}`;
        token.tokenName = 'Unknown Token';
      }

      // FDV фильтрация только если данные есть
      if (token.fdv && (token.fdv < this.PROFIT_CONFIG.minFDV || token.fdv > this.PROFIT_CONFIG.maxFDV)) {
        continue;
      }

      // Profit scoring
      let profitScore = 0;
      if (token.fdv && token.fdv >= this.PROFIT_CONFIG.optimalFDVRange.min && token.fdv <= this.PROFIT_CONFIG.optimalFDVRange.max) {
        profitScore += 30;
      }
      
      if (token.fdv && token.smStakeUSD > 0) {
        const stakePercentage = (token.smStakeUSD / token.fdv) * 100;
        if (stakePercentage > 2) profitScore += 25;
        else if (stakePercentage > 1) profitScore += 15;
        else if (stakePercentage > 0.5) profitScore += 10;
      }
      
      profitScore += Math.min(token.uniqueSmWallets.size * 5, 25);
      const buyRatio = token.buyVolumeUSD / (token.buyVolumeUSD + token.sellVolumeUSD);
      profitScore += buyRatio * 20;

      token.profitScore = profitScore;
      token.topBuyers.sort((a, b) => b.amountUSD - a.amountUSD);
      token.topBuyers = token.topBuyers.slice(0, 5);

      result.push({
        address: token.tokenAddress, symbol: token.tokenSymbol, name: token.tokenName,
        fdv: token.fdv || 0, smStakeUSD: Math.max(0, token.smStakeUSD), ageHours: token.ageHours,
        buyVolumeUSD: token.buyVolumeUSD, sellVolumeUSD: token.sellVolumeUSD,
        buyCount: token.buyCount, sellCount: token.sellCount,
        uniqueSmWallets: token.uniqueSmWallets.size, topBuyers: token.topBuyers
      });
    }

    // 🚀 5. Добавляем токены БЕЗ FDV данных (но с базовой информацией)
    for (const tokenAddress of candidateTokens.slice(15)) {
      const token = hotTokens.get(tokenAddress)!;
      
      // Простые базовые данные
      token.tokenSymbol = `TOKEN_${tokenAddress.slice(0, 6)}`;
      token.tokenName = 'Hot New Token';
      
      result.push({
        address: token.tokenAddress, symbol: token.tokenSymbol, name: token.tokenName,
        fdv: 0, smStakeUSD: Math.max(0, token.smStakeUSD), ageHours: token.ageHours,
        buyVolumeUSD: token.buyVolumeUSD, sellVolumeUSD: token.sellVolumeUSD,
        buyCount: token.buyCount, sellCount: token.sellCount,
        uniqueSmWallets: token.uniqueSmWallets.size, topBuyers: token.topBuyers.slice(0, 5)
      });
    }

    // Сортируем по profit score и активности
    const sortedTokens = result.sort((a, b) => {
      const aToken = hotTokens.get(a.address);
      const bToken = hotTokens.get(b.address);
      const aScore = (aToken?.profitScore || 0) + (a.buyVolumeUSD / 10000);
      const bScore = (bToken?.profitScore || 0) + (b.buyVolumeUSD / 10000);
      return bScore - aScore;
    });

    this.logger.info(`🔥 Found ${sortedTokens.length} hot tokens with OPTIMIZED API usage (${topCandidates.length} FDV calls instead of ${allHotTokens.size})`);
    return sortedTokens.slice(0, 10); // Топ-10 для уведомлений
  }

  // 🆕 ИСПРАВЛЕНО: Оптимизированное обновление метрик кошельков с новыми полями
  private async updateWalletPerformanceMetricsOptimized(smartWallets: SmartMoneyWallet[]): Promise<void> {
    this.logger.info('📊 Updating wallet performance (optimized - 10 wallets max)...');

    const WALLET_LIMIT = 10; // 🔥 ЛИМИТ для экономии API
    const walletsToUpdate = smartWallets.slice(0, WALLET_LIMIT);
    
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    for (const wallet of walletsToUpdate) {
      try {
        const cached = this.walletPerformanceCache.get(wallet.address);
        if (cached && Date.now() - cached.timestamp < this.WALLET_PERFORMANCE_TTL) {
          continue;
        }

        const [allTransactions, recentTransactions] = await Promise.all([
          this.getWalletTransactionsAfter(wallet.address, thirtyDaysAgo),
          this.getWalletTransactionsAfter(wallet.address, sevenDaysAgo)
        ]);

        if (allTransactions.length === 0) continue;

        const last30DaysPnL = this.calculatePnLFromTransactions(allTransactions);
        const last7DaysPnL = this.calculatePnLFromTransactions(recentTransactions);
        const recentWinRate = this.calculateWinRate(recentTransactions);
        const realTimeScore = this.calculateRealTimeScore({
          last30DaysPnL, last7DaysPnL, recentWinRate,
          profitFactor: this.calculateProfitFactor(allTransactions),
          totalTrades: allTransactions.length
        });

        // 🔥 ИСПРАВЛЕНО: Используем новые поля SmartMoneyWallet
        const avgTradeSize = wallet.buy7d > 0 ? wallet.usdProfit7d / wallet.buy7d : 1000;
        
        const metrics: WalletPerformanceMetrics = {
          address: wallet.address, 
          currentPnL: wallet.usdProfit7d, // 🔥 ИСПРАВЛЕНО: используем usdProfit7d вместо totalPnL
          last30DaysPnL, last7DaysPnL, profitFactor: 0, maxDrawdown: 0,
          avgHoldTime: wallet.avgHoldingMins || 0, // 🔥 ИСПРАВЛЕНО: используем avgHoldingMins
          recentWinRate, volumeWeightedPrice: 0,
          riskAdjustedReturn: last30DaysPnL / Math.max(avgTradeSize, 1000), // 🔥 ИСПРАВЛЕНО: рассчитываем avgTradeSize
          realTimeScore, trendDirection: last7DaysPnL > 0 ? 'up' : last7DaysPnL < 0 ? 'down' : 'stable',
          hotStreak: this.calculateHotStreak(recentTransactions), recentHitRate: recentWinRate
        };

        this.walletPerformanceCache.set(wallet.address, { metrics, timestamp: Date.now() });

        if (realTimeScore !== wallet.performanceScore) {
          // 🔥 ФИНАЛЬНОЕ ИСПРАВЛЕНИЕ: Данные из CSV - источник правды, только обновляем performanceScore
          await this.smDatabase.updateWalletPerformance(wallet.address, {
            winrate7d: wallet.winrate7d,    // Берем из CSV (источник правды)
            usdProfit7d: wallet.usdProfit7d, // Берем из CSV (источник правды) 
            buy7d: wallet.buy7d,            // Берем из CSV (источник правды)
            lastActiveAt: new Date(),
            performanceScore: realTimeScore  // Обновляем на основе fresh анализа
          });
        }

      } catch (error) {
        this.logger.error(`Error updating wallet ${wallet.address}:`, error);
      }
    }

    this.logger.info(`✅ Updated ${walletsToUpdate.length}/${smartWallets.length} wallets (API optimized)`);
  }

  // 🔥 HOLDINGS с БАТЧИНГ FDV
  async analyzeSmartMoneyHoldings(): Promise<HoldingsReport> {
    this.logger.info('📊 Starting OPTIMIZED holdings analysis...');

    try {
      const smartWallets = await this.smDatabase.getAllActiveSmartWallets();
      const holdings = await this.calculateHoldingsWithEnhancedFDVBatched(smartWallets);
      
      const byWalletCount = [...holdings].sort((a, b) => b.uniqueWalletCount - a.uniqueWalletCount).slice(0, 20);
      const byBalance = [...holdings].sort((a, b) => b.totalBalanceUSD - a.totalBalanceUSD).slice(0, 20);

      const totalValueUSD = holdings.reduce((sum, h) => sum + h.totalBalanceUSD, 0);
      const totalFDV = holdings.reduce((sum, h) => sum + (h.fdv || 0), 0);

      const report: HoldingsReport = {
        byWalletCount, byBalance, totalTokens: holdings.length, totalValueUSD, analysisTime: new Date(),
        summary: {
          topTokenByWallets: byWalletCount[0]?.tokenSymbol || 'N/A',
          topTokenByValue: byBalance[0]?.tokenSymbol || 'N/A',
          avgHoldingDays: holdings.length > 0 ? holdings.reduce((sum, h) => sum + h.avgHoldingDays, 0) / holdings.length : 0,
          totalUniqueWallets: new Set(holdings.flatMap(h => h.topHolders.map(th => th.address))).size,
          totalFDV, avgTokenFDV: holdings.length > 0 ? totalFDV / holdings.length : 0
        }
      };

      this.logger.info(`✅ OPTIMIZED Holdings: ${report.totalTokens} tokens, $${this.formatNumber(totalValueUSD)} value`);
      return report;
    } catch (error) {
      this.logger.error('❌ Error in holdings analysis:', error);
      throw error;
    }
  }

  // 🧮 HOLDINGS с батчинг FDV - ИСПРАВЛЕННАЯ ТИПИЗАЦИЯ
  private async calculateHoldingsWithEnhancedFDVBatched(smartWallets: SmartMoneyWallet[]): Promise<TokenHolding[]> {
    const cacheKey = 'enhanced_holdings_batched';
    const cached = this.holdingsCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.HOLDINGS_CACHE_TTL) {
      return cached.data;
    }

    // 🔥 ИСПРАВЛЕННАЯ ТИПИЗАЦИЯ
    const tokenData = new Map<string, TokenData>();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const allTokensSet = new Set<string>();
    
    // Собираем все токены
    for (const wallet of smartWallets) {
      const transactions = await this.getWalletTransactionsAfter(wallet.address, thirtyDaysAgo);
      
      for (const tx of transactions) {
        allTokensSet.add(tx.tokenAddress);
        const key = tx.tokenAddress;
        
        if (!tokenData.has(key)) {
          tokenData.set(key, {
            tokenAddress: tx.tokenAddress, 
            wallets: new Map<string, WalletTokenData>(), 
            firstSeenAt: tx.timestamp
          });
        }

        const token = tokenData.get(key)!;
        if (!token.wallets.has(wallet.address)) {
          token.wallets.set(wallet.address, {
            category: wallet.category, 
            buyVolume: 0, 
            sellVolume: 0, 
            netPosition: 0,
            firstBuyTime: tx.timestamp, 
            lastActivityTime: tx.timestamp, 
            transactions: []
          });
        }

        const walletData = token.wallets.get(wallet.address)!;
        walletData.transactions.push(tx);
        walletData.lastActivityTime = new Date(Math.max(walletData.lastActivityTime.getTime(), tx.timestamp.getTime()));

        if (this.isBuyTransaction(tx)) {
          walletData.buyVolume += tx.amountUSD;
          walletData.netPosition += tx.amountUSD;
          if (tx.timestamp < walletData.firstBuyTime) walletData.firstBuyTime = tx.timestamp;
        } else {
          walletData.sellVolume += tx.amountUSD;
          walletData.netPosition -= tx.amountUSD;
        }
      }
    }

    // 🚀 БАТЧИНГ FDV для топ-20 токенов по балансу
    const topTokensByBalance = Array.from(tokenData.entries())
      .map(([address, data]) => ({
        address,
        totalBalance: Array.from(data.wallets.values()).reduce((sum, w) => sum + Math.max(0, w.netPosition), 0)
      }))
      .sort((a, b) => b.totalBalance - a.totalBalance)
      .slice(0, 20) // Только топ-20 для FDV
      .map(item => item.address);

    this.logger.info(`🔥 Getting FDV for TOP ${topTokensByBalance.length} holdings (instead of ${allTokensSet.size})`);
    const tokenMetadata = await this.batchGetTokenMetadata(topTokensByBalance);

    // Преобразуем в TokenHolding
    const holdings: TokenHolding[] = [];
    for (const [tokenAddress, token] of tokenData) {
      const validWallets = Array.from(token.wallets.entries()).filter(([_, data]) => data.netPosition > 100);
      if (validWallets.length === 0) continue;

      const metadata = tokenMetadata.get(tokenAddress);
      const categoryCount = {
        sniper: validWallets.filter(([_, data]) => data.category === 'sniper').length,
        hunter: validWallets.filter(([_, data]) => data.category === 'hunter').length,
        trader: validWallets.filter(([_, data]) => data.category === 'trader').length
      };

      const totalBalance = validWallets.reduce((sum, [_, data]) => sum + data.netPosition, 0);
      const holding: TokenHolding = {
        tokenAddress, tokenSymbol: metadata?.symbol || `TOKEN_${tokenAddress.slice(0, 6)}`,
        tokenName: metadata?.name || 'Unknown Token',
        uniqueWalletCount: validWallets.length,
        sniperWallets: categoryCount.sniper, hunterWallets: categoryCount.hunter, traderWallets: categoryCount.trader,
        totalBalanceUSD: totalBalance, 
        avgBalancePerWallet: totalBalance / validWallets.length,
        maxSingleHolding: Math.max(...validWallets.map(([_, data]) => data.netPosition)),
        fdv: metadata?.fdv, marketCap: metadata?.marketCap, priceChange24h: null,
        liquidityScore: this.calculateLiquidityScore(metadata || {}),
        firstSeenAt: token.firstSeenAt, avgHoldingDays: 0,
        totalBuyVolume: validWallets.reduce((sum, [_, data]) => sum + data.buyVolume, 0),
        totalSellVolume: validWallets.reduce((sum, [_, data]) => sum + data.sellVolume, 0),
        netFlow: 0,
        topHolders: validWallets.sort((a, b) => b[1].netPosition - a[1].netPosition).slice(0, 5)
          .map(([address, data]) => ({
            address, category: data.category, balanceUSD: data.netPosition,
            holdingDays: Math.round((data.lastActivityTime.getTime() - data.firstBuyTime.getTime()) / (1000 * 60 * 60 * 24))
          }))
      };

      holdings.push(holding);
    }

    this.holdingsCache.set(cacheKey, { data: holdings, timestamp: Date.now() });
    return holdings;
  }

  // Компактные вспомогательные методы
  private async getEnrichedTokenInfoWithFDV(tokenAddress: string) {
    const cached = this.enrichedTokenCache.get(tokenAddress);
    if (cached && Date.now() - cached.timestamp < this.TOKEN_CACHE_TTL) return cached;

    try {
      const enhancedInfo = await this.tokenMetadataService.getEnhancedTokenInfo(tokenAddress);
      if (enhancedInfo) {
        const result = { symbol: enhancedInfo.symbol, name: enhancedInfo.name, price: enhancedInfo.price, fdv: enhancedInfo.fdv, marketCap: enhancedInfo.marketCap, timestamp: Date.now() };
        this.enrichedTokenCache.set(tokenAddress, result);
        return result;
      }
    } catch (error) {
      this.logger.error(`Error getting enhanced token info for ${tokenAddress}:`, error);
    }

    const fallback = { symbol: `TOKEN_${tokenAddress.slice(0, 6)}`, name: `Token ${tokenAddress.slice(0, 8)}...`, price: null, fdv: null, marketCap: null, timestamp: Date.now() };
    this.enrichedTokenCache.set(tokenAddress, fallback);
    return fallback;
  }

  private calculateRealTimeScore(metrics: { last30DaysPnL: number; last7DaysPnL: number; recentWinRate: number; profitFactor: number; totalTrades: number; }): number {
    const { last30DaysPnL, last7DaysPnL, recentWinRate, profitFactor, totalTrades } = metrics;
    const pnlScore30 = Math.min(Math.max(last30DaysPnL / 50000, 0), 1) * 100;
    const pnlScore7 = Math.min(Math.max(last7DaysPnL / 20000, 0), 1) * 100;
    const score = (pnlScore30 * 0.24 + pnlScore7 * 0.16 + recentWinRate * 0.25 + Math.min(profitFactor * 20, 100) * 0.2 + Math.min(totalTrades * 2, 100) * 0.15);
    return Math.round(Math.min(score, 100));
  }

  private calculateLiquidityScore(tokenInfo: any): number {
    let score = 50;
    if (tokenInfo.fdv) {
      if (tokenInfo.fdv > 10_000_000) score += 20;
      else if (tokenInfo.fdv > 1_000_000) score += 10;
      else if (tokenInfo.fdv < 100_000) score -= 20;
    }
    return Math.max(0, Math.min(100, score));
  }

  // Компактные расчетные методы
  private calculatePnLFromTransactions(transactions: TokenSwap[]): number {
    return transactions.reduce((total, tx) => total + (tx.swapType === 'sell' ? tx.amountUSD : -tx.amountUSD), 0);
  }

  private calculateProfitFactor(transactions: TokenSwap[]): number {
    let profit = 0, loss = 0;
    transactions.forEach(tx => tx.amountUSD > 0 ? profit += tx.amountUSD : loss += Math.abs(tx.amountUSD));
    return loss > 0 ? profit / loss : profit > 0 ? 10 : 1;
  }

  private calculateWinRate(transactions: TokenSwap[]): number {
    if (transactions.length === 0) return 0;
    return (transactions.filter(tx => tx.amountUSD > 0).length / transactions.length) * 100;
  }

  private calculateHotStreak(transactions: TokenSwap[]): number {
    let streak = 0, maxStreak = 0;
    for (const tx of transactions.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())) {
      if (tx.amountUSD > 0) {
        streak++;
        maxStreak = Math.max(maxStreak, streak);
      } else {
        streak = 0;
      }
    }
    return maxStreak;
  }

  private getTopWalletsFromFlow(flow: any): Array<{ address: string; amountUSD: number; category: string }> {
    const walletTotals = new Map<string, { total: number; category: string }>();
    for (const tx of flow.transactions) {
      if (!walletTotals.has(tx.walletAddress)) {
        walletTotals.set(tx.walletAddress, { total: 0, category: 'unknown' });
      }
      walletTotals.get(tx.walletAddress)!.total += tx.amountUSD;
    }
    return Array.from(walletTotals.entries()).sort((a, b) => b[1].total - a[1].total).slice(0, 5)
      .map(([address, data]) => ({ address, amountUSD: data.total, category: data.category }));
  }

  // Утилиты
  private async getWalletTransactionsAfter(walletAddress: string, afterDate: Date): Promise<TokenSwap[]> {
    try {
      const smTransactions = await this.smDatabase.getSmartWalletTransactions(walletAddress, afterDate);
      return smTransactions.length > 0 ? smTransactions : await this.database.getWalletTransactionsAfter(walletAddress, afterDate);
    } catch (error) {
      return [];
    }
  }

  private isBuyTransaction(tx: TokenSwap): boolean { return tx.swapType === 'buy'; }
  private getWalletCategory(wallet: SmartMoneyWallet): 'sniper' | 'hunter' | 'trader' { return wallet.category; }
  private calculateTokenAge(timestamp: Date): number { return (Date.now() - timestamp.getTime()) / (1000 * 60 * 60); }
  private formatNumber(num: number): string {
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
    if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
    return num.toFixed(0);
  }
  private sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

  // Публичные методы
  async sendFlowAnalysisNotifications(result: FlowAnalysisResult): Promise<void> {
    try {
      if (result.topInflowsLastHour.length > 0) {
        const inflows = result.topInflowsLastHour.map(flow => ({
          tokenSymbol: flow.tokenSymbol, tokenAddress: flow.tokenAddress,
          inflowUSD: flow.totalInflowUSD, walletCount: flow.uniqueWallets || 0, topWallets: flow.topWallets || []
        }));
        await this.telegramNotifier.sendTopSmartMoneyInflows(inflows);
      }

      for (const hotToken of result.hotNewTokens.slice(0, 5)) {
        await this.telegramNotifier.sendHotNewTokenAlert(hotToken);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) {
      this.logger.error('❌ Error sending notifications:', error);
    }
  }

  async sendHoldingsReport(report: HoldingsReport): Promise<void> {
    try {
      await this.telegramNotifier.sendCycleLog(
        `📊 <b>ПРОТОКОЛ "ПОЛНЫЙ КОНТРОЛЬ" Holdings Report</b>\n\n` +
        `🏷️ Tokens: <code>${report.totalTokens}</code>\n` +
        `💰 Value: <code>$${this.formatNumber(report.totalValueUSD)}</code>\n` +
        `💎 Total FDV: <code>$${this.formatNumber(report.summary.totalFDV)}</code>\n` +
        `📈 Avg FDV: <code>$${this.formatNumber(report.summary.avgTokenFDV)}</code>\n` +
        `👥 Wallets: <code>${report.summary.totalUniqueWallets}</code>\n` +
        `🥇 Top by Wallets: <code>#${report.summary.topTokenByWallets}</code>\n` +
        `💎 Top by Value: <code>#${report.summary.topTokenByValue}</code>`
      );

      if (report.byWalletCount.length > 0) {
        let message = `🟢 <b>Top Smart Money Inflows in the past 1 hour (Solana)</b> #TopSMIn1sol\n\n`;
        report.byWalletCount.slice(0, 10).forEach(token => {
         message += `#${token.tokenSymbol} $${Math.round(token.totalBalanceUSD).toLocaleString()} SolS DS\n`;
        });
        await this.telegramNotifier.sendCycleLog(message);
      }
    } catch (error) {
      this.logger.error('❌ Error sending holdings report:', error);
    }
  }
  
        
      
  // 🆕 ПУБЛИЧНЫЙ МЕТОД для обновления одного кошелька
  async updateSingleWalletMetrics(wallet: SmartMoneyWallet): Promise<void> {
    await this.updateWalletPerformanceMetricsOptimized([wallet]);
  }

  getCacheStats() {
    return {
      holdingsCache: this.holdingsCache.size,
      enrichedTokenCache: this.enrichedTokenCache.size,
      walletPerformanceCache: this.walletPerformanceCache.size,
      cacheHitRate: 0
    };
  }

  clearCache(): void {
    this.holdingsCache.clear();
    this.enrichedTokenCache.clear();
    this.walletPerformanceCache.clear();
  }
}