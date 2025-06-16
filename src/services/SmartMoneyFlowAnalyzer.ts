// src/services/SmartMoneyFlowAnalyzer.ts - ПОЛНЫЙ файл с Holdings/Portfolio + ИСПРАВЛЕНО получение транзакций + ДОБАВЛЕНО ЛОГГИРОВАНИЕ
import { SmartMoneyDatabase } from './SmartMoneyDatabase';
import { Database } from './Database';
import { TelegramNotifier } from './TelegramNotifier';
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
  };
}

export class SmartMoneyFlowAnalyzer {
  private smDatabase: SmartMoneyDatabase;
  private database: Database;
  private telegramNotifier: TelegramNotifier;
  private logger: Logger;
  private heliusApiKey: string;

  // 🆕 КЕШ ДЛЯ HOLDINGS
  private holdingsCache = new Map<string, { data: TokenHolding[]; timestamp: number }>();
  private readonly HOLDINGS_CACHE_TTL = 15 * 60 * 1000; // 15 минут

  constructor(
    smDatabase: SmartMoneyDatabase, 
    telegramNotifier: TelegramNotifier,
    database: Database
  ) {
    this.smDatabase = smDatabase;
    this.database = database;
    this.telegramNotifier = telegramNotifier;
    this.logger = Logger.getInstance();
    this.heliusApiKey = process.env.HELIUS_API_KEY!;
  }

  // ========== СУЩЕСТВУЮЩИЕ МЕТОДЫ (БЕЗ ИЗМЕНЕНИЙ) ==========

  // Основной метод анализа потоков Smart Money
  async analyzeSmartMoneyFlows(): Promise<FlowAnalysisResult> {
    this.logger.info('🔍 Starting Smart Money Flow Analysis...');

    try {
      // Получаем все активные Smart Money кошельки
      const smartWallets = await this.smDatabase.getAllActiveSmartWallets();
      this.logger.info(`Analyzing flows for ${smartWallets.length} Smart Money wallets`);

      // Анализируем потоки за последний час и 24 часа
      const hourlyFlows = await this.calculateFlows(smartWallets, '1h');
      const dailyFlows = await this.calculateFlows(smartWallets, '24h');

      // Ищем Hot New Tokens
      const hotNewTokens = await this.findHotNewTokens(smartWallets);

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

      this.logger.info(`✅ Analysis complete: ${result.inflows.length} inflows, ${result.hotNewTokens.length} hot tokens`);
      return result;

    } catch (error) {
      this.logger.error('❌ Error in Smart Money Flow Analysis:', error);
      throw error;
    }
  }

  // Расчет притоков/оттоков для указанного периода
  private async calculateFlows(
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
    }>();

    // Получаем транзакции Smart Money кошельков за период
    for (const wallet of smartWallets) {
      const transactions = await this.getWalletTransactionsAfter(wallet.address, cutoffTime);
      
      for (const tx of transactions) {
        const key = tx.tokenAddress;
        
        if (!tokenFlows.has(key)) {
          tokenFlows.set(key, {
            tokenAddress: tx.tokenAddress,
            tokenSymbol: tx.tokenSymbol,
            tokenName: tx.tokenName,
            totalBuyUSD: 0,
            totalSellUSD: 0,
            uniqueBuyers: new Set(),
            uniqueSellers: new Set(),
            transactions: []
          });
        }

        const flow = tokenFlows.get(key)!;
        flow.transactions.push(tx);

        // Определяем тип операции (упрощенно)
        if (this.isBuyTransaction(tx)) {
          flow.totalBuyUSD += tx.amountUSD;
          flow.uniqueBuyers.add(tx.walletAddress);
        } else {
          flow.totalSellUSD += tx.amountUSD;
          flow.uniqueSellers.add(tx.walletAddress);
        }
      }
    }

    // Преобразуем в SmartMoneyFlow объекты
    const inflows: SmartMoneyFlow[] = [];
    const outflows: SmartMoneyFlow[] = [];

    for (const [_, flow] of tokenFlows) {
      const netFlowUSD = flow.totalBuyUSD - flow.totalSellUSD;
      const uniqueWallets = flow.uniqueBuyers.size + flow.uniqueSellers.size;

      if (uniqueWallets < 2) continue; // Фильтруем токены с малой активностью

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

  // Поиск Hot New Tokens (токены младше 24 часов с активностью SM)
  private async findHotNewTokens(smartWallets: SmartMoneyWallet[]): Promise<HotNewToken[]> {
    const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 часа назад
    
    // Группируем транзакции по новым токенам
    const hotTokens = new Map<string, {
      tokenAddress: string;
      tokenSymbol: string;
      tokenName: string;
      fdv: number;
      smStakeUSD: number;
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
    }>();

    // Анализируем транзакции за последние 24 часа
    for (const wallet of smartWallets) {
      const transactions = await this.getWalletTransactionsAfter(wallet.address, cutoffTime);
      
      for (const tx of transactions) {
        const key = tx.tokenAddress;
        
        if (!hotTokens.has(key)) {
          hotTokens.set(key, {
            tokenAddress: tx.tokenAddress,
            tokenSymbol: tx.tokenSymbol,
            tokenName: tx.tokenName,
            fdv: 0,
            smStakeUSD: 0,
            ageHours: this.calculateTokenAge(tx.timestamp),
            buyVolumeUSD: 0,
            sellVolumeUSD: 0,
            buyCount: 0,
            sellCount: 0,
            uniqueSmWallets: new Set(),
            topBuyers: []
          });
        }

        const token = hotTokens.get(key)!;
        token.uniqueSmWallets.add(tx.walletAddress);

        if (this.isBuyTransaction(tx)) {
          token.buyVolumeUSD += tx.amountUSD;
          token.buyCount++;
        } else {
          token.sellVolumeUSD += tx.amountUSD;
          token.sellCount++;
        }
      }
    }

    // Фильтруем и сортируем результаты
    const result: HotNewToken[] = [];
    for (const [_, token] of hotTokens) {
      if (token.ageHours <= 24 && token.uniqueSmWallets.size >= 2 && token.buyVolumeUSD > 10000) {
        result.push({
          address: token.tokenAddress,
          symbol: token.tokenSymbol,
          name: token.tokenName,
          fdv: token.fdv,
          smStakeUSD: token.smStakeUSD,
          ageHours: token.ageHours,
          buyVolumeUSD: token.buyVolumeUSD,
          sellVolumeUSD: token.sellVolumeUSD,
          buyCount: token.buyCount,
          sellCount: token.sellCount,
          uniqueSmWallets: token.uniqueSmWallets.size,
          topBuyers: token.topBuyers
        });
      }
    }

    return result.sort((a, b) => b.smStakeUSD - a.smStakeUSD);
  }

  // Отправка уведомлений о результатах анализа
  async sendFlowAnalysisNotifications(result: FlowAnalysisResult): Promise<void> {
    try {
      // Отправляем топ притоки за час - ИСПРАВЛЕНО: конвертируем типы
      if (result.topInflowsLastHour.length > 0) {
        // Конвертируем SmartMoneyFlow в SmartMoneyInflow
        const inflows = result.topInflowsLastHour.map(flow => ({
          tokenSymbol: flow.tokenSymbol,
          tokenAddress: flow.tokenAddress,
          inflowUSD: flow.totalInflowUSD,
          walletCount: flow.uniqueWallets || 0,
          topWallets: flow.topWallets || []
        }));

        await this.telegramNotifier.sendTopSmartMoneyInflows(inflows);
      }

      // Отправляем Hot New Tokens
      for (const hotToken of result.hotNewTokens.slice(0, 5)) { // Топ-5
        await this.telegramNotifier.sendHotNewTokenAlert(hotToken);
        await new Promise(resolve => setTimeout(resolve, 1000)); // Пауза между сообщениями
      }

      this.logger.info(`✅ Sent notifications: ${result.topInflowsLastHour.length} inflows, ${result.hotNewTokens.length} hot tokens`);

    } catch (error) {
      this.logger.error('❌ Error sending flow analysis notifications:', error);
    }
  }

  // ========== 🆕 НОВЫЕ МЕТОДЫ ДЛЯ HOLDINGS/PORTFOLIO ==========

  /**
   * 📊 ОСНОВНОЙ МЕТОД АНАЛИЗА HOLDINGS
   */
  async analyzeSmartMoneyHoldings(): Promise<HoldingsReport> {
    this.logger.info('📊 Starting Smart Money Holdings Analysis...');

    try {
      // Получаем все активные SM кошельки
      const smartWallets = await this.smDatabase.getAllActiveSmartWallets();
      this.logger.info(`Analyzing holdings for ${smartWallets.length} Smart Money wallets`);

      // 🔧 КРИТИЧЕСКОЕ ДИАГНОСТИРОВАНИЕ: Проверяем количество транзакций
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      let totalTransactionsFound = 0;
      
      // Пробный запрос для диагностики
      for (let i = 0; i < Math.min(3, smartWallets.length); i++) {
        const wallet = smartWallets[i];
        const txCount = await this.getWalletTransactionCount(wallet.address, thirtyDaysAgo);
        totalTransactionsFound += txCount;
        this.logger.info(`📊 Wallet ${wallet.address.slice(0, 8)}... has ${txCount} transactions in last 30 days`);
      }

      this.logger.info(`📊 DIAGNOSTIC: Found ${totalTransactionsFound} total transactions in sample of ${Math.min(3, smartWallets.length)} wallets`);

      if (totalTransactionsFound === 0) {
        this.logger.warn('⚠️ PROBLEM DETECTED: No transactions found in Smart Money database!');
        this.logger.warn('⚠️ This explains why Holdings shows 0 tokens and $0 value');
        this.logger.warn('⚠️ The issue is likely in the transaction saving process');
      }

      // Анализируем holdings
      const holdings = await this.calculateHoldings(smartWallets);
      
      // Сортируем по разным критериям
      const byWalletCount = [...holdings]
        .sort((a, b) => b.uniqueWalletCount - a.uniqueWalletCount)
        .slice(0, 20);
        
      const byBalance = [...holdings]
        .sort((a, b) => b.totalBalanceUSD - a.totalBalanceUSD)
        .slice(0, 20);

      // Формируем сводку
      const totalValueUSD = holdings.reduce((sum, h) => sum + h.totalBalanceUSD, 0);
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
          totalUniqueWallets
        }
      };

      this.logger.info(`✅ Holdings analysis complete: ${report.totalTokens} tokens, $${this.formatNumber(report.totalValueUSD)} total value`);
      
      // 🔧 ДОПОЛНИТЕЛЬНАЯ ДИАГНОСТИКА
      if (report.totalTokens === 0) {
        this.logger.error('❌ HOLDINGS PROBLEM CONFIRMED: No tokens found in analysis');
        this.logger.error('❌ This means Smart Money transactions are not being saved to database properly');
      }

      return report;

    } catch (error) {
      this.logger.error('❌ Error in Smart Money Holdings Analysis:', error);
      throw error;
    }
  }

  /**
   * 🧮 РАСЧЕТ HOLDINGS ДЛЯ ВСЕХ ТОКЕНОВ
   */
  private async calculateHoldings(smartWallets: SmartMoneyWallet[]): Promise<TokenHolding[]> {
    
    // Проверяем кеш
    const cacheKey = 'all_holdings';
    const cached = this.holdingsCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.HOLDINGS_CACHE_TTL) {
      this.logger.info('📋 Using cached holdings data');
      return cached.data;
    }

    this.logger.info('🔍 Calculating fresh holdings data...');

    // Группируем транзакции по токенам
    const tokenData = new Map<string, {
      tokenAddress: string;
      tokenSymbol: string;
      tokenName: string;
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

    // Собираем данные о всех транзакциях SM кошельков за последние 30 дней
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    
    this.logger.info('🔍 Starting to collect transaction data from Smart Money wallets...');
    
    for (const wallet of smartWallets) {
      const transactions = await this.getWalletTransactionsAfter(wallet.address, thirtyDaysAgo);
      
      this.logger.debug(`📊 Wallet ${wallet.address.slice(0, 8)}... has ${transactions.length} transactions`);
      
      for (const tx of transactions) {
        const tokenKey = tx.tokenAddress;
        
        if (!tokenData.has(tokenKey)) {
          tokenData.set(tokenKey, {
            tokenAddress: tx.tokenAddress,
            tokenSymbol: tx.tokenSymbol,
            tokenName: tx.tokenName,
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

        // Обновляем первое время покупки
        if (this.isBuyTransaction(tx) && tx.timestamp < walletData.firstBuyTime) {
          walletData.firstBuyTime = tx.timestamp;
        }
      }
    }

    this.logger.info(`🔍 Collected data for ${tokenData.size} unique tokens`);

    // Преобразуем в TokenHolding объекты
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

      // Расчет балансов
      const totalBalance = validWallets.reduce((sum, [_, data]) => sum + data.netPosition, 0);
      const maxSingleHolding = Math.max(...validWallets.map(([_, data]) => data.netPosition));
      const avgBalance = totalBalance / validWallets.length;

      // Расчет объемов
      const totalBuyVolume = validWallets.reduce((sum, [_, data]) => sum + data.buyVolume, 0);
      const totalSellVolume = validWallets.reduce((sum, [_, data]) => sum + data.sellVolume, 0);

      // Расчет среднего времени держания
      const avgHoldingDays = validWallets.reduce((sum, [_, data]) => {
        const holdingTime = data.lastActivityTime.getTime() - data.firstBuyTime.getTime();
        return sum + (holdingTime / (1000 * 60 * 60 * 24));
      }, 0) / validWallets.length;

      // Топ холдеры
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

    this.logger.info(`✅ Calculated holdings for ${holdings.length} tokens`);
    return holdings;
  }

  /**
   * 📊 ОТПРАВКА ОТЧЕТА О HOLDINGS
   */
  async sendHoldingsReport(report: HoldingsReport): Promise<void> {
    try {
      // Отправляем общую сводку
      await this.telegramNotifier.sendCycleLog(
        `📊 <b>Smart Money Holdings Report</b>\n\n` +
        `🏷️ <b>Total Tokens:</b> <code>${report.totalTokens}</code>\n` +
        `💰 <b>Total Value:</b> <code>$${this.formatNumber(report.totalValueUSD)}</code>\n` +
        `👥 <b>Unique Wallets:</b> <code>${report.summary.totalUniqueWallets}</code>\n` +
        `📅 <b>Avg Holding:</b> <code>${report.summary.avgHoldingDays} days</code>\n\n` +
        `🥇 <b>Top by Wallets:</b> <code>#${report.summary.topTokenByWallets}</code>\n` +
        `💎 <b>Top by Value:</b> <code>#${report.summary.topTokenByValue}</code>\n\n` +
        `⏰ <code>${report.analysisTime.toLocaleString()}</code>`
      );

      // Отправляем топ токены по количеству кошельков
      if (report.byWalletCount.length > 0) {
        let walletCountMessage = `👥 <b>Top Tokens by Wallet Count</b>\n\n`;
        
        report.byWalletCount.slice(0, 10).forEach((token, index) => {
          const medal = index < 3 ? ['🥇', '🥈', '🥉'][index] : `${index + 1}.`;
          walletCountMessage += `${medal} <b>${token.tokenSymbol}</b>\n`;
          walletCountMessage += `    👥 Wallets: <code>${token.uniqueWalletCount}</code> `;
          walletCountMessage += `(🔫${token.sniperWallets} 💡${token.hunterWallets} 🐳${token.traderWallets})\n`;
          walletCountMessage += `    💰 Value: <code>$${this.formatNumber(token.totalBalanceUSD)}</code>\n\n`;
        });

        await this.telegramNotifier.sendCycleLog(walletCountMessage);
      }

      // Отправляем топ токены по балансу
      if (report.byBalance.length > 0) {
        let balanceMessage = `💰 <b>Top Tokens by Balance</b>\n\n`;
        
        report.byBalance.slice(0, 10).forEach((token, index) => {
          const medal = index < 3 ? ['🥇', '🥈', '🥉'][index] : `${index + 1}.`;
          balanceMessage += `${medal} <b>${token.tokenSymbol}</b>\n`;
          balanceMessage += `    💰 Total: <code>$${this.formatNumber(token.totalBalanceUSD)}</code>\n`;
          balanceMessage += `    📊 Avg: <code>$${this.formatNumber(token.avgBalancePerWallet)}</code>\n`;
          balanceMessage += `    🏆 Max: <code>$${this.formatNumber(token.maxSingleHolding)}</code>\n\n`;
        });

        await this.telegramNotifier.sendCycleLog(balanceMessage);
      }

      // Отправляем детали топ-3 токенов
      for (let i = 0; i < Math.min(3, report.byWalletCount.length); i++) {
        await this.sendDetailedHolding(report.byWalletCount[i], i + 1);
        await new Promise(resolve => setTimeout(resolve, 2000)); // Пауза между сообщениями
      }

      this.logger.info(`✅ Holdings report sent successfully`);

    } catch (error) {
      this.logger.error('❌ Error sending holdings report:', error);
    }
  }

  /**
   * 📋 ОТПРАВКА ДЕТАЛЬНОГО HOLDING
   */
  private async sendDetailedHolding(token: TokenHolding, rank: number): Promise<void> {
    try {
      const medal = rank <= 3 ? ['🥇', '🥈', '🥉'][rank - 1] : `#${rank}`;
      
      let message = `${medal} <b>Detailed Holding: ${token.tokenSymbol}</b>\n\n`;
      
      message += `📊 <b>Overview:</b>\n`;
      message += `• Unique Wallets: <code>${token.uniqueWalletCount}</code>\n`;
      message += `• Total Value: <code>$${this.formatNumber(token.totalBalanceUSD)}</code>\n`;
      message += `• Avg per Wallet: <code>$${this.formatNumber(token.avgBalancePerWallet)}</code>\n`;
      message += `• Max Single: <code>$${this.formatNumber(token.maxSingleHolding)}</code>\n\n`;

      message += `🎯 <b>Categories:</b>\n`;
      message += `• 🔫 Snipers: <code>${token.sniperWallets}</code>\n`;
      message += `• 💡 Hunters: <code>${token.hunterWallets}</code>\n`;
      message += `• 🐳 Traders: <code>${token.traderWallets}</code>\n\n`;

      message += `📈 <b>Activity:</b>\n`;
      message += `• Net Flow: <code>$${this.formatNumber(token.netFlow)}</code>\n`;
      message += `• Avg Holding: <code>${Math.round(token.avgHoldingDays)} days</code>\n`;
      message += `• First Seen: <code>${token.firstSeenAt.toLocaleDateString()}</code>\n\n`;

      message += `🏆 <b>Top Holders:</b>\n`;
      token.topHolders.slice(0, 3).forEach((holder, index) => {
        const categoryEmoji = {
          sniper: '🔫',
          hunter: '💡', 
          trader: '🐳'
        }[holder.category];
        
        message += `${index + 1}. ${categoryEmoji} <code>$${this.formatNumber(holder.balanceUSD)}</code> `;
        message += `(${holder.holdingDays}d)\n`;
      });

      message += `\n🔗 <code>${token.tokenAddress}</code>`;

      await this.telegramNotifier.sendCycleLog(message);
      
    } catch (error) {
      this.logger.error(`Error sending detailed holding for ${token.tokenSymbol}:`, error);
    }
  }

  // ========== ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ==========

  // 🔧 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Реальное получение транзакций + диагностика
  private async getWalletTransactionsAfter(walletAddress: string, afterDate: Date): Promise<TokenSwap[]> {
    try {
      // ✅ ИСПРАВЛЕНО: Используем публичный метод Smart Money базы данных
      const smTransactions = await this.smDatabase.getSmartWalletTransactions(walletAddress, afterDate);
      
      if (smTransactions.length > 0) {
        this.logger.debug(`💾 Found ${smTransactions.length} SM transactions for ${walletAddress.slice(0, 8)}...`);
        return smTransactions;
      }

      // ИСПРАВЛЕНО: Используем правильный метод Database
      const regularTransactions = await this.database.getWalletTransactionsAfter(walletAddress, afterDate);
      
      if (regularTransactions.length > 0) {
        this.logger.debug(`📊 Found ${regularTransactions.length} regular transactions for ${walletAddress.slice(0, 8)}...`);
        return regularTransactions;
      }

      // Если не найдено транзакций - логируем для диагностики
      this.logger.debug(`⚠️ No transactions found for wallet ${walletAddress.slice(0, 8)}... after ${afterDate.toISOString()}`);
      return [];

    } catch (error) {
      this.logger.error(`❌ Error getting transactions for wallet ${walletAddress}:`, error);
      return [];
    }
  }

  // 🆕 НОВЫЙ МЕТОД: Получение количества транзакций для диагностики
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
    cacheHitRate: number;
  } {
    return {
      holdingsCache: this.holdingsCache.size,
      cacheHitRate: 0 // Заглушка - можно добавить отслеживание
    };
  }

  // 🆕 ОЧИСТКА КЕША
  clearCache(): void {
    this.holdingsCache.clear();
    this.logger.info('🧹 Holdings cache cleared');
  }
}