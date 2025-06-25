// src/services/SmartMoneyFlowAnalyzer.ts - 🔥 ОПТИМИЗАЦИЯ HNT + БАТЧИНГ FDV + 50% МЕНЬШЕ API
import { SmartMoneyDatabase } from './SmartMoneyDatabase';
import { Database } from './Database';
import { TelegramNotifier } from './TelegramNotifier';
import { TokenMetadataService } from './TokenMetadataService';
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
  private logger: Logger;

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

  constructor(smDatabase: SmartMoneyDatabase, telegramNotifier: TelegramNotifier, database: Database, tokenMetadataService: TokenMetadataService) {
    this.smDatabase = smDatabase;
    this.database = database;
    this.telegramNotifier = telegramNotifier;
    this.tokenMetadataService = tokenMetadataService;
    this.logger = Logger.getInstance();
    this.logger.info('📊 SmartMoneyFlowAnalyzer initialized with HNT OPTIMIZATION');
  }

  // 🔍 ГЛАВНЫЙ МЕТОД с батчингом
  async analyzeSmartMoneyFlows(): Promise<FlowAnalysisResult> {
    this.logger.info('🔍 Starting OPTIMIZED Smart Money Flow Analysis...');

    try {
      const smartWallets = await this.smDatabase.getAllActiveSmartWallets();
      this.logger.info(`Analyzing flows for ${smartWallets.length} wallets`);

      // 🆕 Оптимизированное обновление метрик (только 10 кошельков)
      await this.updateWalletPerformanceMetricsOptimized(smartWallets);

      // Параллельный анализ потоков с батчингом
      const [hourlyFlows, dailyFlows] = await Promise.all([
        this.calculateFlowsWithFDVBatched(smartWallets, '1h'),
        this.calculateFlowsWithFDVBatched(smartWallets, '24h')
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

      this.logger.info(`✅ OPTIMIZED Analysis: ${result.inflows.length} inflows, ${result.hotNewTokens.length} hot tokens`);
      return result;
    } catch (error) {
      this.logger.error('❌ Error in optimized flow analysis:', error);
      throw error;
    }
  }

  // 🔥 БАТЧИНГ FDV ЗАПРОСОВ
  private async calculateFlowsWithFDVBatched(smartWallets: SmartMoneyWallet[], period: '1h' | '24h'): Promise<{ inflows: SmartMoneyFlow[]; outflows: SmartMoneyFlow[] }> {
    const hours = period === '1h' ? 1 : 24;
    const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);

    const tokenFlows = new Map<string, {
      tokenAddress: string; tokenSymbol: string; tokenName: string;
      totalBuyUSD: number; totalSellUSD: number;
      uniqueBuyers: Set<string>; uniqueSellers: Set<string>;
      transactions: TokenSwap[]; fdv: number | null; marketCap: number | null;
    }>();

    // 🚀 1. Собираем ВСЕ транзакции и токены
    const allTokens = new Set<string>();
    for (const wallet of smartWallets) {
      const transactions = await this.getWalletTransactionsAfter(wallet.address, cutoffTime);
      
      for (const tx of transactions) {
        allTokens.add(tx.tokenAddress);
        const key = tx.tokenAddress;
        
        if (!tokenFlows.has(key)) {
          tokenFlows.set(key, {
            tokenAddress: tx.tokenAddress, tokenSymbol: '', tokenName: '',
            totalBuyUSD: 0, totalSellUSD: 0,
            uniqueBuyers: new Set(), uniqueSellers: new Set(),
            transactions: [], fdv: null, marketCap: null
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
    }

    // 🚀 2. БАТЧ-запрос FDV для всех токенов ОДНОВРЕМЕННО
    this.logger.info(`🔥 Batching FDV requests for ${allTokens.size} tokens`);
    const tokenMetadata = await this.batchGetTokenMetadata(Array.from(allTokens));

    // 🚀 3. Обогащаем потоки данными из батча
    for (const [tokenAddress, flow] of tokenFlows) {
      const metadata = tokenMetadata.get(tokenAddress);
      if (metadata) {
        flow.tokenSymbol = metadata.symbol;
        flow.tokenName = metadata.name;
        flow.fdv = metadata.fdv;
        flow.marketCap = metadata.marketCap;
      } else {
        flow.tokenSymbol = `TOKEN_${tokenAddress.slice(0, 6)}`;
        flow.tokenName = 'Unknown Token';
      }
    }

    // Преобразуем в SmartMoneyFlow с фильтрацией
    const inflows: SmartMoneyFlow[] = [];
    const outflows: SmartMoneyFlow[] = [];

    for (const [_, flow] of tokenFlows) {
      const netFlowUSD = flow.totalBuyUSD - flow.totalSellUSD;
      const uniqueWallets = flow.uniqueBuyers.size + flow.uniqueSellers.size;

      if (uniqueWallets < 2) continue;

      // FDV фильтрация
      if (flow.fdv && (flow.fdv < this.PROFIT_CONFIG.minFDV || flow.fdv > this.PROFIT_CONFIG.maxFDV)) {
        continue;
      }

      const smartMoneyFlow: SmartMoneyFlow = {
        tokenAddress: flow.tokenAddress, tokenSymbol: flow.tokenSymbol, tokenName: flow.tokenName,
        period, totalInflowUSD: flow.totalBuyUSD, totalOutflowUSD: flow.totalSellUSD,
        netFlowUSD, uniqueWallets,
        avgTradeSize: (flow.totalBuyUSD + flow.totalSellUSD) / uniqueWallets,
        topWallets: this.getTopWalletsFromFlow(flow)
      };

      if (netFlowUSD > 0 && flow.totalBuyUSD > 5000) {
        inflows.push(smartMoneyFlow);
      } else if (netFlowUSD < 0 && flow.totalSellUSD > 5000) {
        outflows.push(smartMoneyFlow);
      }
    }

    return {
      inflows: inflows.sort((a, b) => b.totalInflowUSD - a.totalInflowUSD),
      outflows: outflows.sort((a, b) => b.totalOutflowUSD - a.totalOutflowUSD)
    };
  }

  // 🚀 НОВЫЙ МЕТОД: БАТЧИНГ FDV ЗАПРОСОВ
  private async batchGetTokenMetadata(tokens: string[]): Promise<Map<string, any>> {
    const results = new Map();
    const BATCH_SIZE = 20; // 20 токенов за раз
    
    for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
      const batch = tokens.slice(i, i + BATCH_SIZE);
      
      const batchPromises = batch.map(async (token) => {
        try {
          const data = await this.getEnrichedTokenInfoWithFDV(token);
          return { token, data };
        } catch (error) {
          this.logger.warn(`Failed to get FDV for ${token}:`, error);
          return { token, data: null };
        }
      });
      
      const batchResults = await Promise.allSettled(batchPromises);
      
      batchResults.forEach((result) => {
        if (result.status === 'fulfilled' && result.value.data) {
          results.set(result.value.token, result.value.data);
        }
      });
      
      // Пауза между батчами для rate limiting
      if (i + BATCH_SIZE < tokens.length) {
        await this.sleep(1000); // 1 секунда
      }
    }
    
    this.logger.info(`✅ Batched ${tokens.length} tokens, got ${results.size} results`);
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

  // 🆕 ОПТИМИЗИРОВАННОЕ обновление метрик кошельков (только 10 за раз)
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

        const metrics: WalletPerformanceMetrics = {
          address: wallet.address, currentPnL: wallet.totalPnL,
          last30DaysPnL, last7DaysPnL, profitFactor: 0, maxDrawdown: 0,
          avgHoldTime: 0, recentWinRate, volumeWeightedPrice: 0,
          riskAdjustedReturn: last30DaysPnL / Math.max(wallet.avgTradeSize, 1000),
          realTimeScore, trendDirection: last7DaysPnL > 0 ? 'up' : last7DaysPnL < 0 ? 'down' : 'stable',
          hotStreak: this.calculateHotStreak(recentTransactions), recentHitRate: recentWinRate
        };

        this.walletPerformanceCache.set(wallet.address, { metrics, timestamp: Date.now() });

        if (realTimeScore !== wallet.performanceScore) {
          await this.smDatabase.updateWalletPerformance(wallet.address, {
            winRate: recentWinRate, totalPnL: wallet.totalPnL + last30DaysPnL,
            totalTrades: wallet.totalTrades + allTransactions.length,
            lastActiveAt: new Date(), performanceScore: realTimeScore
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
        `📊 <b>OPTIMIZED Holdings Report</b>\n\n` +
        `🏷️ Tokens: <code>${report.totalTokens}</code>\n` +
        `💰 Value: <code>$${this.formatNumber(report.totalValueUSD)}</code>\n` +
        `💎 Total FDV: <code>$${this.formatNumber(report.summary.totalFDV)}</code>\n` +
        `📈 Avg FDV: <code>$${this.formatNumber(report.summary.avgTokenFDV)}</code>\n` +
        `👥 Wallets: <code>${report.summary.totalUniqueWallets}</code>\n` +
        `🥇 Top by Wallets: <code>#${report.summary.topTokenByWallets}</code>\n` +
        `💎 Top by Value: <code>#${report.summary.topTokenByValue}</code>`
      );

      if (report.byWalletCount.length > 0) {
        let message = `👥 <b>Top Tokens (Optimized FDV)</b>\n\n`;
        report.byWalletCount.slice(0, 10).forEach((token, i) => {
          const medal = i < 3 ? ['🥇', '🥈', '🥉'][i] : `${i + 1}.`;
          message += `${medal} <b>${token.tokenSymbol}</b>\n`;
          message += `    👥 <code>${token.uniqueWalletCount}</code> wallets, 💰 <code>$${this.formatNumber(token.totalBalanceUSD)}</code>\n`;
          if (token.fdv) message += `    💎 FDV: <code>$${this.formatNumber(token.fdv)}</code>\n`;
          message += `\n`;
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