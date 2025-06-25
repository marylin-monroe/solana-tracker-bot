// src/services/WebhookServer.ts - 🔥 ИСПРАВЛЕНА КРИТИЧНАЯ ЛОГИКА СВАПОВ
import express from 'express';
import { Database } from './Database';
import { SmartMoneyDatabase } from './SmartMoneyDatabase';
import { TelegramNotifier } from './TelegramNotifier';
import { SolanaMonitor } from './SolanaMonitor';
import { TokenMetadataService } from './TokenMetadataService';
import { Logger } from '../utils/Logger';
import { SmartMoneySwap, SmartMoneyWallet, TokenSwap } from '../types';

interface SolanaWebhookPayload {
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

interface TokenCreatorCheck {
  isCreator: boolean;
  isTopHolder: boolean;
  holdingPercentage: number;
  creationTime: Date;
  firstTxTime: Date;
  tokenAge: number;
}

interface SmartMoneyValidationResult {
  isValid: boolean;
  reason?: string;
  riskScore: number;
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
  usdCalculationStats: {
    correctCalculations: number;
    fallbackCalculations: number;
    errorCalculations: number;
  };
}

export class WebhookServer {
  private app: express.Application;
  private database: Database;
  private smDatabase: SmartMoneyDatabase;
  private telegramNotifier: TelegramNotifier;
  private solanaMonitor: SolanaMonitor | null;
  private tokenMetadataService: TokenMetadataService;
  private logger: Logger;
  private port: number;
  private server: any;

  private tokenInfoCache = new Map<string, { 
    symbol: string; 
    name: string; 
    decimals: number;
    isCexListed?: boolean;
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
  
  private recentTxCache = new Map<string, {
    transactions: Array<{
      walletAddress: string;
      timestamp: Date;
      amountUSD: number;
      swapType: 'buy' | 'sell';
    }>;
    timestamp: number;
  }>();
  
  private cacheCleanupInterval: NodeJS.Timeout | null = null;

  // 🔥 МАЖОРНЫЕ ТОКЕНЫ - ОСНОВА ПРАВИЛЬНОЙ ЛОГИКИ
  private readonly MAJOR_TOKENS = new Set([
    'So11111111111111111111111111111111111111112', // SOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'  // USDT
  ]);

  // 📈 ПОПУЛЯРНЫЕ CEX ТОКЕНЫ (для пометки)
  private readonly CEX_TOKENS = new Set([
    'So11111111111111111111111111111111111111112', // SOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
    'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // JitoSOL
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // Bonk
    'WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk', // WEN
    'CLoUDKc4Ane7HeQcPpE3YHnznRxhMimJ4MyaUqyHFzAu' // CLOUD
  ]);

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
    },
    usdCalculationStats: {
      correctCalculations: 0,
      fallbackCalculations: 0,
      errorCalculations: 0
    }
  };

  private performanceInterval: NodeJS.Timeout | null = null;
  private requestCounters = {
    lastMinuteRequests: 0,
    lastMinuteErrors: 0,
    lastMinuteReset: Date.now() + 60000
  };

  constructor(
    database: Database,
    telegramNotifier: TelegramNotifier,
    solanaMonitor: SolanaMonitor | null,
    smDatabase: SmartMoneyDatabase
  ) {
    this.database = database;
    this.smDatabase = smDatabase;
    this.telegramNotifier = telegramNotifier;
    this.solanaMonitor = solanaMonitor;
    this.tokenMetadataService = new TokenMetadataService();
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

    this.app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
      this.logger.error('Express error:', error);
      this.requestCounters.lastMinuteErrors++;
      res.status(500).json({ error: 'Internal server error' });
    });
  }

  private setupRoutes(): void {
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

    this.app.post('/webhook/solana', async (req, res) => {
      try {
        this.processingStats.totalTransactionsProcessed++;
        await this.processWebhookTransactionWithStats(req.body as SolanaWebhookPayload);
        res.status(200).json({ success: true });
      } catch (error) {
        this.logger.error('❌ Webhook processing error:', error as Error);
        this.processingStats.errorCount++;
        this.requestCounters.lastMinuteErrors++;
        res.status(500).json({ error: 'Processing failed' });
      }
    });

    this.app.post('/webhook/helius', async (req, res) => {
      try {
        this.processingStats.totalTransactionsProcessed++;
        await this.processWebhookTransactionWithStats(req.body as SolanaWebhookPayload);
        res.status(200).json({ success: true });
      } catch (error) {
        this.logger.error('❌ Webhook processing error:', error as Error);
        this.processingStats.errorCount++;
        this.requestCounters.lastMinuteErrors++;
        res.status(500).json({ error: 'Processing failed' });
      }
    });

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

    this.app.use((req, res) => {
      res.status(404).json({ error: 'Endpoint not found' });
    });
  }

  private async processWebhookTransactionWithStats(txData: SolanaWebhookPayload): Promise<void> {
    const startTime = Date.now();
    
    try {
      if (txData.events?.swap && txData.events.swap.length > 0) {
        this.processingStats.transactionTypes.swaps++;
      } else if (txData.tokenTransfers && txData.tokenTransfers.length > 0) {
        this.processingStats.transactionTypes.transfers++;
      } else {
        this.processingStats.transactionTypes.other++;
      }

      await this.processWebhookTransaction(txData);
      
      const processingTime = Date.now() - startTime;
      this.processingStats.avgProcessingTime = 
        (this.processingStats.avgProcessingTime + processingTime) / 2;
        
    } catch (error) {
      this.processingStats.errorCount++;
      throw error;
    }
  }

  private async processWebhookTransaction(txData: SolanaWebhookPayload): Promise<void> {
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

  private async processSwapEvent(txData: SolanaWebhookPayload, swapEvent: any): Promise<void> {
    const startTime = Date.now();
    
    try {
      const walletAddress = this.extractWalletAddress(swapEvent);
      if (!walletAddress) return;

      const smartWallet = await this.smDatabase.getSmartWallet(walletAddress);
      
      if (!smartWallet || !smartWallet.isActive) {
        if (this.solanaMonitor) {
          await this.solanaMonitor.processTransaction(txData);
        }
        this.processingStats.regularTransactions++;
        return;
      }

      // 🔥 ПРАВИЛЬНАЯ ЛОГИКА СВАПОВ
      const swapInfo = await this.extractSwapInfo(txData, swapEvent, smartWallet);
      if (!swapInfo) return;

      // ✅ ФИЛЬТРЫ ПО КАТЕГОРИЯМ  
      if (!this.shouldProcessSmartMoneySwap(swapInfo, smartWallet)) {
        this.processingStats.filteredTransactions++;
        return;
      }

      const validationResult = await this.validateSmartMoneyTransaction(
        swapInfo.walletAddress,
        swapInfo.tokenAddress,
        swapInfo.amountUSD,
        swapInfo.swapType
      );

      if (!validationResult.isValid) {
        this.logger.warn(`🚫 BLOCKED Smart Money tx: ${swapInfo.tokenSymbol} - $${swapInfo.amountUSD} | ${validationResult.reason}`);
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

  // 🔥 ИСПРАВЛЕННАЯ ЛОГИКА СВАПОВ
  private async extractSwapInfo(txData: SolanaWebhookPayload, swapEvent: any, smartWallet: SmartMoneyWallet): Promise<SmartMoneySwap | null> {
    try {
      const swapEventData = swapEvent;
      if (!swapEventData || !swapEventData.tokenInputs || !swapEventData.tokenOutputs) {
        return null;
      }

      const tokenInput = swapEventData.tokenInputs[0];
      const tokenOutput = swapEventData.tokenOutputs[0];
      
      let targetToken = '';
      let paymentToken = '';
      let amountUSD = 0;
      let swapType: 'buy' | 'sell' = 'buy';
      let tokenAmount = 0;

      // 🚀 ПРАВИЛЬНАЯ ЛОГИКА: МАЖОРНЫЙ → НОВЫЙ ТОКЕН = ПОКУПКА
      if (this.MAJOR_TOKENS.has(tokenInput.mint) && !this.MAJOR_TOKENS.has(tokenOutput.mint)) {
        // ПОКУПКА: SOL/USDC/USDT → новый токен
        swapType = 'buy';
        targetToken = tokenOutput.mint; // Токен который покупают
        paymentToken = tokenInput.mint;  // Чем платят (SOL/USDC/USDT)
        
        // USD стоимость = сколько потратили в долларах
        amountUSD = parseFloat(tokenInput.rawTokenAmount.tokenAmount) / 
                    Math.pow(10, tokenInput.rawTokenAmount.decimals);
        
        // Количество купленного токена
        tokenAmount = parseFloat(tokenOutput.rawTokenAmount.tokenAmount) / 
                      Math.pow(10, tokenOutput.rawTokenAmount.decimals);
        
        // Для USDC/USDT уже в долларах, для SOL нужно умножить на цену
        if (tokenInput.mint === 'So11111111111111111111111111111111111111112') {
          amountUSD *= 140; // Примерная цена SOL
        }
        
        this.logger.info(`🚀 ПОКУПКА: ${this.formatNumber(amountUSD)} ${this.getTokenSymbol(paymentToken)} → ${targetToken.slice(0, 8)}...`);
        
      } else if (!this.MAJOR_TOKENS.has(tokenInput.mint) && this.MAJOR_TOKENS.has(tokenOutput.mint)) {
        // ПРОДАЖА: новый токен → SOL/USDC/USDT  
        swapType = 'sell';
        targetToken = tokenInput.mint;   // Токен который продают
        paymentToken = tokenOutput.mint; // Что получают (SOL/USDC/USDT)
        
        // Количество проданного токена
        tokenAmount = parseFloat(tokenInput.rawTokenAmount.tokenAmount) / 
                      Math.pow(10, tokenInput.rawTokenAmount.decimals);
        
        // USD стоимость = сколько получили в долларах
        amountUSD = parseFloat(tokenOutput.rawTokenAmount.tokenAmount) / 
                    Math.pow(10, tokenOutput.rawTokenAmount.decimals);
        
        if (tokenOutput.mint === 'So11111111111111111111111111111111111111112') {
          amountUSD *= 140; // Цена SOL
        }
        
        this.logger.info(`🔥 ПРОДАЖА: ${targetToken.slice(0, 8)}... → ${this.formatNumber(amountUSD)} ${this.getTokenSymbol(paymentToken)}`);
        
      } else {
        // 🚫 ИГНОРИРУЕМ: 
        // - МАЖОРНЫЙ → МАЖОРНЫЙ (USDC → SOL)
        // - ТОКЕН → ТОКЕН (без мажорных)
        this.logger.debug(`⏭️ Пропускаем своп между ${tokenInput.mint.slice(0, 8)} → ${tokenOutput.mint.slice(0, 8)}`);
        return null;
      }

      // Получаем информацию о токене
      const tokenInfo = await this.getTokenInfo(targetToken);
      
      return {
        transactionId: txData.signature,
        walletAddress: smartWallet.address,
        tokenAddress: targetToken,
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
        paymentToken: this.getTokenSymbol(paymentToken), // 🆕 ЧЕМ ЗАПЛАТИЛИ
        isCexListed: this.CEX_TOKENS.has(targetToken), // 📈 CEX LISTED
        isFamilyMember: false,
        familySize: 0
      };

    } catch (error) {
      this.logger.error('Error extracting swap info:', error);
      return null;
    }
  }

  // ✅ ФИЛЬТРЫ ПО КАТЕГОРИЯМ
  private shouldProcessSmartMoneySwap(swapInfo: SmartMoneySwap, smartWallet: SmartMoneyWallet): boolean {
    // 🔫 Sniper: $5K - $19,999
    if (smartWallet.category === 'sniper') {
      if (swapInfo.amountUSD < 5000 || swapInfo.amountUSD > 19999) {
        this.logger.debug(`🔫 Sniper filter: $${swapInfo.amountUSD} outside $5K-$19,999 range`);
        return false;
      }
    }
    
    // 💡 Hunter: $20K - $49,999  
    else if (smartWallet.category === 'hunter') {
      if (swapInfo.amountUSD < 20000 || swapInfo.amountUSD > 49999) {
        this.logger.debug(`💡 Hunter filter: $${swapInfo.amountUSD} outside $20K-$49,999 range`);
        return false;
      }
    }
    
    // 🐳 Trader: $50K+
    else if (smartWallet.category === 'trader') {
      if (swapInfo.amountUSD < 50000) {
        this.logger.debug(`🐳 Trader filter: $${swapInfo.amountUSD} below $50K threshold`);
        return false;
      }
    }

    // Проверяем активность кошелька
    const daysSinceActive = (Date.now() - smartWallet.lastActiveAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceActive > 45) {
      return false;
    }

    if (smartWallet.winRate < 60) {
      return false;
    }

    return true;
  }

  private getTokenSymbol(tokenMint: string): string {
    switch (tokenMint) {
      case 'So11111111111111111111111111111111111111112': return 'SOL';
      case 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': return 'USDC';
      case 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': return 'USDT';
      default: return 'TOKEN';
    }
  }

  private async validateSmartMoneyTransaction(
    walletAddress: string,
    tokenAddress: string,
    amountUSD: number,
    swapType: 'buy' | 'sell'
  ): Promise<SmartMoneyValidationResult> {
    
    const suspiciousFactors: string[] = [];
    let riskScore = 0;

    try {
      // Упрощенная валидация для экономии API
      if (amountUSD > 500000) {
        suspiciousFactors.push('Extremely large trade');
        riskScore += 15;
      }

      const isValid = riskScore < 70;
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
        isValid: true,
        riskScore: 0,
        suspiciousFactors: ['Validation error']
      };
    }
  }

  private async checkTokenNameAlerts(txData: SolanaWebhookPayload): Promise<void> {
    try {
      if (!txData.tokenTransfers || txData.tokenTransfers.length === 0) return;

      for (const transfer of txData.tokenTransfers) {
        const tokenInfo = await this.getTokenInfo(transfer.mint);
        
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
            holders: 0,
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

  private async saveSmartMoneyTransaction(swapInfo: SmartMoneySwap): Promise<void> {
    try {
      if (!this.smDatabase || !this.telegramNotifier) return;

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
        dex: 'QuickNode-Webhook'
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
      await this.telegramNotifier.sendSmartMoneySwapAlert(swapInfo);
      this.processingStats.alertsSent++;
    } catch (error) {
      this.logger.error('Error sending Smart Money notification:', error as Error);
    }
  }

  private async getTokenInfo(tokenAddress: string): Promise<{ symbol: string; name: string; decimals: number; isCexListed: boolean }> {
    const cached = this.tokenInfoCache.get(tokenAddress);
    if (cached && Date.now() - cached.timestamp < 3600000) {
      return { 
        symbol: cached.symbol, 
        name: cached.name, 
        decimals: cached.decimals,
        isCexListed: cached.isCexListed || false
      };
    }

    try {
      const metadata = await this.tokenMetadataService.getTokenMetadata(tokenAddress);
      
      let symbol = 'UNKNOWN';
      let name = 'Unknown Token';
      let decimals = 9;
      const isCexListed = this.CEX_TOKENS.has(tokenAddress);
      
      if (metadata) {
        symbol = metadata.symbol || symbol;
        name = metadata.name || name;
        decimals = metadata.decimals || decimals;
      } else {
        symbol = tokenAddress.slice(0, 6);
        name = `Token ${tokenAddress.slice(0, 8)}...`;
        decimals = 9;
      }
      
      const tokenInfo = {
        symbol,
        name,
        decimals,
        isCexListed,
        timestamp: Date.now()
      };
      
      this.tokenInfoCache.set(tokenAddress, tokenInfo);
      return { symbol: tokenInfo.symbol, name: tokenInfo.name, decimals: tokenInfo.decimals, isCexListed: tokenInfo.isCexListed };

    } catch (error) {
      this.logger.error(`Error getting token info for ${tokenAddress}:`, error);
      
      const fallbackSymbol = tokenAddress ? tokenAddress.slice(0, 6) : 'UNKNOWN';
      const fallbackName = tokenAddress ? `Token ${tokenAddress.slice(0, 8)}...` : 'Unknown Token';
      const fallbackDecimals = 9;
      const isCexListed = this.CEX_TOKENS.has(tokenAddress);
      
      this.tokenInfoCache.set(tokenAddress, {
        symbol: fallbackSymbol,
        name: fallbackName,
        decimals: fallbackDecimals,
        isCexListed,
        timestamp: Date.now()
      });

      return { symbol: fallbackSymbol, name: fallbackName, decimals: fallbackDecimals, isCexListed };
    }
  }

  private startCacheCleanup(): void {
    this.cacheCleanupInterval = setInterval(() => {
      const now = Date.now();
      const ONE_HOUR = 60 * 60 * 1000;
      
      for (const [key, value] of this.tokenInfoCache.entries()) {
        if (now - value.timestamp > ONE_HOUR) {
          this.tokenInfoCache.delete(key);
        }
      }
      
      for (const [key, value] of this.topHoldersCache.entries()) {
        if (now - value.timestamp > 30 * 60 * 1000) {
          this.topHoldersCache.delete(key);
        }
      }
      
      for (const [key, value] of this.relatedWalletsCache.entries()) {
        if (now - value.timestamp > 30 * 60 * 1000) {
          this.relatedWalletsCache.delete(key);
        }
      }
      
      for (const [key, value] of this.recentTxCache.entries()) {
        if (now - value.timestamp > 10 * 60 * 1000) {
          this.recentTxCache.delete(key);
        }
      }
      
    }, 5 * 60 * 1000);
  }

  private startPerformanceMonitoring(): void {
    this.performanceInterval = setInterval(() => {
      this.processingStats.lastProcessedTime = new Date();
      
      this.logger.info(`📊 Webhook Stats: Processed=${this.processingStats.totalTransactionsProcessed}, SM=${this.processingStats.smartMoneyTransactions}, Regular=${this.processingStats.regularTransactions}, Filtered=${this.processingStats.filteredTransactions}, Errors=${this.processingStats.errorCount}`);
      
    }, 5 * 60 * 1000);
  }

  private formatNumber(num: number): string {
    if (num >= 1_000_000) {
      return `${(num / 1_000_000).toFixed(1)}M`;
    } else if (num >= 1_000) {
      return `${(num / 1_000).toFixed(1)}K`;
    }
    return num.toFixed(0);
  }

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
          this.logger.info(`🚀 Webhook server started on port ${this.port} with CORRECT swap logic`);
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