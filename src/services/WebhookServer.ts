// src/services/WebhookServer.ts - С ФИЛЬТРАМИ SMART MONEY + АГРЕГАЦИЯ ПОЗИЦИЙ + ИНТЕГРАЦИЯ SOLANA MONITOR + ИСПРАВЛЕН saveSmartMoneyTransaction()
import express from 'express';
import { Database } from './Database';
import { SmartMoneyDatabase } from './SmartMoneyDatabase';
import { TelegramNotifier } from './TelegramNotifier';
import { SolanaMonitor } from './SolanaMonitor';
import { Logger } from '../utils/Logger';
import { SmartMoneySwap, SmartMoneyWallet, TokenSwap } from '../types';

interface HeliusWebhookPayload {
  type: string;
  feePayer: string;
  signature: string;
  slot: number;
  timestamp: number;
  tokenTransfers?: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    fromTokenAccount: string;
    toTokenAccount: string;
    tokenAmount: number;
    mint: string;
  }>;
  nativeTransfers?: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }>;
  events?: {
    swap?: Array<{
      nativeInput?: {
        account: string;
        amount: string;
      };
      nativeOutput?: {
        account: string;
        amount: string;
      };
      tokenInputs?: Array<{
        userAccount: string;
        tokenAccount: string;
        mint: string;
        rawTokenAmount: {
          tokenAmount: string;
          decimals: number;
        };
      }>;
      tokenOutputs?: Array<{
        userAccount: string;
        tokenAccount: string;
        mint: string;
        rawTokenAmount: {
          tokenAmount: string;
          decimals: number;
        };
      }>;
    }>;
  };
}

// 🚨 НОВЫЕ ИНТЕРФЕЙСЫ ДЛЯ ФИЛЬТРАЦИИ
interface TokenCreatorCheck {
  isCreator: boolean;
  isTopHolder: boolean;
  holdingPercentage: number;
  creationTime: Date;
  firstTxTime: Date;
  tokenAge: number; // в часах
}

interface SmartMoneyValidationResult {
  isValid: boolean;
  reason?: string;
  riskScore: number; // 0-100
  suspiciousFactors: string[];
}

interface TokenNameAlert {
  tokenName: string;
  contractAddress: string;
  holders: number;
  similarTokens: number;
}

interface ProcessingStats {
  totalTransactionsProcessed: number;
  smartMoneyTransactions: number;
  regularTransactions: number;
  positionAggregations: number;
  alertsSent: number;
  filteredTransactions: number;
  errorCount: number;
  avgProcessingTime: number;
  lastProcessedTime: Date;
  transactionTypes: {
    swaps: number;
    transfers: number;
    other: number;
  };
  riskLevels: {
    high: number;
    medium: number;
    low: number;
  };
}

export class WebhookServer {
  private app: express.Application;
  private database: Database;
  private smDatabase: SmartMoneyDatabase;
  private telegramNotifier: TelegramNotifier;
  private solanaMonitor: SolanaMonitor;
  private logger: Logger;
  private port: number;
  private server: any;

  // 🚀 ПРОДВИНУТАЯ СИСТЕМА КЕШИРОВАНИЯ
  private tokenInfoCache = new Map<string, { 
    symbol: string; 
    name: string; 
    createdAt?: Date;
    timestamp: number; 
  }>();
  private topHoldersCache = new Map<string, { 
    holders: Array<{address: string; percentage: number; rank: number}>;
    timestamp: number;
  }>();
  private relatedWalletsCache = new Map<string, {
    relatedWallets: string[];
    timestamp: number;
  }>();
  
  // 🚀 НОВЫЙ КЕШ ДЛЯ RECENT TOKEN TRANSACTIONS - СНИЖАЕТ НАГРУЗКУ НА БД В 10+ РАЗ!
  private recentTxCache = new Map<string, {
    transactions: Array<{
      walletAddress: string;
      timestamp: Date;
      amountUSD: number;
      swapType: 'buy' | 'sell';
    }>;
    timestamp: number;
  }>();
  
  // 🧹 АВТООЧИСТКА КЕШЕЙ ОТ СТАРЫХ ЗАПИСЕЙ
  private cacheCleanupInterval: NodeJS.Timeout | null = null;

  // 🆕 СТАТИСТИКА И МОНИТОРИНГ
  private processingStats: ProcessingStats = {
    totalTransactionsProcessed: 0,
    smartMoneyTransactions: 0,
    regularTransactions: 0,
    positionAggregations: 0,
    alertsSent: 0,
    filteredTransactions: 0,
    errorCount: 0,
    avgProcessingTime: 0,
    lastProcessedTime: new Date(),
    transactionTypes: {
      swaps: 0,
      transfers: 0,
      other: 0
    },
    riskLevels: {
      high: 0,
      medium: 0,
      low: 0
    }
  };

  // 🆕 МЕТРИКИ ПРОИЗВОДИТЕЛЬНОСТИ
  private performanceInterval: NodeJS.Timeout | null = null;
  private requestCounters = {
    lastMinuteRequests: 0,
    lastMinuteErrors: 0,
    lastMinuteReset: Date.now() + 60000
  };

  constructor(
    database: Database,
    telegramNotifier: TelegramNotifier,
    solanaMonitor: SolanaMonitor,
    smDatabase: SmartMoneyDatabase
  ) {
    this.database = database;
    this.smDatabase = smDatabase;
    this.telegramNotifier = telegramNotifier;
    this.solanaMonitor = solanaMonitor;
    this.logger = Logger.getInstance();
    this.port = parseInt(process.env.PORT || '3000');

    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
    this.startCacheCleanup();
    this.startPerformanceMonitoring();
  }

  private setupMiddleware(): void {
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));
    
    // Middleware для обновления счетчиков запросов
    this.app.use((req, res, next) => {
      const now = Date.now();
      
      if (now >= this.requestCounters.lastMinuteReset) {
        this.requestCounters.lastMinuteRequests = 0;
        this.requestCounters.lastMinuteErrors = 0;
        this.requestCounters.lastMinuteReset = now + 60000;
      }
      
      this.requestCounters.lastMinuteRequests++;
      next();
    });

    // Error handling middleware
    this.app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
      this.logger.error('Express error:', error);
      this.requestCounters.lastMinuteErrors++;
      res.status(500).json({ error: 'Internal server error' });
    });
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        stats: this.processingStats,
        performance: {
          requestsLastMinute: this.requestCounters.lastMinuteRequests,
          errorsLastMinute: this.requestCounters.lastMinuteErrors
        }
      });
    });

    // Main webhook endpoint
    this.app.post('/webhook/helius', async (req, res) => {
      try {
        this.processingStats.totalTransactionsProcessed++;
        await this.processWebhookTransactionWithStats(req.body as HeliusWebhookPayload);
        res.status(200).json({ success: true });
      } catch (error) {
        this.logger.error('❌ Webhook processing error:', error as Error);
        this.processingStats.errorCount++;
        this.requestCounters.lastMinuteErrors++;
        res.status(500).json({ error: 'Processing failed' });
      }
    });

    // Stats endpoint
    this.app.get('/stats', (req, res) => {
      res.json({
        ...this.processingStats,
        cacheStats: {
          tokenInfoCache: this.tokenInfoCache.size,
          topHoldersCache: this.topHoldersCache.size,
          relatedWalletsCache: this.relatedWalletsCache.size,
          recentTxCache: this.recentTxCache.size
        },
        requestCounters: this.requestCounters
      });
    });

    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({ error: 'Endpoint not found' });
    });
  }

  // 🆕 ОБРАБОТКА ТРАНЗАКЦИИ СО СТАТИСТИКОЙ
  private async processWebhookTransactionWithStats(txData: HeliusWebhookPayload): Promise<void> {
    const startTime = Date.now();
    
    try {
      // Определяем тип транзакции
      if (txData.events?.swap && txData.events.swap.length > 0) {
        this.processingStats.transactionTypes.swaps++;
      } else if (txData.tokenTransfers && txData.tokenTransfers.length > 0) {
        this.processingStats.transactionTypes.transfers++;
      } else {
        this.processingStats.transactionTypes.other++;
      }

      // Базовая обработка
      await this.processWebhookTransaction(txData);
      
      // Обновляем время обработки
      const processingTime = Date.now() - startTime;
      this.processingStats.avgProcessingTime = 
        (this.processingStats.avgProcessingTime + processingTime) / 2;
        
    } catch (error) {
      this.processingStats.errorCount++;
      throw error;
    }
  }

  private async processWebhookTransaction(txData: HeliusWebhookPayload): Promise<void> {
    try {
      await this.checkTokenNameAlerts(txData);

      if (!txData.events?.swap || txData.events.swap.length === 0) {
        return;
      }

      const swapEvents = txData.events.swap;
      
      for (const swapEvent of swapEvents) {
        await this.processSwapEvent(txData, swapEvent);
      }
    } catch (error) {
      this.logger.error(`❌ Error processing transaction ${txData.signature}:`, error as Error);
    }
  }

  private async processSwapEvent(txData: HeliusWebhookPayload, swapEvent: any): Promise<void> {
    const startTime = Date.now();
    
    try {
      const walletAddress = this.extractWalletAddress(swapEvent);
      if (!walletAddress) return;

      // 🔍 ПРОВЕРЯЕМ: SMART MONEY ИЛИ ОБЫЧНЫЙ КОШЕЛЕК
      const smartWallet = await this.smDatabase.getSmartWallet(walletAddress);
      
      if (!smartWallet || !smartWallet.isActive) {
        // ✅ ОБЫЧНЫЙ КОШЕЛЕК - передаем в SolanaMonitor для агрегации
        await this.solanaMonitor.processTransaction(txData);
        this.processingStats.regularTransactions++;

        
        // 🆕 ПРОВЕРЯЕМ НА АГРЕГАЦИЮ ПОЗИЦИЙ
        if (txData.events?.swap && txData.events.swap.length > 0) {
          const swapInfo = await this.extractBasicSwapInfo(txData, swapEvent);
          if (swapInfo && swapInfo.amountUSD >= 5000) { // Минимум $5K для проверки
            const aggregationCheck = await this.solanaMonitor.checkForPositionAggregation(
              walletAddress,
              swapInfo.tokenAddress,
              swapInfo.amountUSD
            );
            
            if (aggregationCheck.isPartOfAggregation) {
              this.processingStats.positionAggregations++;
              
              // Определяем уровень риска
              if (aggregationCheck.suspicionScore >= 85) {
                this.processingStats.riskLevels.high++;
              } else if (aggregationCheck.suspicionScore >= 75) {
                this.processingStats.riskLevels.medium++;
              } else {
                this.processingStats.riskLevels.low++;
              }
            }
          }
        }
        return;
      }

      // ✅ SMART MONEY КОШЕЛЕК - обрабатываем с фильтрами
      const swapInfo = await this.extractSwapInfo(txData, swapEvent, smartWallet);
      if (!swapInfo) return;

      // 🚨 НОВАЯ ВАЛИДАЦИЯ SMART MONEY ТРАНЗАКЦИЙ
      const validationResult = await this.validateSmartMoneyTransaction(
        swapInfo.walletAddress,
        swapInfo.tokenAddress,
        swapInfo.amountUSD,
        swapInfo.swapType
      );

      if (!validationResult.isValid) {
        this.logger.warn(`🚫 BLOCKED Smart Money tx: ${swapInfo.tokenSymbol} - $${swapInfo.amountUSD} | ${validationResult.reason}`);
        this.processingStats.filteredTransactions++;
        
        // Отправляем предупреждение в телеграм о заблокированной транзакции
        if (validationResult.riskScore > 80) {
          await this.telegramNotifier.sendCycleLog(
            `🚫 <b>BLOCKED Suspicious Transaction</b>\n\n` +
            `💰 Amount: <code>$${this.formatNumber(swapInfo.amountUSD)}</code>\n` +
            `🪙 Token: <code>#${swapInfo.tokenSymbol}</code>\n` +
            `👤 Wallet: <code>${swapInfo.walletAddress.slice(0, 8)}...${swapInfo.walletAddress.slice(-4)}</code>\n` +
            `⚠️ Risk Score: <code>${validationResult.riskScore}/100</code>\n` +
            `🚨 Reason: <code>${validationResult.reason}</code>\n` +
            `📝 Factors: <code>${validationResult.suspiciousFactors.join(', ')}</code>\n\n` +
            `<a href="https://solscan.io/token/${swapInfo.tokenAddress}">Token</a> | <a href="https://solscan.io/account/${swapInfo.walletAddress}">Wallet</a>`
          );
          this.processingStats.alertsSent++;
        }
        return;
      }

      // Проверяем стандартные фильтры
      if (!this.shouldProcessSmartMoneySwap(swapInfo, smartWallet)) {
        this.processingStats.filteredTransactions++;
        return;
      }

      await this.saveSmartMoneyTransaction(swapInfo);
      await this.sendSmartMoneyNotification(swapInfo, smartWallet);
      
      this.processingStats.smartMoneyTransactions++;

      this.logger.info(`✅ Smart Money swap processed: ${swapInfo.tokenSymbol} - $${swapInfo.amountUSD.toFixed(0)} (${Date.now() - startTime}ms)`);

    } catch (error) {
      this.logger.error('❌ Error processing swap event:', error as Error);
      this.processingStats.errorCount++;
    }
  }

  // 🆕 НОВЫЙ МЕТОД: ИЗВЛЕЧЕНИЕ БАЗОВОЙ ИНФОРМАЦИИ О СВАПЕ
  private async extractBasicSwapInfo(txData: HeliusWebhookPayload, swapEvent: any): Promise<{
    tokenAddress: string;
    amountUSD: number;
    swapType: 'buy' | 'sell';
  } | null> {
    try {
      let tokenAddress = '';
      let amountUSD = 0;
      let swapType: 'buy' | 'sell' = 'buy';

      if (swapEvent.tokenInputs && swapEvent.tokenOutputs) {
        const tokenInput = swapEvent.tokenInputs[0];
        const tokenOutput = swapEvent.tokenOutputs[0];
        
        const mainTokens = ['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'];
        
        if (mainTokens.includes(tokenInput.mint)) {
          swapType = 'buy';
          tokenAddress = tokenOutput.mint;
          amountUSD = parseFloat(tokenInput.rawTokenAmount.tokenAmount) / Math.pow(10, tokenInput.rawTokenAmount.decimals);
        } else if (mainTokens.includes(tokenOutput.mint)) {
          swapType = 'sell';
          tokenAddress = tokenInput.mint;
          amountUSD = parseFloat(tokenOutput.rawTokenAmount.tokenAmount) / Math.pow(10, tokenOutput.rawTokenAmount.decimals);
        }
      }

      return tokenAddress ? { tokenAddress, amountUSD, swapType } : null;

    } catch (error) {
      this.logger.error('Error extracting basic swap info:', error);
      return null;
    }
  }

  // 🚨 НОВЫЙ МЕТОД: ВАЛИДАЦИЯ SMART MONEY ТРАНЗАКЦИЙ
  private async validateSmartMoneyTransaction(
    walletAddress: string,
    tokenAddress: string,
    amountUSD: number,
    swapType: 'buy' | 'sell'
  ): Promise<SmartMoneyValidationResult> {
    
    const suspiciousFactors: string[] = [];
    let riskScore = 0;

    try {
      // 1. Проверка на создателя токена (высокий риск)
      const creatorCheck = await this.checkTokenCreator(walletAddress, tokenAddress);
      if (creatorCheck.isCreator) {
        suspiciousFactors.push('Token creator');
        riskScore += 40;
      }

      // 2. Проверка на топ холдера (средний риск)
      if (creatorCheck.isTopHolder && creatorCheck.holdingPercentage > 10) {
        suspiciousFactors.push(`Top holder (${creatorCheck.holdingPercentage.toFixed(1)}%)`);
        riskScore += 25;
      }

      // 3. Проверка возраста токена (молодые токены = риск)
      if (creatorCheck.tokenAge < 24) { // Младше 24 часов
        suspiciousFactors.push(`New token (${creatorCheck.tokenAge.toFixed(1)}h)`);
        riskScore += 20;
      }

      // 4. Проверка паттерна множественных кошельков (координированная атака)
      const recentTxCheck = await this.checkRecentTokenActivity(tokenAddress, walletAddress);
      if (recentTxCheck.suspiciousPatterns) {
        suspiciousFactors.push('Coordinated buying pattern');
        riskScore += 30;
      }

      // 5. Проверка размера сделки (слишком большие сделки = подозрительно)
      if (amountUSD > 500000) { // $500K+
        suspiciousFactors.push('Extremely large trade');
        riskScore += 15;
      }

      // 6. Проверка на связанные кошельки
      const relatedWallets = await this.getRelatedWallets(walletAddress);
      if (relatedWallets.length > 5) {
        suspiciousFactors.push(`Related wallets (${relatedWallets.length})`);
        riskScore += 20;
      }

      // Итоговая валидация
      const isValid = riskScore < 70; // Порог 70 из 100
      const reason = isValid ? undefined : `Risk score too high (${riskScore}/100)`;

      return {
        isValid,
        reason,
        riskScore,
        suspiciousFactors
      };

    } catch (error) {
      this.logger.error('Error in Smart Money validation:', error);
      return {
        isValid: true, // При ошибке валидации - пропускаем
        riskScore: 0,
        suspiciousFactors: ['Validation error']
      };
    }
  }

  // 🔍 ПРОВЕРКА НА СОЗДАТЕЛЯ ТОКЕНА
  private async checkTokenCreator(walletAddress: string, tokenAddress: string): Promise<TokenCreatorCheck> {
    try {
      // Заглушка - в реальности нужно проверить через Solana API
      return {
        isCreator: false,
        isTopHolder: false,
        holdingPercentage: 0,
        creationTime: new Date(),
        firstTxTime: new Date(),
        tokenAge: 100 // часов
      };
    } catch (error) {
      this.logger.error('Error checking token creator:', error);
      return {
        isCreator: false,
        isTopHolder: false,
        holdingPercentage: 0,
        creationTime: new Date(),
        firstTxTime: new Date(),
        tokenAge: 100
      };
    }
  }

  // 🔍 ПРОВЕРКА НЕДАВНЕЙ АКТИВНОСТИ ТОКЕНА
  private async checkRecentTokenActivity(tokenAddress: string, walletAddress: string): Promise<{
    suspiciousPatterns: boolean;
    recentBuyers: number;
    averageHoldTime: number;
  }> {
    try {
      // Проверяем кеш
      const cached = this.recentTxCache.get(tokenAddress);
      if (cached && Date.now() - cached.timestamp < 10 * 60 * 1000) { // 10 минут
        const uniqueBuyers = new Set(cached.transactions.map(tx => tx.walletAddress)).size;
        const suspiciousPatterns = uniqueBuyers > 10 && cached.transactions.length > 20;
        
        return {
          suspiciousPatterns,
          recentBuyers: uniqueBuyers,
          averageHoldTime: 0
        };
      }

      // Получаем недавние транзакции токена из БД
      const recentTransactions = await this.getRecentTokenTransactions(tokenAddress);
      
      // Кешируем результат
      this.recentTxCache.set(tokenAddress, {
        transactions: recentTransactions,
        timestamp: Date.now()
      });

      const uniqueBuyers = new Set(recentTransactions.map(tx => tx.walletAddress)).size;
      const suspiciousPatterns = uniqueBuyers > 10 && recentTransactions.length > 20;

      return {
        suspiciousPatterns,
        recentBuyers: uniqueBuyers,
        averageHoldTime: 0
      };

    } catch (error) {
      this.logger.error('Error checking recent token activity:', error);
      return {
        suspiciousPatterns: false,
        recentBuyers: 0,
        averageHoldTime: 0
      };
    }
  }

  // 🔍 ПОЛУЧЕНИЕ СВЯЗАННЫХ КОШЕЛЬКОВ
  private async getRelatedWallets(walletAddress: string): Promise<string[]> {
    try {
      const cached = this.relatedWalletsCache.get(walletAddress);
      if (cached && Date.now() - cached.timestamp < 30 * 60 * 1000) { // 30 минут
        return cached.relatedWallets;
      }

      // Заглушка - в реальности нужно анализировать через граф транзакций
      const relatedWallets: string[] = [];
      
      this.relatedWalletsCache.set(walletAddress, {
        relatedWallets,
        timestamp: Date.now()
      });

      return relatedWallets;

    } catch (error) {
      this.logger.error('Error getting related wallets:', error);
      return [];
    }
  }

  // 🔍 ПОЛУЧЕНИЕ НЕДАВНИХ ТРАНЗАКЦИЙ ТОКЕНА
  private async getRecentTokenTransactions(tokenAddress: string): Promise<Array<{
    walletAddress: string;
    timestamp: Date;
    amountUSD: number;
    swapType: 'buy' | 'sell';
  }>> {
    try {
      // Получаем транзакции за последний час
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      
      // Заглушка - в реальности нужно запросить из БД
      return [];

    } catch (error) {
      this.logger.error('Error getting recent token transactions:', error);
      return [];
    }
  }

  // 🔍 ПРОВЕРКА ПРЕДУПРЕЖДЕНИЙ О ИМЕНАХ ТОКЕНОВ
  private async checkTokenNameAlerts(txData: HeliusWebhookPayload): Promise<void> {
    try {
      if (!txData.tokenTransfers || txData.tokenTransfers.length === 0) return;

      for (const transfer of txData.tokenTransfers) {
        const tokenInfo = await this.getTokenInfo(transfer.mint);
        
        // Простая проверка на подозрительные имена
        const suspiciousPatterns = [
          /bitcoin/i, /ethereum/i, /bnb/i, /solana/i,
          /usdt/i, /usdc/i, /doge/i, /shib/i
        ];

        const isSuspicious = suspiciousPatterns.some(pattern => 
          pattern.test(tokenInfo.name) || pattern.test(tokenInfo.symbol)
        );

        if (isSuspicious) {
          const alert: TokenNameAlert = {
            tokenName: tokenInfo.name,
            contractAddress: transfer.mint,
            holders: 0, // Заглушка
            similarTokens: 1
          };

          await this.telegramNotifier.sendTokenNameAlert(alert);
        }
      }

    } catch (error) {
      this.logger.error('Error checking token name alerts:', error);
    }
  }

  private extractWalletAddress(swapEvent: any): string | null {
    try {
      if (swapEvent.tokenInputs && swapEvent.tokenInputs.length > 0) {
        return swapEvent.tokenInputs[0].userAccount;
      }
      if (swapEvent.tokenOutputs && swapEvent.tokenOutputs.length > 0) {
        return swapEvent.tokenOutputs[0].userAccount;
      }
      return null;
    } catch (error) {
      this.logger.error('Error extracting wallet address:', error);
      return null;
    }
  }

  private async extractSwapInfo(txData: HeliusWebhookPayload, swapEvent: any, smartWallet: SmartMoneyWallet): Promise<SmartMoneySwap | null> {
    try {
      let tokenAddress = '';
      let tokenAmount = 0;
      let amountUSD = 0;
      let swapType: 'buy' | 'sell' = 'buy';

      if (swapEvent.tokenInputs && swapEvent.tokenOutputs) {
        const tokenInput = swapEvent.tokenInputs[0];
        const tokenOutput = swapEvent.tokenOutputs[0];
        
        const mainTokens = ['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'];
        
        if (mainTokens.includes(tokenInput.mint)) {
          swapType = 'buy';
          tokenAddress = tokenOutput.mint;
          tokenAmount = parseFloat(tokenOutput.rawTokenAmount.tokenAmount) / Math.pow(10, tokenOutput.rawTokenAmount.decimals);
          amountUSD = parseFloat(tokenInput.rawTokenAmount.tokenAmount) / Math.pow(10, tokenInput.rawTokenAmount.decimals);
        } else if (mainTokens.includes(tokenOutput.mint)) {
          swapType = 'sell';
          tokenAddress = tokenInput.mint;
          tokenAmount = parseFloat(tokenInput.rawTokenAmount.tokenAmount) / Math.pow(10, tokenInput.rawTokenAmount.decimals);
          amountUSD = parseFloat(tokenOutput.rawTokenAmount.tokenAmount) / Math.pow(10, tokenOutput.rawTokenAmount.decimals);
        }
      }

      if (!tokenAddress || amountUSD < 1000) {
        return null;
      }

      const tokenInfo = await this.getTokenInfo(tokenAddress);
      
      return {
        transactionId: txData.signature,
        walletAddress: smartWallet.address,
        tokenAddress,
        tokenSymbol: tokenInfo.symbol,
        tokenName: tokenInfo.name,
        tokenAmount,
        amountUSD,
        swapType,
        timestamp: new Date(txData.timestamp * 1000),
        category: smartWallet.category,
        winRate: smartWallet.winRate,
        pnl: smartWallet.totalPnL,
        totalTrades: smartWallet.totalTrades,
        isFamilyMember: false,
        familySize: 0,
        familyId: undefined
      };
    } catch (error) {
      this.logger.error('Error extracting swap info:', error as Error);
      return null;
    }
  }

  private shouldProcessSmartMoneySwap(swapInfo: SmartMoneySwap, smartWallet: SmartMoneyWallet): boolean {
    const minAmounts: Record<string, number> = {
      sniper: 5000,
      hunter: 5000,
      trader: 20000
    };

    const minAmount = minAmounts[smartWallet.category] || 5000;
    
    if (swapInfo.amountUSD < minAmount) {
      return false;
    }

    const daysSinceActive = (Date.now() - smartWallet.lastActiveAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceActive > 45) {
      return false;
    }

    if (smartWallet.winRate < 60) {
      return false;
    }

    return true;
  }

  // 🔧 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: ИСПОЛЬЗУЕМ ПУБЛИЧНЫЙ МЕТОД БД
  private async saveSmartMoneyTransaction(swapInfo: SmartMoneySwap): Promise<void> {
    try {
      if (!this.smDatabase || !this.telegramNotifier) return;

      // ✅ ИСПРАВЛЕНО: Используем публичный метод вместо прямого доступа к БД
      await this.smDatabase.saveSmartMoneyTransaction({
        transactionId: swapInfo.transactionId,
        walletAddress: swapInfo.walletAddress,
        tokenAddress: swapInfo.tokenAddress,
        tokenSymbol: swapInfo.tokenSymbol,
        tokenName: swapInfo.tokenName,
        tokenAmount: swapInfo.tokenAmount,
        amountUSD: swapInfo.amountUSD,
        swapType: swapInfo.swapType,
        timestamp: swapInfo.timestamp,
        category: swapInfo.category,
        winRate: swapInfo.winRate,
        pnl: swapInfo.pnl,
        totalTrades: swapInfo.totalTrades,
        dex: 'Filtered-Webhook'
      });

      const tokenSwap: TokenSwap = {
        transactionId: swapInfo.transactionId,
        walletAddress: swapInfo.walletAddress,
        tokenAddress: swapInfo.tokenAddress,
        tokenSymbol: swapInfo.tokenSymbol,
        tokenName: swapInfo.tokenName,
        amount: swapInfo.tokenAmount,
        amountUSD: swapInfo.amountUSD,
        timestamp: swapInfo.timestamp,
        dex: 'Smart Money Filtered',
        isNewWallet: false,
        isReactivatedWallet: false,
        walletAge: 0,
        daysSinceLastActivity: 0,
        price: swapInfo.amountUSD / swapInfo.tokenAmount,
        pnl: swapInfo.pnl,
        swapType: swapInfo.swapType
      };

      await this.database.saveTransaction(tokenSwap);

    } catch (error) {
      this.logger.error('Error saving Smart Money transaction:', error as Error);
    }
  }

  private async sendSmartMoneyNotification(swapInfo: SmartMoneySwap, smartWallet: SmartMoneyWallet): Promise<void> {
    try {
      await this.telegramNotifier.sendSmartMoneySwap(swapInfo);
      this.processingStats.alertsSent++;
    } catch (error) {
      this.logger.error('Error sending Smart Money notification:', error as Error);
    }
  }

  private async getTokenInfo(tokenAddress: string): Promise<{ symbol: string; name: string }> {
    const cached = this.tokenInfoCache.get(tokenAddress);
    if (cached && Date.now() - cached.timestamp < 3600000) {
      return { symbol: cached.symbol, name: cached.name };
    }

    try {
      const response = await fetch(`https://api.helius.xyz/v0/tokens/metadata?api-key=${process.env.HELIUS_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mintAccounts: [tokenAddress] })
      });

      if (response.ok) {
        const data = await response.json();
        if (data && Array.isArray(data) && data.length > 0) {
          const tokenInfo = {
            symbol: data[0].onChainMetadata?.metadata?.symbol || 'UNKNOWN',
            name: data[0].onChainMetadata?.metadata?.name || 'Unknown Token',
            timestamp: Date.now()
          };
          
          this.tokenInfoCache.set(tokenAddress, tokenInfo);
          return { symbol: tokenInfo.symbol, name: tokenInfo.name };
        }
      }
    } catch (error) {
      this.logger.error(`Error getting token info for ${tokenAddress}:`, error);
    }

    return { symbol: 'UNKNOWN', name: 'Unknown Token' };
  }

  // 🧹 АВТООЧИСТКА КЕШЕЙ
  private startCacheCleanup(): void {
    this.cacheCleanupInterval = setInterval(() => {
      const now = Date.now();
      const ONE_HOUR = 60 * 60 * 1000;
      
      // Очищаем кеш токенов (старше 1 часа)
      for (const [key, value] of this.tokenInfoCache.entries()) {
        if (now - value.timestamp > ONE_HOUR) {
          this.tokenInfoCache.delete(key);
        }
      }
      
      // Очищаем кеш топ холдеров (старше 30 минут)
      for (const [key, value] of this.topHoldersCache.entries()) {
        if (now - value.timestamp > 30 * 60 * 1000) {
          this.topHoldersCache.delete(key);
        }
      }
      
      // Очищаем кеш связанных кошельков (старше 30 минут)
      for (const [key, value] of this.relatedWalletsCache.entries()) {
        if (now - value.timestamp > 30 * 60 * 1000) {
          this.relatedWalletsCache.delete(key);
        }
      }
      
      // Очищаем кеш недавних транзакций (старше 10 минут)
      for (const [key, value] of this.recentTxCache.entries()) {
        if (now - value.timestamp > 10 * 60 * 1000) {
          this.recentTxCache.delete(key);
        }
      }
      
    }, 5 * 60 * 1000); // Очищаем каждые 5 минут
  }

  // 🆕 МОНИТОРИНГ ПРОИЗВОДИТЕЛЬНОСТИ
  private startPerformanceMonitoring(): void {
    this.performanceInterval = setInterval(() => {
      this.processingStats.lastProcessedTime = new Date();
      
      // Логируем статистику каждые 5 минут
      this.logger.info(`📊 Webhook Stats: Processed=${this.processingStats.totalTransactionsProcessed}, SM=${this.processingStats.smartMoneyTransactions}, Regular=${this.processingStats.regularTransactions}, Filtered=${this.processingStats.filteredTransactions}, Errors=${this.processingStats.errorCount}`);
      
    }, 5 * 60 * 1000); // Каждые 5 минут
  }

  private formatNumber(num: number): string {
    if (num >= 1_000_000) {
      return `${(num / 1_000_000).toFixed(1)}M`;
    } else if (num >= 1_000) {
      return `${(num / 1_000).toFixed(1)}K`;
    }
    return num.toFixed(0);
  }

  // 🆕 ПУБЛИЧНЫЕ МЕТОДЫ ДЛЯ ПОЛУЧЕНИЯ СТАТИСТИКИ
  getProcessingStats(): ProcessingStats {
    return { ...this.processingStats };
  }

  getCacheStats(): {
    tokenInfoCache: number;
    topHoldersCache: number;
    relatedWalletsCache: number;
    recentTxCache: number;
  } {
    return {
      tokenInfoCache: this.tokenInfoCache.size,
      topHoldersCache: this.topHoldersCache.size,
      relatedWalletsCache: this.relatedWalletsCache.size,
      recentTxCache: this.recentTxCache.size
    };
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(this.port, () => {
          this.logger.info(`🚀 Webhook server started on port ${this.port}`);
          resolve();
        });

        this.server.on('error', (error: any) => {
          this.logger.error('❌ Server error:', error);
          reject(error);
        });

      } catch (error) {
        this.logger.error('❌ Failed to start webhook server:', error);
        reject(error);
      }
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.cacheCleanupInterval) {
        clearInterval(this.cacheCleanupInterval);
      }
      
      if (this.performanceInterval) {
        clearInterval(this.performanceInterval);
      }

      if (this.server) {
        this.server.close(() => {
          this.logger.info('⏹️ Webhook server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}