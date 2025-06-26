// src/services/WebhookServer.ts - 🔥 ИСПРАВЛЕНО: PAYMENT_ASSETS логика для LST токенов
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

interface ProcessingStats {
  totalTransactionsProcessed: number;
  smartMoneyTransactions: number;
  regularTransactions: number;
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

  private readonly PRICE_CACHE_TTL = 5 * 60 * 1000; // 5 минут

  // 🔥 ИСПРАВЛЕНО: Отдельный PAYMENT_ASSETS с LST токенами
  private readonly PAYMENT_ASSETS = new Set([
    // Базовые стейблы и SOL
    'So11111111111111111111111111111111111111112', // SOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    
    // LST токены (Liquid Staking Tokens)
    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL (Marinade)
    'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // JitoSOL (Jito)
    '7Q2afV64in6N6SeZsAAB81TJzwDoD6zpqmHkzi9Dcavn', // stSOL (Lido)
    'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', // bSOL (Blaze)
    'he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A', // hSOL (Helius)
    
    // Популярные ликвидные токены
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
    'WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk', // WEN
    'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', // JUP (Jupiter)
    
    // Дополнительные стейблкоины
    'A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM', // UXD
    'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX' // USDH
  ]);

  // 🔥 ОСТАВЛЯЕМ MAJOR_TOKENS для совместимости в других местах
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
    'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' // JUP
  ]);

  private processingStats: ProcessingStats = {
    totalTransactionsProcessed: 0,
    smartMoneyTransactions: 0,
    regularTransactions: 0,
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
    this.logger.info('🚀 WebhookServer FIXED: PAYMENT_ASSETS with LST support');
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
          tokenInfoCache: this.tokenInfoCache.size
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
      // Фильтр времени - только свежие транзакции
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

  private isTransactionRecentAndValid(txData: SolanaWebhookPayload): boolean {
    if (!txData || !txData.timestamp) return false;
    
    const transactionTime = txData.timestamp * 1000;
    const now = Date.now();
    const timeSinceTransaction = now - transactionTime;
    
    const MAX_AGE = 2 * 60 * 1000; // 2 минуты
    
    if (timeSinceTransaction > MAX_AGE) {
      this.logger.debug(`🚫 Transaction too old: ${Math.floor(timeSinceTransaction / (60 * 1000))} minutes`);
      return false;
    }
    
    return true;
  }

  private async processWebhookTransaction(txData: SolanaWebhookPayload): Promise<void> {
    try {
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

      // 🔥 ИСПРАВЛЕНО: Используем PAYMENT_ASSETS в extractSwapInfo
      const swapInfo = await this.extractSwapInfo(txData, swapEvent, smartWallet);
      if (!swapInfo) return;

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

  // 🔥 ИСПРАВЛЕНО: Используем PAYMENT_ASSETS вместо MAJOR_TOKENS
  private async extractSwapInfo(txData: SolanaWebhookPayload, swapEvent: any, smartWallet: SmartMoneyWallet): Promise<SmartMoneySwap | null> {
    try {
      if (!swapEvent || !swapEvent.tokenInputs || !swapEvent.tokenOutputs || 
          swapEvent.tokenInputs.length === 0 || swapEvent.tokenOutputs.length === 0) {
        this.logger.debug(`[extractSwapInfo] Invalid swapEvent structure for TX ${txData.signature}`);
        return null;
      }

      const tokenInputData = swapEvent.tokenInputs[0];
      const tokenOutputData = swapEvent.tokenOutputs[0];

      if (!tokenInputData.mint || !tokenOutputData.mint || 
          !tokenInputData.rawTokenAmount || !tokenOutputData.rawTokenAmount) {
        this.logger.debug(`[extractSwapInfo] Missing mint or rawTokenAmount in swapEvent for TX ${txData.signature}`);
        return null;
      }
      
      const inputMint = tokenInputData.mint;
      const outputMint = tokenOutputData.mint;

      if (inputMint === outputMint) {
        this.logger.debug(`[extractSwapInfo] Ignoring same-token swap: ${inputMint} -> ${outputMint} for TX ${txData.signature}`);
        this.processingStats.ignoredSameTokenSwaps++;
        return null;
      }

      let targetToken = '';
      let paymentToken = '';
      let amountUSD = 0;
      let swapType: 'buy' | 'sell' = 'buy';
      let tokenAmount = 0;
      let tokenPrice = 0;

      // 🔥 ИСПРАВЛЕНО: ПОКУПКА PAYMENT_ASSET → НЕ-PAYMENT_ASSET
      if (this.PAYMENT_ASSETS.has(inputMint) && !this.PAYMENT_ASSETS.has(outputMint)) {
        swapType = 'buy';
        targetToken = outputMint;
        paymentToken = inputMint;
        
        // 🔥 ИСПРАВЛЕНО: Правильные decimals через TokenMetadataService
        const [paymentMetadata, targetMetadata] = await Promise.all([
          this.tokenMetadataService.getTokenMetadata(paymentToken),
          this.tokenMetadataService.getTokenMetadata(targetToken)
        ]);
        
        const inputDecimals = tokenInputData.rawTokenAmount.decimals !== undefined ? 
          tokenInputData.rawTokenAmount.decimals : (paymentMetadata?.decimals || this.getDefaultDecimals(paymentToken));
        const outputDecimals = tokenOutputData.rawTokenAmount.decimals !== undefined ? 
          tokenOutputData.rawTokenAmount.decimals : (targetMetadata?.decimals || this.getDefaultDecimals(targetToken));
        
        const inputRawAmount = parseFloat(tokenInputData.rawTokenAmount.tokenAmount || '0');
        const outputRawAmount = parseFloat(tokenOutputData.rawTokenAmount.tokenAmount || '0');

        const actualInputAmount = inputRawAmount / Math.pow(10, inputDecimals);
        tokenAmount = outputRawAmount / Math.pow(10, outputDecimals);
        
        // 🔥 ИСПРАВЛЕНО: Правильная цена через TokenMetadataService
        const paymentTokenPrice = await this.tokenMetadataService.getTokenPrice(paymentToken);
        amountUSD = actualInputAmount * (paymentTokenPrice || this.getFallbackPrice(paymentToken));
        
        if (tokenAmount > 0 && amountUSD > 0) {
          tokenPrice = amountUSD / tokenAmount;
        }
        
        this.processingStats.usdCalculationStats.correctCalculations++;
        
      } else if (!this.PAYMENT_ASSETS.has(inputMint) && this.PAYMENT_ASSETS.has(outputMint)) {
        // 🔥 ИСПРАВЛЕНО: ПРОДАЖА НЕ-PAYMENT_ASSET → PAYMENT_ASSET
        swapType = 'sell';
        targetToken = inputMint;
        paymentToken = outputMint;

        const [targetMetadata, paymentMetadata] = await Promise.all([
          this.tokenMetadataService.getTokenMetadata(targetToken),
          this.tokenMetadataService.getTokenMetadata(paymentToken)
        ]);
        
        const inputDecimals = tokenInputData.rawTokenAmount.decimals !== undefined ? 
          tokenInputData.rawTokenAmount.decimals : (targetMetadata?.decimals || this.getDefaultDecimals(targetToken));
        const outputDecimals = tokenOutputData.rawTokenAmount.decimals !== undefined ? 
          tokenOutputData.rawTokenAmount.decimals : (paymentMetadata?.decimals || this.getDefaultDecimals(paymentToken));
        
        const inputRawAmount = parseFloat(tokenInputData.rawTokenAmount.tokenAmount || '0');
        const outputRawAmount = parseFloat(tokenOutputData.rawTokenAmount.tokenAmount || '0');

        tokenAmount = inputRawAmount / Math.pow(10, inputDecimals);
        const actualOutputAmount = outputRawAmount / Math.pow(10, outputDecimals);
        
        const paymentTokenPrice = await this.tokenMetadataService.getTokenPrice(paymentToken);
        amountUSD = actualOutputAmount * (paymentTokenPrice || this.getFallbackPrice(paymentToken));
        
        if (tokenAmount > 0 && amountUSD > 0) {
          tokenPrice = amountUSD / tokenAmount;
        }
        
        this.processingStats.usdCalculationStats.correctCalculations++;
          
      } else {
        // 🚫 ИГНОРИРУЕМ PAYMENT_ASSET → PAYMENT_ASSET и НЕ-PAYMENT_ASSET → НЕ-PAYMENT_ASSET
        this.processingStats.ignoredMajorSwaps++;
        this.logger.debug(`[extractSwapInfo] ⏭️ Ignoring swap: ${inputMint.slice(0,6)} → ${outputMint.slice(0,6)} for TX ${txData.signature} (Not payment-to-alt or alt-to-payment)`);
        return null;
      }

      const minAmountCategory = smartWallet.category === 'sniper' ? 5000 : 
                               smartWallet.category === 'hunter' ? 20000 : 50000;                       
      if (amountUSD < minAmountCategory) {
        this.logger.debug(`[extractSwapInfo] 💸 Amount $${amountUSD.toFixed(2)} below category threshold $${minAmountCategory} for ${smartWallet.category}`);
        return null;
      }

      const tokenInfo = await this.getTokenInfo(targetToken);
      
      return {
        transactionId: txData.signature,
        walletAddress: smartWallet.address,
        tokenAddress: targetToken,
        tokenSymbol: tokenInfo.symbol,
        tokenName: tokenInfo.name,
        tokenAmount,
        tokenPrice,
        amountUSD,
        swapType,
        timestamp: new Date(txData.timestamp * 1000),
        category: smartWallet.category,
        winRate: smartWallet.winRate,
        pnl: smartWallet.totalPnL,
        totalTrades: smartWallet.totalTrades,
        paymentToken: await this.getTokenSymbolWithFallback(paymentToken),
        isCexListed: this.CEX_TOKENS.has(targetToken),
        isFamilyMember: false,
        familySize: 0
      };

    } catch (error) {
      this.logger.error(`[extractSwapInfo] Error for TX ${txData.signature}:`, error);
      this.processingStats.usdCalculationStats.errorCalculations++;
      return null;
    }
  }

  private getDefaultDecimals(tokenMint: string): number {
    if (tokenMint === 'So11111111111111111111111111111111111111112') return 9; // SOL
    if (tokenMint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') return 6; // USDC
    if (tokenMint === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') return 6; // USDT
    if (tokenMint === 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So') return 9; // mSOL
    if (tokenMint === 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn') return 9; // JitoSOL
    if (tokenMint === '7Q2afV64in6N6SeZsAAB81TJzwDoD6zpqmHkzi9Dcavn') return 9; // stSOL
    return 9;
  }

  private getFallbackPrice(tokenMint: string): number {
    // Стейблкоины
    if (tokenMint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') return 1.0; // USDC
    if (tokenMint === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') return 1.0; // USDT
    if (tokenMint === 'A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM') return 1.0; // UXD
    if (tokenMint === 'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX') return 1.0; // USDH
    
    // SOL и LST токены
    if (tokenMint === 'So11111111111111111111111111111111111111112') return 140.8; // SOL
    if (tokenMint === 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So') return 140.0; // mSOL
    if (tokenMint === 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn') return 140.0; // JitoSOL
    if (tokenMint === '7Q2afV64in6N6SeZsAAB81TJzwDoD6zpqmHkzi9Dcavn') return 140.0; // stSOL
    if (tokenMint === 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1') return 140.0; // bSOL
    if (tokenMint === 'he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A') return 140.0; // hSOL
    
    // Популярные токены (примерные цены)
    if (tokenMint === 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263') return 0.00002; // BONK
    if (tokenMint === 'WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk') return 0.0001; // WEN
    if (tokenMint === 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN') return 0.8; // JUP
    
    return 1.0; // Общий фоллбэк
  }

  private async getTokenSymbolWithFallback(mint: string): Promise<string> {
    if (this.PAYMENT_ASSETS.has(mint)) {
      return this.getTokenSymbol(mint);
    }
    const info = await this.getTokenInfo(mint);
    return info.symbol;
  }

  private shouldProcessSmartMoneySwap(swapInfo: SmartMoneySwap, smartWallet: SmartMoneyWallet): boolean {
    if (smartWallet.category === 'sniper') {
      if (swapInfo.amountUSD < 2500 || swapInfo.amountUSD > 19999) {
        return false;
      }
    } else if (smartWallet.category === 'hunter') {
      if (swapInfo.amountUSD < 20000 || swapInfo.amountUSD > 49999) {
        return false;
      }
    } else if (smartWallet.category === 'trader') {
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
      case 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': return 'mSOL';
      case 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn': return 'JitoSOL';
      case '7Q2afV64in6N6SeZsAAB81TJzwDoD6zpqmHkzi9Dcavn': return 'stSOL';
      case 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1': return 'bSOL';
      case 'he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A': return 'hSOL';
      case 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': return 'BONK';
      case 'WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk': return 'WEN';
      case 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': return 'JUP';
      default: return 'TOKEN';
    }
  }

  private async validateSmartMoneyTransaction(
    walletAddress: string,
    tokenAddress: string,
    amountUSD: number,
    swapType: 'buy' | 'sell'
  ): Promise<{ isValid: boolean; reason?: string; riskScore: number; suspiciousFactors: string[] }> {
    
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
    setInterval(() => {
      const now = Date.now();
      const ONE_HOUR = 60 * 60 * 1000;
      
      for (const [key, value] of this.tokenInfoCache.entries()) {
        if (now - value.timestamp > ONE_HOUR) {
          this.tokenInfoCache.delete(key);
        }
      }
      
    }, 5 * 60 * 1000);
  }

  getProcessingStats(): ProcessingStats {
    return { ...this.processingStats };
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(this.port, () => {
          this.logger.info(`🚀 Webhook server started on port ${this.port} with PAYMENT_ASSETS logic`);
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