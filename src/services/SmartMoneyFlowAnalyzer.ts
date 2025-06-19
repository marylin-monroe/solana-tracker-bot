// src/services/SmartMoneyFlowAnalyzer.ts - PROFIT-FIRST: Real FDV + Dynamic Wallet Evaluation
import { SmartMoneyDatabase } from './SmartMoneyDatabase';
import { Database } from './Database';
import { TelegramNotifier } from './TelegramNotifier';
import { TokenMetadataService } from './TokenMetadataService';
import { Logger } from '../utils/Logger';
import {
  TokenSwap,
  SmartMoneyFlow,
  HotNewToken,
  SmartMoneyWallet
} from '../types';

export interface FlowAnalysisResult {
  inflows: SmartMoneyFlow[];
  outflows: SmartMoneyFlow[];
  hotNewTokens: HotNewToken[];
  topInflowsLastHour: SmartMoneyFlow[];
}

// 🆕 НОВЫЕ ИНТЕРФЕЙСЫ ДЛЯ HOLDINGS
export interface TokenHolding {
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  
  // Wallet Count метрики
  uniqueWalletCount: number;
  sniperWallets: number;
  hunterWallets: number;
  traderWallets: number;
  
  // Balance метрики  
  totalBalanceUSD: number;
  avgBalancePerWallet: number;
  maxSingleHolding: number;
  
  // 🆕 PROFIT-FIRST МЕТРИКИ
  fdv: number | null;           // Реальный FDV
  marketCap: number | null;     // Market cap если доступен
  priceChange24h: number | null; // Изменение цены за 24ч
  liquidityScore: number;       // Оценка ликвидности
  
  // Дополнительная аналитика
  firstSeenAt: Date;
  avgHoldingDays: number;
  totalBuyVolume: number;
  totalSellVolume: number;
  netFlow: number;
  
  // Топ холдеры
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
    totalFDV: number;               // 🆕 Общий FDV портфеля
    avgTokenFDV: number;            // 🆕 Средний FDV токена
  };
}

// 🆕 WALLET PERFORMANCE TRACKING (для динамической оценки)
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
  
  // 🆕 PROFIT-FIRST SCORING
  realTimeScore: number;          // Текущий рейтинг
  trendDirection: 'up' | 'down' | 'stable';
  hotStreak: number;              // Количество подряд успешных сделок
  recentHitRate: number;          // Процент попаданий за последние сделки
}

export class SmartMoneyFlowAnalyzer {
  private smDatabase: SmartMoneyDatabase;
  private database: Database;
  private telegramNotifier: TelegramNotifier;
  private readonly tokenMetadataService: TokenMetadataService;
  private logger: Logger;
  private quickNodeApiKey: string;

  // 🆕 КЕШ ДЛЯ HOLDINGS
  private holdingsCache = new Map<string, { data: TokenHolding[]; timestamp: number }>();
  private readonly HOLDINGS_CACHE_TTL = 15 * 60 * 1000; // 15 минут

  // 🆕 КЕШ ДЛЯ ОБОГАЩЕНИЯ ТОКЕНОВ
  private enrichedTokenCache = new Map<string, {
    symbol: string;
    name: string;
    price: number | null;
    fdv: number | null;
    marketCap: number | null;
    timestamp: number;
  }>();
  private readonly TOKEN_CACHE_TTL = 10 * 60 * 1000; // 10 минут

  // 🆕 КЕШ ДЛЯ ДИНАМИЧЕСКОЙ ОЦЕНКИ КОШЕЛЬКОВ
  private walletPerformanceCache = new Map<string, { metrics: WalletPerformanceMetrics; timestamp: number }>();
  private readonly WALLET_PERFORMANCE_TTL = 30 * 60 * 1000; // 30 минут

  // 🚀 PROFIT-FIRST КОНФИГУРАЦИЯ
  private readonly PROFIT_CONFIG = {
    // FDV фильтры для Hot New Tokens
    minFDV: 1_000_000,           // $1M минимум FDV
    maxFDV: 500_000_000,         // $500M максимум FDV (избегаем overvalued)
    optimalFDVRange: {
      min: 5_000_000,            // $5M оптимальный минимум 
      max: 100_000_000           // $100M оптимальный максимум
    },
    
    // Минимальные объемы для анализа
    minSmBuyVolume: 25_000,      // $25K минимум покупок SM
    minUniqueWallets: 3,         // 3+ уникальных кошелька
    
    // Performance scoring weights
    performanceWeights: {
      recentPnL: 0.4,            // Последний PnL важнее
      winRate: 0.25,
      profitFactor: 0.2,
      consistency: 0.15
    }
  };

  constructor(
    smDatabase: SmartMoneyDatabase, 
    telegramNotifier: TelegramNotifier,
    database: Database,
    tokenMetadataService: TokenMetadataService
  ) {
    this.smDatabase = smDatabase;
    this.database = database;
    this.telegramNotifier = telegramNotifier;
    this.tokenMetadataService = tokenMetadataService;
    this.logger = Logger.getInstance();
    this.quickNodeApiKey = process.env.QUICKNODE_API_KEY!;

    this.logger.info('📊 SmartMoneyFlowAnalyzer initialized (PROFIT-FIRST MODE with Real FDV)');
  }

  // ========== ОСНОВНЫЕ МЕТОДЫ С REAL FDV INTEGRATION ==========

  /**
   * 🔍 ГЛАВНЫЙ МЕТОД: Анализ Smart Money потоков с реальными FDV
   */
  async analyzeSmartMoneyFlows(): Promise<FlowAnalysisResult> {
    this.logger.info('🔍 Starting PROFIT-FIRST Smart Money Flow Analysis...');

    try {
      // Получаем активные Smart Money кошельки
      const smartWallets = await this.smDatabase.getAllActiveSmartWallets();
      this.logger.info(`Analyzing flows for ${smartWallets.length} Smart Money wallets`);

      // 🆕 Обновляем performance метрики кошельков
      await this.updateWalletPerformanceMetrics(smartWallets);

      // Анализируем потоки за последний час и 24 часа с улучшенной фильтрацией
      const [hourlyFlows, dailyFlows] = await Promise.all([
        this.calculateFlowsWithFDV(smartWallets, '1h'),
        this.calculateFlowsWithFDV(smartWallets, '24h')
      ]);

      // 🚀 ГЛАВНОЕ: Hot New Tokens с РЕАЛЬНЫМИ FDV и смарт-фильтрацией
      const hotNewTokens = await this.findProfitableHotNewTokens(smartWallets);

      // Определяем топ притоки за час
      const topInflowsLastHour = hourlyFlows.inflows
        .sort((a, b) => b.totalInflowUSD - a.totalInflowUSD)
        .slice(0, 10);

      const result: FlowAnalysisResult = {
        inflows: [...hourlyFlows.inflows, ...dailyFlows.inflows],
        outflows: [...hourlyFlows.outflows, ...dailyFlows.outflows],
        hotNewTokens,
        topInflowsLastHour
      };

      this.logger.info(`✅ PROFIT-FIRST Analysis complete: ${result.inflows.length} inflows, ${result.hotNewTokens.length} hot tokens with real FDV`);
      return result;

    } catch (error) {
      this.logger.error('❌ Error in PROFIT-FIRST Smart Money Flow Analysis:', error);
      throw error;
    }
  }

  /**
   * 🔥 УЛУЧШЕННЫЙ: calculateFlows с реальными FDV данными
   */
  private async calculateFlowsWithFDV(
    smartWallets: SmartMoneyWallet[], 
    period: '1h' | '24h'
  ): Promise<{ inflows: SmartMoneyFlow[]; outflows: SmartMoneyFlow[] }> {
    
    const hours = period === '1h' ? 1 : 24;
    const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);

    // Группируем транзакции по токенам
    const tokenFlows = new Map<string, {
      tokenAddress: string;
      tokenSymbol: string;
      tokenName: string;
      totalBuyUSD: number;
      totalSellUSD: number;
      uniqueBuyers: Set<string>;
      uniqueSellers: Set<string>;
      transactions: TokenSwap[];
      fdv: number | null;              // 🆕 Real FDV
      marketCap: number | null;        // 🆕 Market cap
    }>();

    // Получаем транзакции Smart Money кошельков за период
    for (const wallet of smartWallets) {
      const transactions = await this.getWalletTransactionsAfter(wallet.address, cutoffTime);
      
      for (const tx of transactions) {
        const key = tx.tokenAddress;
        
        if (!tokenFlows.has(key)) {
          // 🆕 ОБОГАЩАЕМ ДАННЫЕ ЧЕРЕЗ TokenMetadataService (включая FDV)
          const enrichedToken = await this.getEnrichedTokenInfoWithFDV(tx.tokenAddress);
          
          tokenFlows.set(key, {
            tokenAddress: tx.tokenAddress,
            tokenSymbol: enrichedToken.symbol,
            tokenName: enrichedToken.name,
            totalBuyUSD: 0,
            totalSellUSD: 0,
            uniqueBuyers: new Set(),
            uniqueSellers: new Set(),
            transactions: [],
            fdv: enrichedToken.fdv,
            marketCap: enrichedToken.marketCap
          });
        }

        const flow = tokenFlows.get(key)!;
        flow.transactions.push(tx);

        // Определяем тип операции
        if (this.isBuyTransaction(tx)) {
          flow.totalBuyUSD += tx.amountUSD;
          flow.uniqueBuyers.add(tx.walletAddress);
        } else {
          flow.totalSellUSD += tx.amountUSD;
          flow.uniqueSellers.add(tx.walletAddress);
        }
      }
    }

    // Преобразуем в SmartMoneyFlow объекты с улучшенной фильтрацией
    const inflows: SmartMoneyFlow[] = [];
    const outflows: SmartMoneyFlow[] = [];

    for (const [_, flow] of tokenFlows) {
      const netFlowUSD = flow.totalBuyUSD - flow.totalSellUSD;
      const uniqueWallets = flow.uniqueBuyers.size + flow.uniqueSellers.size;

      // 🚀 PROFIT-FIRST ФИЛЬТРАЦИЯ
      if (uniqueWallets < 2) continue; // Минимум 2 кошелька

      // Фильтр по FDV (избегаем мусорные и переоцененные токены)
      if (flow.fdv) {
        if (flow.fdv < this.PROFIT_CONFIG.minFDV || flow.fdv > this.PROFIT_CONFIG.maxFDV) {
          continue;
        }
      }

      const smartMoneyFlow: SmartMoneyFlow = {
        tokenAddress: flow.tokenAddress,
        tokenSymbol: flow.tokenSymbol,
        tokenName: flow.tokenName,
        period,
        totalInflowUSD: flow.totalBuyUSD,
        totalOutflowUSD: flow.totalSellUSD,
        netFlowUSD,
        uniqueWallets,
        avgTradeSize: (flow.totalBuyUSD + flow.totalSellUSD) / (flow.uniqueBuyers.size + flow.uniqueSellers.size),
        topWallets: this.getTopWalletsFromFlow(flow)
      };

      if (netFlowUSD > 0 && flow.totalBuyUSD > 5000) { // Минимальный приток $5K
        inflows.push(smartMoneyFlow);
      } else if (netFlowUSD < 0 && flow.totalSellUSD > 5000) { // Минимальный отток $5K
        outflows.push(smartMoneyFlow);
      }
    }

    return {
      inflows: inflows.sort((a, b) => b.totalInflowUSD - a.totalInflowUSD),
      outflows: outflows.sort((a, b) => b.totalOutflowUSD - a.totalOutflowUSD)
    };
  }

  /**
   * 🚀 ГЛАВНОЕ УЛУЧШЕНИЕ: findProfitableHotNewTokens с РЕАЛЬНЫМИ FDV и смарт-фильтрацией
   */
  private async findProfitableHotNewTokens(smartWallets: SmartMoneyWallet[]): Promise<HotNewToken[]> {
    const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 часа назад
    
    // Группируем транзакции по новым токенам
    const hotTokens = new Map<string, {
      tokenAddress: string;
      tokenSymbol: string;
      tokenName: string;
      fdv: number | null;                    // 🚀 REAL FDV
      smStakeUSD: number;                    // 🚀 REAL SM stake calculation
      ageHours: number;
      buyVolumeUSD: number;
      sellVolumeUSD: number;
      buyCount: number;
      sellCount: number;
      uniqueSmWallets: Set<string>;
      topBuyers: Array<{
        address: string;
        amountUSD: number;
        category: string;
      }>;
      marketCap: number | null;
      currentPrice: number | null;
      profitScore: number;                   // 🆕 Profit potential score
    }>();

    // Анализируем транзакции за последние 24 часа
    this.logger.info('🔍 Analyzing Hot New Tokens transactions...');
    
    for (const wallet of smartWallets) {
      const transactions = await this.getWalletTransactionsAfter(wallet.address, cutoffTime);
      
      for (const tx of transactions) {
        const key = tx.tokenAddress;
        
        if (!hotTokens.has(key)) {
          // 🆕 ПОЛУЧАЕМ ПОЛНУЮ ИНФОРМАЦИЮ ВКЛЮЧАЯ FDV
          const enrichedToken = await this.getEnrichedTokenInfoWithFDV(tx.tokenAddress);
          
          hotTokens.set(key, {
            tokenAddress: tx.tokenAddress,
            tokenSymbol: enrichedToken.symbol,
            tokenName: enrichedToken.name,
            fdv: enrichedToken.fdv,
            smStakeUSD: 0, // Будем рассчитывать
            ageHours: this.calculateTokenAge(tx.timestamp),
            buyVolumeUSD: 0,
            sellVolumeUSD: 0,
            buyCount: 0,
            sellCount: 0,
            uniqueSmWallets: new Set(),
            topBuyers: [],
            marketCap: enrichedToken.marketCap,
            currentPrice: enrichedToken.price,
            profitScore: 0
          });
        }

        const token = hotTokens.get(key)!;
        token.uniqueSmWallets.add(tx.walletAddress);

        if (this.isBuyTransaction(tx)) {
          token.buyVolumeUSD += tx.amountUSD;
          token.buyCount++;
          token.smStakeUSD += tx.amountUSD; // 🚀 REAL SM stake calculation
          
          // Добавляем к топ покупателям
          token.topBuyers.push({
            address: tx.walletAddress,
            amountUSD: tx.amountUSD,
            category: this.getWalletCategory(wallet)
          });
        } else {
          token.sellVolumeUSD += tx.amountUSD;
          token.sellCount++;
          token.smStakeUSD -= tx.amountUSD; // Вычитаем продажи
        }
      }
    }

    // 🚀 PROFIT-FIRST ФИЛЬТРАЦИЯ и SCORING
    const result: HotNewToken[] = [];
    
    for (const [_, token] of hotTokens) {
      // Базовые фильтры
      if (token.ageHours > 24 || 
          token.uniqueSmWallets.size < this.PROFIT_CONFIG.minUniqueWallets || 
          token.buyVolumeUSD < this.PROFIT_CONFIG.minSmBuyVolume) {
        continue;
      }

      // 🔥 FDV ФИЛЬТРАЦИЯ (главная инновация)
      if (token.fdv) {
        if (token.fdv < this.PROFIT_CONFIG.minFDV || token.fdv > this.PROFIT_CONFIG.maxFDV) {
          this.logger.debug(`⚠️ Filtered ${token.tokenSymbol}: FDV $${token.fdv.toLocaleString()} outside profitable range`);
          continue;
        }
      } else {
        // Если FDV неизвестен, применяем более строгие критерии
        if (token.buyVolumeUSD < this.PROFIT_CONFIG.minSmBuyVolume * 2) {
          continue;
        }
      }

      // 🎯 PROFIT SCORING
      let profitScore = 0;
      
      // FDV в оптимальном диапазоне = бонус
      if (token.fdv && 
          token.fdv >= this.PROFIT_CONFIG.optimalFDVRange.min && 
          token.fdv <= this.PROFIT_CONFIG.optimalFDVRange.max) {
        profitScore += 30;
      }
      
      // Высокий SM stake относительно FDV = бонус
      if (token.fdv && token.smStakeUSD > 0) {
        const stakePercentage = (token.smStakeUSD / token.fdv) * 100;
        if (stakePercentage > 2) profitScore += 25; // >2% владения SM
        else if (stakePercentage > 1) profitScore += 15; // >1% владения SM
        else if (stakePercentage > 0.5) profitScore += 10; // >0.5% владения SM
      }
      
      // Количество уникальных кошельков
      profitScore += Math.min(token.uniqueSmWallets.size * 5, 25);
      
      // Buy/Sell соотношение
      const buyRatio = token.buyVolumeUSD / (token.buyVolumeUSD + token.sellVolumeUSD);
      profitScore += buyRatio * 20;

      token.profitScore = profitScore;

      // Сортируем топ покупателей
      token.topBuyers.sort((a, b) => b.amountUSD - a.amountUSD);
      token.topBuyers = token.topBuyers.slice(0, 5);

      result.push({
        address: token.tokenAddress,
        symbol: token.tokenSymbol,
        name: token.tokenName,
        fdv: token.fdv || 0,                    // 🚀 REAL FDV
        smStakeUSD: Math.max(0, token.smStakeUSD), // 🚀 REAL SM stake
        ageHours: token.ageHours,
        buyVolumeUSD: token.buyVolumeUSD,
        sellVolumeUSD: token.sellVolumeUSD,
        buyCount: token.buyCount,
        sellCount: token.sellCount,
        uniqueSmWallets: token.uniqueSmWallets.size,
        topBuyers: token.topBuyers
      });
    }

    // Сортируем по profit score для максимальной прибыльности
    const sortedTokens = result.sort((a, b) => {
      const aToken = hotTokens.get(a.address);
      const bToken = hotTokens.get(b.address);
      return (bToken?.profitScore || 0) - (aToken?.profitScore || 0);
    });

    this.logger.info(`🔥 Found ${sortedTokens.length} profitable Hot New Tokens with real FDV analysis`);
    return sortedTokens;
  }

  /**
   * 🆕 ДИНАМИЧЕСКАЯ ОЦЕНКА ПРОИЗВОДИТЕЛЬНОСТИ КОШЕЛЬКОВ
   */
  private async updateWalletPerformanceMetrics(smartWallets: SmartMoneyWallet[]): Promise<void> {
    this.logger.info('📊 Updating wallet performance metrics...');

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    for (const wallet of smartWallets.slice(0, 20)) { // Лимитируем для API efficiency
      try {
        const cached = this.walletPerformanceCache.get(wallet.address);
        if (cached && Date.now() - cached.timestamp < this.WALLET_PERFORMANCE_TTL) {
          continue; // Используем кеш
        }

        // Получаем транзакции за разные периоды
        const [allTransactions, recentTransactions] = await Promise.all([
          this.getWalletTransactionsAfter(wallet.address, thirtyDaysAgo),
          this.getWalletTransactionsAfter(wallet.address, sevenDaysAgo)
        ]);

        if (allTransactions.length === 0) continue;

        // Расчет метрик
        const last30DaysPnL = this.calculatePnLFromTransactions(allTransactions);
        const last7DaysPnL = this.calculatePnLFromTransactions(recentTransactions);
        const profitFactor = this.calculateProfitFactor(allTransactions);
        const recentWinRate = this.calculateWinRate(recentTransactions);
        const avgHoldTime = this.calculateAvgHoldTime(allTransactions);

        // Real-time scoring
        const realTimeScore = this.calculateRealTimeScore({
          last30DaysPnL,
          last7DaysPnL,
          recentWinRate,
          profitFactor,
          totalTrades: allTransactions.length
        });

        const metrics: WalletPerformanceMetrics = {
          address: wallet.address,
          currentPnL: wallet.totalPnL,
          last30DaysPnL,
          last7DaysPnL,
          profitFactor,
          maxDrawdown: 0, // Можно рассчитать детальнее
          avgHoldTime,
          recentWinRate,
          volumeWeightedPrice: 0, // Можно рассчитать детальнее
          riskAdjustedReturn: last30DaysPnL / Math.max(wallet.avgTradeSize, 1000),
          realTimeScore,
          trendDirection: last7DaysPnL > 0 ? 'up' : last7DaysPnL < 0 ? 'down' : 'stable',
          hotStreak: this.calculateHotStreak(recentTransactions),
          recentHitRate: recentWinRate
        };

        // Кешируем результат
        this.walletPerformanceCache.set(wallet.address, {
          metrics,
          timestamp: Date.now()
        });

        // Обновляем в базе данных если значительные изменения
        if (realTimeScore !== wallet.performanceScore) {
          await this.smDatabase.updateWalletPerformance(wallet.address, {
            winRate: recentWinRate,
            totalPnL: wallet.totalPnL + last30DaysPnL,
            totalTrades: wallet.totalTrades + allTransactions.length,
            lastActiveAt: new Date(),
            performanceScore: realTimeScore
          });
        }

      } catch (error) {
        this.logger.error(`Error updating performance for wallet ${wallet.address}:`, error);
      }
    }

    this.logger.info('✅ Wallet performance metrics updated');
  }

  /**
   * 🆕 РАСЧЕТ REAL-TIME SCORE для кошелька
   */
  private calculateRealTimeScore(metrics: {
    last30DaysPnL: number;
    last7DaysPnL: number;
    recentWinRate: number;
    profitFactor: number;
    totalTrades: number;
  }): number {
    const { last30DaysPnL, last7DaysPnL, recentWinRate, profitFactor, totalTrades } = metrics;

    // Нормализация метрик
    const pnlScore30 = Math.min(Math.max(last30DaysPnL / 50000, 0), 1) * 100; // $50K = 100 points
    const pnlScore7 = Math.min(Math.max(last7DaysPnL / 20000, 0), 1) * 100;   // $20K = 100 points
    const winRateScore = recentWinRate;
    const profitFactorScore = Math.min(profitFactor * 20, 100);
    const tradesScore = Math.min(totalTrades * 2, 100);

    // Взвешенная оценка
    const score = (
      pnlScore30 * this.PROFIT_CONFIG.performanceWeights.recentPnL * 0.6 +
      pnlScore7 * this.PROFIT_CONFIG.performanceWeights.recentPnL * 0.4 +
      winRateScore * this.PROFIT_CONFIG.performanceWeights.winRate +
      profitFactorScore * this.PROFIT_CONFIG.performanceWeights.profitFactor +
      tradesScore * this.PROFIT_CONFIG.performanceWeights.consistency
    );

    return Math.round(Math.min(score, 100));
  }

  /**
   * 🔥 УЛУЧШЕННЫЙ HOLDINGS с РЕАЛЬНЫМИ FDV
   */
  async analyzeSmartMoneyHoldings(): Promise<HoldingsReport> {
    this.logger.info('📊 Starting PROFIT-FIRST Smart Money Holdings Analysis...');

    try {
      const smartWallets = await this.smDatabase.getAllActiveSmartWallets();
      this.logger.info(`Analyzing holdings for ${smartWallets.length} Smart Money wallets`);

      // Диагностика
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      let totalTransactionsFound = 0;
      
      for (let i = 0; i < Math.min(3, smartWallets.length); i++) {
        const wallet = smartWallets[i];
        const txCount = await this.getWalletTransactionCount(wallet.address, thirtyDaysAgo);
        totalTransactionsFound += txCount;
        this.logger.info(`📊 Wallet ${wallet.address.slice(0, 8)}... has ${txCount} transactions in last 30 days`);
      }

      this.logger.info(`📊 DIAGNOSTIC: Found ${totalTransactionsFound} total transactions in sample`);

      if (totalTransactionsFound === 0) {
        this.logger.warn('⚠️ PROBLEM DETECTED: No transactions found in Smart Money database!');
      }

      // Анализируем holdings с обогащением данных и РЕАЛЬНЫМИ FDV
      const holdings = await this.calculateHoldingsWithEnhancedFDV(smartWallets);
      
      // Сортируем по разным критериям
      const byWalletCount = [...holdings]
        .sort((a, b) => b.uniqueWalletCount - a.uniqueWalletCount)
        .slice(0, 20);
        
      const byBalance = [...holdings]
        .sort((a, b) => b.totalBalanceUSD - a.totalBalanceUSD)
        .slice(0, 20);

      // Формируем сводку с FDV аналитикой
      const totalValueUSD = holdings.reduce((sum, h) => sum + h.totalBalanceUSD, 0);
      const totalFDV = holdings.reduce((sum, h) => sum + (h.fdv || 0), 0);
      const avgTokenFDV = holdings.length > 0 ? totalFDV / holdings.length : 0;
      const avgHoldingDays = holdings.length > 0 
        ? holdings.reduce((sum, h) => sum + h.avgHoldingDays, 0) / holdings.length 
        : 0;
      const totalUniqueWallets = new Set(holdings.flatMap(h => h.topHolders.map(th => th.address))).size;

      const report: HoldingsReport = {
        byWalletCount,
        byBalance,
        totalTokens: holdings.length,
        totalValueUSD,
        analysisTime: new Date(),
        summary: {
          topTokenByWallets: byWalletCount[0]?.tokenSymbol || 'N/A',
          topTokenByValue: byBalance[0]?.tokenSymbol || 'N/A',
          avgHoldingDays: Math.round(avgHoldingDays),
          totalUniqueWallets,
          totalFDV,
          avgTokenFDV
        }
      };

      this.logger.info(`✅ PROFIT-FIRST Holdings analysis complete: ${report.totalTokens} tokens, $${this.formatNumber(report.totalValueUSD)} total value, $${this.formatNumber(totalFDV)} total FDV`);
      
      return report;

    } catch (error) {
      this.logger.error('❌ Error in PROFIT-FIRST Smart Money Holdings Analysis:', error);
      throw error;
    }
  }

  /**
   * 🧮 РАСЧЕТ HOLDINGS С ENHANCED FDV ДАННЫМИ
   */
  private async calculateHoldingsWithEnhancedFDV(smartWallets: SmartMoneyWallet[]): Promise<TokenHolding[]> {
    
    // Проверяем кеш
    const cacheKey = 'enhanced_holdings_with_fdv';
    const cached = this.holdingsCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.HOLDINGS_CACHE_TTL) {
      this.logger.info('📋 Using cached enhanced holdings data');
      return cached.data;
    }

    this.logger.info('🔍 Calculating fresh holdings data with enhanced FDV analysis...');

    const tokenData = new Map<string, {
      tokenAddress: string;
      tokenSymbol: string;
      tokenName: string;
      currentPrice: number | null;
      fdv: number | null;                // 🆕 Real FDV
      marketCap: number | null;          // 🆕 Market cap
      liquidityScore: number;            // 🆕 Liquidity assessment
      wallets: Map<string, {
        category: 'sniper' | 'hunter' | 'trader';
        buyVolume: number;
        sellVolume: number;
        netPosition: number;
        firstBuyTime: Date;
        lastActivityTime: Date;
        transactions: TokenSwap[];
      }>;
      firstSeenAt: Date;
    }>();

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    
    this.logger.info('🔍 Starting to collect transaction data from Smart Money wallets...');
    
    for (const wallet of smartWallets) {
      const transactions = await this.getWalletTransactionsAfter(wallet.address, thirtyDaysAgo);
      
      this.logger.debug(`📊 Wallet ${wallet.address.slice(0, 8)}... has ${transactions.length} transactions`);
      
      for (const tx of transactions) {
        const tokenKey = tx.tokenAddress;
        
        if (!tokenData.has(tokenKey)) {
          // 🆕 ПОЛУЧАЕМ ENHANCED ДАННЫЕ ВКЛЮЧАЯ FDV
          const enrichedToken = await this.getEnrichedTokenInfoWithFDV(tx.tokenAddress);
          
          tokenData.set(tokenKey, {
            tokenAddress: tx.tokenAddress,
            tokenSymbol: enrichedToken.symbol,
            tokenName: enrichedToken.name,
            currentPrice: enrichedToken.price,
            fdv: enrichedToken.fdv,
            marketCap: enrichedToken.marketCap,
            liquidityScore: this.calculateLiquidityScore(enrichedToken),
            wallets: new Map(),
            firstSeenAt: tx.timestamp
          });
        }

        const token = tokenData.get(tokenKey)!;
        
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
        } else {
          walletData.sellVolume += tx.amountUSD;
          walletData.netPosition -= tx.amountUSD;
        }

        if (this.isBuyTransaction(tx) && tx.timestamp < walletData.firstBuyTime) {
          walletData.firstBuyTime = tx.timestamp;
        }
      }
    }

    this.logger.info(`🔍 Collected data for ${tokenData.size} unique tokens`);

    // Преобразуем в TokenHolding объекты с enhanced данными
    const holdings: TokenHolding[] = [];

    for (const [_, token] of tokenData) {
      const validWallets = Array.from(token.wallets.entries())
        .filter(([_, data]) => data.netPosition > 100); // Минимум $100 позиция

      if (validWallets.length === 0) continue;

      // Подсчет по категориям
      const categoryCount = {
        sniper: validWallets.filter(([_, data]) => data.category === 'sniper').length,
        hunter: validWallets.filter(([_, data]) => data.category === 'hunter').length,
        trader: validWallets.filter(([_, data]) => data.category === 'trader').length
      };

      let totalBalance = validWallets.reduce((sum, [_, data]) => sum + data.netPosition, 0);
      
      // 🆕 УЛУЧШЕННЫЙ расчет с учетом текущей цены
      if (token.currentPrice && token.currentPrice > 0) {
        // В будущем можно получать реальные токеновые балансы и пересчитывать
      }
      
      const maxSingleHolding = Math.max(...validWallets.map(([_, data]) => data.netPosition));
      const avgBalance = totalBalance / validWallets.length;

      const totalBuyVolume = validWallets.reduce((sum, [_, data]) => sum + data.buyVolume, 0);
      const totalSellVolume = validWallets.reduce((sum, [_, data]) => sum + data.sellVolume, 0);

      const avgHoldingDays = validWallets.reduce((sum, [_, data]) => {
        const holdingTime = data.lastActivityTime.getTime() - data.firstBuyTime.getTime();
        return sum + (holdingTime / (1000 * 60 * 60 * 24));
      }, 0) / validWallets.length;

      const topHolders = validWallets
        .sort((a, b) => b[1].netPosition - a[1].netPosition)
        .slice(0, 5)
        .map(([address, data]) => ({
          address,
          category: data.category,
          balanceUSD: data.netPosition,
          holdingDays: Math.round((data.lastActivityTime.getTime() - data.firstBuyTime.getTime()) / (1000 * 60 * 60 * 24))
        }));

      const holding: TokenHolding = {
        tokenAddress: token.tokenAddress,
        tokenSymbol: token.tokenSymbol,
        tokenName: token.tokenName,
        uniqueWalletCount: validWallets.length,
        sniperWallets: categoryCount.sniper,
        hunterWallets: categoryCount.hunter,
        traderWallets: categoryCount.trader,
        totalBalanceUSD: totalBalance,
        avgBalancePerWallet: avgBalance,
        maxSingleHolding,
        
        // 🆕 ENHANCED PROFIT-FIRST ДАННЫЕ
        fdv: token.fdv,
        marketCap: token.marketCap,
        priceChange24h: null, // Можно добавить через Birdeye API
        liquidityScore: token.liquidityScore,
        
        firstSeenAt: token.firstSeenAt,
        avgHoldingDays: Math.round(avgHoldingDays),
        totalBuyVolume,
        totalSellVolume,
        netFlow: totalBuyVolume - totalSellVolume,
        topHolders
      };

      holdings.push(holding);
    }

    // Кешируем результат
    this.holdingsCache.set(cacheKey, {
      data: holdings,
      timestamp: Date.now()
    });

    this.logger.info(`✅ Calculated enhanced holdings with FDV for ${holdings.length} tokens`);
    return holdings;
  }

  // ========== НОВЫЕ ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ==========

  /**
   * 🆕 РАСШИРЕННОЕ обогащение информации о токене с FDV
   */
  private async getEnrichedTokenInfoWithFDV(tokenAddress: string): Promise<{
    symbol: string;
    name: string;
    price: number | null;
    fdv: number | null;
    marketCap: number | null;
  }> {
    // Проверяем кеш
    const cached = this.enrichedTokenCache.get(tokenAddress);
    if (cached && Date.now() - cached.timestamp < this.TOKEN_CACHE_TTL) {
      return {
        symbol: cached.symbol,
        name: cached.name,
        price: cached.price,
        fdv: cached.fdv,
        marketCap: cached.marketCap
      };
    }

    try {
      // 🚀 ИСПОЛЬЗУЕМ ENHANCED TokenMetadataService
      const enhancedInfo = await this.tokenMetadataService.getEnhancedTokenInfo(tokenAddress);

      if (enhancedInfo) {
        // Кешируем результат
        this.enrichedTokenCache.set(tokenAddress, {
          symbol: enhancedInfo.symbol,
          name: enhancedInfo.name,
          price: enhancedInfo.price,
          fdv: enhancedInfo.fdv,
          marketCap: enhancedInfo.marketCap,
          timestamp: Date.now()
        });

        return {
          symbol: enhancedInfo.symbol,
          name: enhancedInfo.name,
          price: enhancedInfo.price,
          fdv: enhancedInfo.fdv,
          marketCap: enhancedInfo.marketCap
        };
      }

      // Fallback
      const fallbackInfo = {
        symbol: `TOKEN_${tokenAddress.slice(0, 6)}`,
        name: `Token ${tokenAddress.slice(0, 8)}...`,
        price: null,
        fdv: null,
        marketCap: null
      };

      this.enrichedTokenCache.set(tokenAddress, {
        ...fallbackInfo,
        timestamp: Date.now()
      });

      return fallbackInfo;

    } catch (error) {
      this.logger.error(`Error getting enhanced token info for ${tokenAddress}:`, error);
      
      const fallbackInfo = {
        symbol: `TOKEN_${tokenAddress.slice(0, 6)}`,
        name: `Token ${tokenAddress.slice(0, 8)}...`,
        price: null,
        fdv: null,
        marketCap: null
      };

      return fallbackInfo;
    }
  }

  /**
   * 🆕 РАСЧЕТ LIQUIDITY SCORE
   */
  private calculateLiquidityScore(tokenInfo: {
    fdv: number | null;
    marketCap: number | null;
    price: number | null;
  }): number {
    let score = 50; // Базовый score

    if (tokenInfo.fdv) {
      if (tokenInfo.fdv > 10_000_000) score += 20; // FDV > $10M
      else if (tokenInfo.fdv > 1_000_000) score += 10; // FDV > $1M
      else if (tokenInfo.fdv < 100_000) score -= 20; // FDV < $100K
    }

    if (tokenInfo.marketCap && tokenInfo.fdv) {
      const ratio = tokenInfo.marketCap / tokenInfo.fdv;
      if (ratio > 0.8) score += 15; // High circulation
      else if (ratio < 0.2) score -= 10; // Low circulation
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * 🆕 РАСЧЕТ PnL из транзакций
   */
  private calculatePnLFromTransactions(transactions: TokenSwap[]): number {
    let totalPnL = 0;
    const positions = new Map<string, { amount: number; avgPrice: number }>();

    for (const tx of transactions) {
      const price = tx.amountUSD / tx.amount;
      
      if (this.isBuyTransaction(tx)) {
        const existing = positions.get(tx.tokenAddress) || { amount: 0, avgPrice: 0 };
        const newAmount = existing.amount + tx.amount;
        const newAvgPrice = ((existing.avgPrice * existing.amount) + (price * tx.amount)) / newAmount;
        
        positions.set(tx.tokenAddress, { amount: newAmount, avgPrice: newAvgPrice });
      } else {
        const existing = positions.get(tx.tokenAddress);
        if (existing) {
          const soldValue = tx.amount * price;
          const costBasis = tx.amount * existing.avgPrice;
          totalPnL += soldValue - costBasis;
          
          existing.amount -= tx.amount;
          if (existing.amount <= 0) {
            positions.delete(tx.tokenAddress);
          }
        }
      }
    }

    return totalPnL;
  }

  /**
   * 🆕 РАСЧЕТ PROFIT FACTOR
   */
  private calculateProfitFactor(transactions: TokenSwap[]): number {
    let totalProfit = 0;
    let totalLoss = 0;

    for (const tx of transactions) {
      if (tx.amountUSD > 0) {
        totalProfit += tx.amountUSD;
      } else {
        totalLoss += Math.abs(tx.amountUSD);
      }
    }

    return totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? 10 : 1;
  }

  /**
   * 🆕 РАСЧЕТ WIN RATE из транзакций
   */
  private calculateWinRate(transactions: TokenSwap[]): number {
    if (transactions.length === 0) return 0;
    
    const profitableTrades = transactions.filter(tx => tx.amountUSD > 0).length;
    return (profitableTrades / transactions.length) * 100;
  }

  /**
   * 🆕 РАСЧЕТ HOT STREAK
   */
  private calculateHotStreak(transactions: TokenSwap[]): number {
    let streak = 0;
    let maxStreak = 0;

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

  /**
   * 🆕 РАСЧЕТ СРЕДНЕГО ВРЕМЕНИ ДЕРЖАНИЯ
   */
  private calculateAvgHoldTime(transactions: TokenSwap[]): number {
    // Упрощенный расчет - можно улучшить
    if (transactions.length < 2) return 0;
    
    const timeSpan = transactions[transactions.length - 1].timestamp.getTime() - transactions[0].timestamp.getTime();
    return timeSpan / (1000 * 60 * 60); // В часах
  }

  // ========== СУЩЕСТВУЮЩИЕ ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ (сохранены все) ==========

  async sendFlowAnalysisNotifications(result: FlowAnalysisResult): Promise<void> {
    try {
      // Отправляем топ притоки за час
      if (result.topInflowsLastHour.length > 0) {
        const inflows = result.topInflowsLastHour.map(flow => ({
          tokenSymbol: flow.tokenSymbol,
          tokenAddress: flow.tokenAddress,
          inflowUSD: flow.totalInflowUSD,
          walletCount: flow.uniqueWallets || 0,
          topWallets: flow.topWallets || []
        }));

        await this.telegramNotifier.sendTopSmartMoneyInflows(inflows);
      }

      // Отправляем Hot New Tokens с enhanced FDV информацией
      for (const hotToken of result.hotNewTokens.slice(0, 5)) { // Топ-5
        await this.telegramNotifier.sendHotNewTokenAlert(hotToken);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      this.logger.info(`✅ Sent PROFIT-FIRST notifications: ${result.topInflowsLastHour.length} inflows, ${result.hotNewTokens.length} hot tokens with real FDV`);

    } catch (error) {
      this.logger.error('❌ Error sending flow analysis notifications:', error);
    }
  }

  /**
   * 📊 ОТПРАВКА ENHANCED HOLDINGS REPORT
   */
  async sendHoldingsReport(report: HoldingsReport): Promise<void> {
    try {
      // Отправляем общую сводку с FDV аналитикой
      await this.telegramNotifier.sendCycleLog(
        `📊 <b>PROFIT-FIRST Holdings Report</b>\n\n` +
        `🏷️ <b>Total Tokens:</b> <code>${report.totalTokens}</code>\n` +
        `💰 <b>Total Value:</b> <code>$${this.formatNumber(report.totalValueUSD)}</code>\n` +
        `💎 <b>Total FDV:</b> <code>$${this.formatNumber(report.summary.totalFDV)}</code>\n` +
        `📈 <b>Avg Token FDV:</b> <code>$${this.formatNumber(report.summary.avgTokenFDV)}</code>\n` +
        `👥 <b>Unique Wallets:</b> <code>${report.summary.totalUniqueWallets}</code>\n` +
        `📅 <b>Avg Holding:</b> <code>${report.summary.avgHoldingDays} days</code>\n\n` +
        `🥇 <b>Top by Wallets:</b> <code>#${report.summary.topTokenByWallets}</code>\n` +
        `💎 <b>Top by Value:</b> <code>#${report.summary.topTokenByValue}</code>\n\n` +
        `⏰ <code>${report.analysisTime.toLocaleString()}</code>`
      );

      // Отправляем топ токены с FDV информацией
      if (report.byWalletCount.length > 0) {
        let walletCountMessage = `👥 <b>Top Tokens by Wallet Count (with FDV)</b>\n\n`;
        
        report.byWalletCount.slice(0, 10).forEach((token, index) => {
          const medal = index < 3 ? ['🥇', '🥈', '🥉'][index] : `${index + 1}.`;
          walletCountMessage += `${medal} <b>${token.tokenSymbol}</b>\n`;
          walletCountMessage += `    👥 Wallets: <code>${token.uniqueWalletCount}</code> `;
          walletCountMessage += `(🔫${token.sniperWallets} 💡${token.hunterWallets} 🐳${token.traderWallets})\n`;
          walletCountMessage += `    💰 Value: <code>$${this.formatNumber(token.totalBalanceUSD)}</code>\n`;
          if (token.fdv) {
            walletCountMessage += `    💎 FDV: <code>$${this.formatNumber(token.fdv)}</code>\n`;
          }
          walletCountMessage += `\n`;
        });

        await this.telegramNotifier.sendCycleLog(walletCountMessage);
      }

      this.logger.info(`✅ Enhanced holdings report sent successfully`);

    } catch (error) {
      this.logger.error('❌ Error sending enhanced holdings report:', error);
    }
  }

  private async getWalletTransactionsAfter(walletAddress: string, afterDate: Date): Promise<TokenSwap[]> {
    try {
      const smTransactions = await this.smDatabase.getSmartWalletTransactions(walletAddress, afterDate);
      
      if (smTransactions.length > 0) {
        this.logger.debug(`💾 Found ${smTransactions.length} SM transactions for ${walletAddress.slice(0, 8)}...`);
        return smTransactions;
      }

      const regularTransactions = await this.database.getWalletTransactionsAfter(walletAddress, afterDate);
      
      if (regularTransactions.length > 0) {
        this.logger.debug(`📊 Found ${regularTransactions.length} regular transactions for ${walletAddress.slice(0, 8)}...`);
        return regularTransactions;
      }

      this.logger.debug(`⚠️ No transactions found for wallet ${walletAddress.slice(0, 8)}... after ${afterDate.toISOString()}`);
      return [];

    } catch (error) {
      this.logger.error(`❌ Error getting transactions for wallet ${walletAddress}:`, error);
      return [];
    }
  }

  private async getWalletTransactionCount(walletAddress: string, afterDate: Date): Promise<number> {
    try {
      const transactions = await this.getWalletTransactionsAfter(walletAddress, afterDate);
      return transactions.length;
    } catch (error) {
      this.logger.error(`❌ Error getting transaction count for wallet ${walletAddress}:`, error);
      return 0;
    }
  }

  private isBuyTransaction(tx: TokenSwap): boolean {
    return tx.swapType === 'buy';
  }

  private getWalletCategory(wallet: SmartMoneyWallet): 'sniper' | 'hunter' | 'trader' {
    return wallet.category;
  }

  private getTopWalletsFromFlow(flow: {
    uniqueBuyers: Set<string>;
    uniqueSellers: Set<string>;
    transactions: TokenSwap[];
  }): Array<{ address: string; amountUSD: number; category: string }> {
    
    const walletTotals = new Map<string, { total: number; category: string }>();
    
    for (const tx of flow.transactions) {
      if (!walletTotals.has(tx.walletAddress)) {
        walletTotals.set(tx.walletAddress, { total: 0, category: 'unknown' });
      }
      
      const data = walletTotals.get(tx.walletAddress)!;
      data.total += tx.amountUSD;
    }

    return Array.from(walletTotals.entries())
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 5)
      .map(([address, data]) => ({
        address,
        amountUSD: data.total,
        category: data.category
      }));
  }

  private calculateTokenAge(timestamp: Date): number {
    const ageMs = Date.now() - timestamp.getTime();
    return ageMs / (1000 * 60 * 60); // Возвращаем возраст в часах
  }

  private formatNumber(num: number): string {
    if (num >= 1_000_000) {
      return `${(num / 1_000_000).toFixed(1)}M`;
    } else if (num >= 1_000) {
      return `${(num / 1_000).toFixed(1)}K`;
    } else {
      return num.toFixed(0);
    }
  }

  // 🆕 МЕТОДЫ ДЛЯ ПОЛУЧЕНИЯ СТАТИСТИКИ
  getCacheStats(): {
    holdingsCache: number;
    enrichedTokenCache: number;
    walletPerformanceCache: number;
    cacheHitRate: number;
  } {
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
    this.logger.info('🧹 All analyzer caches cleared');
  }
}