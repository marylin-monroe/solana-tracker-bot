// src/services/WebhookServer.ts - 🔥 ИСПРАВЛЕНА ЛОГИКА СВАПОВ для идеального заработка
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

interface TokenNameAlert {
  tokenName: string;
  contractAddress: string;
  holders: number;
  similarTokens: number;
}

interface SmartMoneyValidationResult {
  isValid: boolean;
  reason?: string;
  riskScore: number;
  suspiciousFactors: string[];
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
  profitableSwaps: number;
  ignoredMajorSwaps: number;
  ignoredSameTokenSwaps: number;
  oldTransactionsFiltered: number;
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

  private tokenPriceCache = new Map<string, { 
    price: number; 
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
  private readonly PRICE_CACHE_TTL = 5 * 60 * 1000; // 5 минут

  // 🔥 МАЖОРНЫЕ ТОКЕНЫ - ТО ЧЕМ ПЛАТЯТ ЗА НОВЫЕ ТОКЕНЫ
  private readonly MAJOR_TOKENS = new Set([
    'So11111111111111111111111111111111111111112', // SOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'  // USDT
  ]);

  // 📈 ПОПУЛЯРНЫЕ CEX ТОКЕНЫ
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
    },
    profitableSwaps: 0,
    ignoredMajorSwaps: 0,
    ignoredSameTokenSwaps: 0,
    oldTransactionsFiltered: 0
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
          tokenPriceCache: this.tokenPriceCache.size,
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
      // 🔥 ФИЛЬТР ВРЕМЕНИ - ТОЛЬКО СВЕЖИЕ ТРАНЗАКЦИИ
      if (!this.isTransactionRecentAndValid(txData)) {
        this.processingStats.oldTransactionsFiltered++;
        return;
      }

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

  // 🔥 ФИЛЬТР ВРЕМЕНИ - ТОЛЬКО СВЕЖИЕ ТРАНЗАКЦИИ (2 МИНУТЫ)
  private isTransactionRecentAndValid(txData: SolanaWebhookPayload): boolean {
    if (!txData || !txData.timestamp) return false;
    
    const transactionTime = txData.timestamp * 1000;
    const now = Date.now();
    const timeSinceTransaction = now - transactionTime;
    
    // 🔥 ТОЛЬКО ТРАНЗАКЦИИ ЗА ПОСЛЕДНИЕ 2 МИНУТЫ
    const MAX_AGE = 2 * 60 * 1000;
    
    if (timeSinceTransaction > MAX_AGE) {
      this.logger.debug(`🚫 Transaction too old: ${Math.floor(timeSinceTransaction / (60 * 1000))} minutes`);
      return false;
    }
    
    return true;
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

      // 🔥 ИСПРАВЛЕННАЯ ЛОГИКА СВАПОВ ДЛЯ ЗАРАБОТКА
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
      this.processingStats.profitableSwaps++;

      this.logger.info(`✅ PROFITABLE SWAP: ${swapInfo.tokenSymbol} - $${swapInfo.amountUSD.toFixed(0)} (${Date.now() - startTime}ms)`);

    } catch (error) {
      this.logger.error('❌ Error processing swap event:', error as Error);
      this.processingStats.errorCount++;
    }
  }

  // 💰 ПОЛУЧЕНИЕ АКТУАЛЬНОЙ ЦЕНЫ ТОКЕНА
  private async getTokenPrice(tokenMint: string): Promise<number> {
    const cached = this.tokenPriceCache.get(tokenMint);
    if (cached && Date.now() - cached.timestamp < this.PRICE_CACHE_TTL) {
      return cached.price;
    }

    try {
      let price = 1.0;
      
      if (tokenMint === 'So11111111111111111111111111111111111111112') {
        const solPrice = await this.tokenMetadataService.getTokenPrice(tokenMint);
        price = solPrice || 140.8;
        
        if (!solPrice) {
          this.processingStats.usdCalculationStats.fallbackCalculations++;
        } else {
          this.processingStats.usdCalculationStats.correctCalculations++;
        }
      } else {
        price = 1.0; // USDC/USDT
        this.processingStats.usdCalculationStats.correctCalculations++;
      }

      this.tokenPriceCache.set(tokenMint, { price, timestamp: Date.now() });
      return price;
    } catch (error) {
      this.logger.error(`❌ Error getting price for ${tokenMint}:`, error);
      this.processingStats.usdCalculationStats.errorCalculations++;
      return tokenMint === 'So11111111111111111111111111111111111111112' ? 140.8 : 1.0;
    }
  }

  // 🔢 ПОЛУЧЕНИЕ DECIMALS ТОКЕНА
  private async getTokenDecimals(tokenMint: string, fallback: number = 9): Promise<number> {
    try {
      // Известные мажорные токены
      if (tokenMint === 'So11111111111111111111111111111111111111112') return 9; // SOL
      if (tokenMint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') return 6; // USDC
      if (tokenMint === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') return 6; // USDT
      
      // Пытаемся получить из метаданных
      const metadata = await this.tokenMetadataService.getTokenMetadata(tokenMint);
      return metadata?.decimals || fallback;
    } catch (error) {
      this.logger.debug(`⚠️ Could not get decimals for ${tokenMint}, using fallback ${fallback}`);
      return fallback;
    }
  }

  // 🔥 ИСПРАВЛЕННАЯ ЛОГИКА СВАПОВ - ТОЛЬКО ДЛЯ ЗАРАБОТКА
  private async extractSwapInfo(txData: SolanaWebhookPayload, swapEvent: any, smartWallet: SmartMoneyWallet): Promise<SmartMoneySwap | null> {
    try {
      if (!swapEvent || !swapEvent.tokenInputs || !swapEvent.tokenOutputs || 
          swapEvent.tokenInputs.length === 0 || swapEvent.tokenOutputs.length === 0) {
        this.logger.debug(`[extractSwapInfo] Invalid swapEvent structure for TX ${txData.signature}`);
        return null;
      }

      const tokenInputData = swapEvent.tokenInputs[0];
      const tokenOutputData = swapEvent.tokenOutputs[0];

      // Проверяем наличие необходимых полей
      if (!tokenInputData.mint || !tokenOutputData.mint || 
          !tokenInputData.rawTokenAmount || !tokenOutputData.rawTokenAmount) {
        this.logger.debug(`[extractSwapInfo] Missing mint or rawTokenAmount in swapEvent for TX ${txData.signature}`);
        return null;
      }
      
      const inputMint = tokenInputData.mint;
      const outputMint = tokenOutputData.mint;

      // 🔥 ГЛАВНОЕ ИСПРАВЛЕНИЕ: Игнорируем свап одного и того же токена
      if (inputMint === outputMint) {
        this.logger.debug(`[extractSwapInfo] Ignoring same-token swap: ${inputMint} -> ${outputMint} for TX ${txData.signature}`);
        this.processingStats.ignoredSameTokenSwaps++;
        return null;
      }

      let targetToken = '';
      let paymentToken = '';
      let amountUSD = 0;
      let swapType: 'buy' | 'sell' = 'buy';
      let tokenAmount = 0; // Количество купленного/проданного ЦЕЛЕВОГО токена
      let tokenPrice = 0;  // Цена ЦЕЛЕВОГО токена

      // 🚀 ПОКУПКА: МАЖОРНЫЙ → НЕ-МАЖОРНЫЙ (ЭТО НАМ НУЖНО!)
      if (this.MAJOR_TOKENS.has(inputMint) && !this.MAJOR_TOKENS.has(outputMint)) {
        swapType = 'buy';
        targetToken = outputMint; // Токен который покупают (не-мажорный)
        paymentToken = inputMint;  // Чем платят (мажорный)
        
        // Decimals для корректного расчета
        const inputDecimals = tokenInputData.rawTokenAmount.decimals !== undefined ? 
          tokenInputData.rawTokenAmount.decimals : await this.getTokenDecimals(paymentToken, 6); // Фоллбэк для USDC/USDT
        const outputDecimals = tokenOutputData.rawTokenAmount.decimals !== undefined ? 
          tokenOutputData.rawTokenAmount.decimals : await this.getTokenDecimals(targetToken, 9); // Фоллбэк для новых токенов
        
        const inputRawAmount = parseFloat(tokenInputData.rawTokenAmount.tokenAmount || '0');
        const outputRawAmount = parseFloat(tokenOutputData.rawTokenAmount.tokenAmount || '0');

        const actualInputAmount = inputRawAmount / Math.pow(10, inputDecimals); // Количество потраченного мажорного токена
        tokenAmount = outputRawAmount / Math.pow(10, outputDecimals);          // Количество полученного целевого токена
        
        const paymentTokenPrice = await this.getTokenPrice(paymentToken); // Цена мажорного токена (для SOL)
        amountUSD = actualInputAmount * paymentTokenPrice;                 // Общая USD стоимость сделки
        
        if (tokenAmount > 0 && amountUSD > 0) {
          tokenPrice = amountUSD / tokenAmount; // Цена за единицу целевого токена
        }
        
        const paymentSymbol = await this.getTokenSymbolWithFallback(paymentToken);
        const targetSymbol = await this.getTokenSymbolWithFallback(targetToken);
        this.logger.info(`🚀 BUY: ${this.formatNumber(amountUSD)} ${paymentSymbol} → ${tokenAmount.toFixed(4)} #${targetSymbol} @ $${tokenPrice.toFixed(6)}`);
        
      } else if (!this.MAJOR_TOKENS.has(inputMint) && this.MAJOR_TOKENS.has(outputMint)) {
        // 🔥 ПРОДАЖА: НЕ-МАЖОРНЫЙ → МАЖОРНЫЙ
        swapType = 'sell';
        targetToken = inputMint;   // Токен который продают (не-мажорный)
        paymentToken = outputMint; // Что получают (мажорный)

        const inputDecimals = tokenInputData.rawTokenAmount.decimals !== undefined ? 
          tokenInputData.rawTokenAmount.decimals : await this.getTokenDecimals(targetToken, 9);
        const outputDecimals = tokenOutputData.rawTokenAmount.decimals !== undefined ? 
          tokenOutputData.rawTokenAmount.decimals : await this.getTokenDecimals(paymentToken, 6);
        
        const inputRawAmount = parseFloat(tokenInputData.rawTokenAmount.tokenAmount || '0');
        const outputRawAmount = parseFloat(tokenOutputData.rawTokenAmount.tokenAmount || '0');

        tokenAmount = inputRawAmount / Math.pow(10, inputDecimals);          // Количество проданного целевого токена
        const actualOutputAmount = outputRawAmount / Math.pow(10, outputDecimals); // Количество полученного мажорного токена
        
        const paymentTokenPrice = await this.getTokenPrice(paymentToken); // Цена мажорного токена (для SOL)
        amountUSD = actualOutputAmount * paymentTokenPrice;                 // Общая USD стоимость сделки (сколько получили)
        
        if (tokenAmount > 0 && amountUSD > 0) {
          tokenPrice = amountUSD / tokenAmount; // Цена за единицу целевого токена
        }
        
        const targetSymbol = await this.getTokenSymbolWithFallback(targetToken);
        const paymentSymbol = await this.getTokenSymbolWithFallback(paymentToken);
        this.logger.info(`🔥 SELL: ${tokenAmount.toFixed(4)} #${targetSymbol} @ $${tokenPrice.toFixed(6)} → ${this.formatNumber(amountUSD)} ${paymentSymbol}`);
          
      } else {
        // 🚫 ИГНОРИРУЕМ МАЖОРНЫЙ → МАЖОРНЫЙ и НЕ-МАЖОРНЫЙ -> НЕ-МАЖОРНЫЙ
        this.processingStats.ignoredMajorSwaps++;
        const inputSymbol = await this.getTokenSymbolWithFallback(inputMint);
        const outputSymbol = await this.getTokenSymbolWithFallback(outputMint);
        this.logger.debug(`[extractSwapInfo] ⏭️ Ignoring swap: ${inputSymbol} (${inputMint.slice(0,6)}) → ${outputSymbol} (${outputMint.slice(0,6)}) for TX ${txData.signature} (Not a major-to-alt or alt-to-major)`);
        return null;
      }

      // Пороги по категориям (согласованы с shouldProcessSmartMoneySwap)
      // Этот фильтр можно оставить здесь ИЛИ полностью полагаться на shouldProcessSmartMoneySwap
      const minAmountCategory = smartWallet.category === 'sniper' ? 5000 : 
                               smartWallet.category === 'hunter' ? 20000 : 50000;                       
      if (amountUSD < minAmountCategory) {
        this.logger.debug(`[extractSwapInfo] 💸 Amount $${amountUSD.toFixed(2)} below category threshold $${minAmountCategory} for ${smartWallet.category}`);
        return null;
      }

      const tokenInfo = await this.getTokenInfo(targetToken); // Информация о ЦЕЛЕВОМ токене
      
      return {
        transactionId: txData.signature,
        walletAddress: smartWallet.address,
        tokenAddress: targetToken,
        tokenSymbol: tokenInfo.symbol, // Символ целевого токена
        tokenName: tokenInfo.name,     // Имя целевого токена
        tokenAmount,                   // Количество целевого токена
        tokenPrice,                    // Цена целевого токена
        amountUSD,                     // Общая USD стоимость операции
        swapType,
        timestamp: new Date(txData.timestamp * 1000),
        category: smartWallet.category,
        winRate: smartWallet.winRate,
        pnl: smartWallet.totalPnL,
        totalTrades: smartWallet.totalTrades,
        paymentToken: await this.getTokenSymbolWithFallback(paymentToken), // Символ платежного токена
        isCexListed: this.CEX_TOKENS.has(targetToken),
        isFamilyMember: false, // Отключено
        familySize: 0        // Отключено
      };

    } catch (error) {
      this.logger.error(`[extractSwapInfo] Error for TX ${txData.signature}:`, error);
      this.processingStats.usdCalculationStats.errorCalculations++;
      return null;
    }
  }

  // 🔤 Вспомогательный метод для получения символа с фоллбэком (чтобы не дублировать логику)
  private async getTokenSymbolWithFallback(mint: string): Promise<string> {
    if (this.MAJOR_TOKENS.has(mint)) {
      return this.getTokenSymbol(mint); // ваш существующий синхронный метод
    }
    const info = await this.getTokenInfo(mint); // асинхронный для остальных
    return info.symbol;
  }

  // ✅ ФИЛЬТРЫ ПО КАТЕГОРИЯМ
  private shouldProcessSmartMoneySwap(swapInfo: SmartMoneySwap, smartWallet: SmartMoneyWallet): boolean {
    // 🔫 Sniper: $2,5K - $19,999
    if (smartWallet.category === 'sniper') {
      if (swapInfo.amountUSD < 2500 || swapInfo.amountUSD > 19999) {
        return false;
      }
    }
    
    // 💡 Hunter: $20K - $49,999  
    else if (smartWallet.category === 'hunter') {
      if (swapInfo.amountUSD < 20000 || swapInfo.amountUSD > 49999) {
        return false;
      }
    }
    
    // 🐳 Trader: $50K+
    else if (smartWallet.category === 'trader') {
      if (swapInfo.amountUSD < 50000) {
        return false;
      }
    }

    const daysSinceActive = (Date.now() - smartWallet.lastActiveAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceActive > 30) {
      return false;
    }

    if (smartWallet.winRate < 60) {
      return false;
    }

    if (smartWallet.totalPnL < 100000) {
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
        price: swapInfo.tokenPrice || (swapInfo.amountUSD / swapInfo.tokenAmount),
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
        symbol = tokenAddress.slice(0, 6).toUpperCase();
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
      
      const fallbackSymbol = tokenAddress ? tokenAddress.slice(0, 6).toUpperCase() : 'UNKNOWN';
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
      
      for (const [key, value] of this.tokenPriceCache.entries()) {
        if (now - value.timestamp > this.PRICE_CACHE_TTL) {
          this.tokenPriceCache.delete(key);
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
      
      this.logger.info(`📊 PROFIT Stats: Total=${this.processingStats.totalTransactionsProcessed}, PROFITABLE=${this.processingStats.profitableSwaps}, IGNORED=${this.processingStats.ignoredMajorSwaps}, SAME_TOKEN=${this.processingStats.ignoredSameTokenSwaps}, Errors=${this.processingStats.errorCount}`);
      
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
    tokenPriceCache: number;
    topHoldersCache: number;
    relatedWalletsCache: number;
    recentTxCache: number;
  } {
    return {
      tokenInfoCache: this.tokenInfoCache.size,
      tokenPriceCache: this.tokenPriceCache.size,
      topHoldersCache: this.topHoldersCache.size,
      relatedWalletsCache: this.relatedWalletsCache.size,
      recentTxCache: this.recentTxCache.size
    };
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(this.port, () => {
          this.logger.info(`🚀 Webhook server started on port ${this.port} with PROFIT-FIRST logic`);
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