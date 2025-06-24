// src/services/WebhookServer.ts - ЭТАП 2: API заглушки для экономии + оптимизация
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

        if (txData.events?.swap && txData.events.swap.length > 0) {
          const swapInfo = await this.extractBasicSwapInfo(txData, swapEvent);
          if (swapInfo && swapInfo.amountUSD >= 5000 && this.solanaMonitor) {
            const aggregationCheck = await this.solanaMonitor.checkForPositionAggregation(
              walletAddress,
              swapInfo.tokenAddress,
              swapInfo.amountUSD
            );
            
            if (aggregationCheck.isPartOfAggregation) {
              this.processingStats.positionAggregations++;
              
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

      const swapInfo = await this.extractSwapInfo(txData, swapEvent, smartWallet);
      if (!swapInfo) return;

      const validationResult = await this.validateSmartMoneyTransaction(
        swapInfo.walletAddress,
        swapInfo.tokenAddress,
        swapInfo.amountUSD,
        swapInfo.swapType
      );

      if (!validationResult.isValid) {
        this.logger.warn(`🚫 BLOCKED Smart Money tx: ${swapInfo.tokenSymbol} - $${swapInfo.amountUSD} | ${validationResult.reason}`);
        this.processingStats.filteredTransactions++;
        
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

  private async extractBasicSwapInfo(txData: SolanaWebhookPayload, swapEvent: any): Promise<{
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
      this.processingStats.usdCalculationStats.errorCalculations++;
      return null;
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
      const creatorCheck = await this.checkTokenCreator(walletAddress, tokenAddress);
      if (creatorCheck.isCreator) {
        suspiciousFactors.push('Token creator');
        riskScore += 40;
      }

      if (creatorCheck.isTopHolder && creatorCheck.holdingPercentage > 10) {
        suspiciousFactors.push(`Top holder (${creatorCheck.holdingPercentage.toFixed(1)}%)`);
        riskScore += 25;
      }

      if (creatorCheck.tokenAge < 24) {
        suspiciousFactors.push(`New token (${creatorCheck.tokenAge.toFixed(1)}h)`);
        riskScore += 20;
      }

      const recentTxCheck = await this.checkRecentTokenActivity(tokenAddress, walletAddress);
      if (recentTxCheck.suspiciousPatterns) {
        suspiciousFactors.push('Coordinated buying pattern');
        riskScore += 30;
      }

      if (amountUSD > 500000) {
        suspiciousFactors.push('Extremely large trade');
        riskScore += 15;
      }

      const relatedWallets = await this.getRelatedWallets(walletAddress);
      if (relatedWallets.length > 5) {
        suspiciousFactors.push(`Related wallets (${relatedWallets.length})`);
        riskScore += 20;
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

  // 🔥 ЭТАП 2: ЗАГЛУШКА ДЛЯ ЭКОНОМИИ API
  private async checkTokenCreator(walletAddress: string, tokenAddress: string): Promise<TokenCreatorCheck> {
    this.logger.debug('🔥 checkTokenCreator temporarily disabled for API economy');
    return {
      isCreator: false,
      isTopHolder: false,
      holdingPercentage: 0,
      creationTime: new Date(),
      firstTxTime: new Date(),
      tokenAge: 100
    };
  }

  private async checkRecentTokenActivity(tokenAddress: string, walletAddress: string): Promise<{
    suspiciousPatterns: boolean;
    recentBuyers: number;
    averageHoldTime: number;
  }> {
    try {
      const cached = this.recentTxCache.get(tokenAddress);
      if (cached && Date.now() - cached.timestamp < 10 * 60 * 1000) {
        const uniqueBuyers = new Set(cached.transactions.map(tx => tx.walletAddress)).size;
        const suspiciousPatterns = uniqueBuyers > 10 && cached.transactions.length > 20;
        
        return {
          suspiciousPatterns,
          recentBuyers: uniqueBuyers,
          averageHoldTime: 0
        };
      }

      const recentTransactions = await this.getRecentTokenTransactions(tokenAddress);
      
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

  // 🔥 ЭТАП 2: ЗАГЛУШКА ДЛЯ ЭКОНОМИИ API
  private async getRelatedWallets(walletAddress: string): Promise<string[]> {
    this.logger.debug('🔥 getRelatedWallets temporarily disabled for API economy');
    const cached = this.relatedWalletsCache.get(walletAddress);
    if (cached && Date.now() - cached.timestamp < 30 * 60 * 1000) {
      return cached.relatedWallets;
    }

    const relatedWallets: string[] = [];
    
    this.relatedWalletsCache.set(walletAddress, {
      relatedWallets,
      timestamp: Date.now()
    });

    return relatedWallets;
  }

  // 🔥 ЭТАП 2: ЗАГЛУШКА ДЛЯ ЭКОНОМИИ API
  private async getRecentTokenTransactions(tokenAddress: string): Promise<Array<{
    walletAddress: string;
    timestamp: Date;
    amountUSD: number;
    swapType: 'buy' | 'sell';
  }>> {
    this.logger.debug('🔥 getRecentTokenTransactions temporarily disabled for API economy');
    return [];
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

  private async extractSwapInfo(txData: SolanaWebhookPayload, swapEvent: any, smartWallet: SmartMoneyWallet): Promise<SmartMoneySwap | null> {
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
          
          this.logger.debug(`🔍 BUY Swap | Token: ${tokenAddress.slice(0, 8)}... | RAW OUT: ${tokenOutput.rawTokenAmount.tokenAmount} | DECIMALS OUT: ${tokenOutput.rawTokenAmount.decimals} | ACTUAL TOKEN: ${tokenAmount.toLocaleString()} | RAW IN: ${tokenInput.rawTokenAmount.tokenAmount} | DECIMALS IN: ${tokenInput.rawTokenAmount.decimals} | USD: $${amountUSD.toLocaleString()}`);
          
        } else if (mainTokens.includes(tokenOutput.mint)) {
          swapType = 'sell';
          tokenAddress = tokenInput.mint;
          tokenAmount = parseFloat(tokenInput.rawTokenAmount.tokenAmount) / Math.pow(10, tokenInput.rawTokenAmount.decimals);
          amountUSD = parseFloat(tokenOutput.rawTokenAmount.tokenAmount) / Math.pow(10, tokenOutput.rawTokenAmount.decimals);
          
          this.logger.debug(`🔍 SELL Swap | Token: ${tokenAddress.slice(0, 8)}... | RAW IN: ${tokenInput.rawTokenAmount.tokenAmount} | DECIMALS IN: ${tokenInput.rawTokenAmount.decimals} | ACTUAL TOKEN: ${tokenAmount.toLocaleString()} | RAW OUT: ${tokenOutput.rawTokenAmount.tokenAmount} | DECIMALS OUT: ${tokenOutput.rawTokenAmount.decimals} | USD: $${amountUSD.toLocaleString()}`);
        }
      }

      if (!tokenAddress || amountUSD < 1000) {
        this.processingStats.usdCalculationStats.fallbackCalculations++;
        return null;
      }

      const tokenInfo = await this.getTokenInfo(tokenAddress);
      
      const tokenPrice = await this.tokenMetadataService.getTokenPrice(tokenAddress);
      
      this.processingStats.usdCalculationStats.correctCalculations++;
      
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
        tokenPrice: tokenPrice || undefined,
        isFamilyMember: false,
        familySize: 0,
        familyId: undefined
      };
    } catch (error) {
      this.logger.error('Error extracting swap info:', error as Error);
      this.processingStats.usdCalculationStats.errorCalculations++;
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
      await this.telegramNotifier.sendSmartMoneySwap(swapInfo);
      this.processingStats.alertsSent++;
    } catch (error) {
      this.logger.error('Error sending Smart Money notification:', error as Error);
    }
  }

  private async getTokenInfo(tokenAddress: string): Promise<{ symbol: string; name: string; decimals: number }> {
    const cached = this.tokenInfoCache.get(tokenAddress);
    if (cached && Date.now() - cached.timestamp < 3600000) {
      return { symbol: cached.symbol, name: cached.name, decimals: cached.decimals };
    }

    try {
      const metadata = await this.tokenMetadataService.getTokenMetadata(tokenAddress);
      
      let symbol = 'UNKNOWN';
      let name = 'Unknown Token';
      let decimals = 9;
      
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
        timestamp: Date.now()
      };
      
      this.tokenInfoCache.set(tokenAddress, tokenInfo);
      return { symbol: tokenInfo.symbol, name: tokenInfo.name, decimals: tokenInfo.decimals };

    } catch (error) {
      this.logger.error(`Error getting token info for ${tokenAddress}:`, error);
      
      const fallbackSymbol = tokenAddress ? tokenAddress.slice(0, 6) : 'UNKNOWN';
      const fallbackName = tokenAddress ? `Token ${tokenAddress.slice(0, 8)}...` : 'Unknown Token';
      const fallbackDecimals = 9;
      
      this.tokenInfoCache.set(tokenAddress, {
        symbol: fallbackSymbol,
        name: fallbackName,
        decimals: fallbackDecimals,
        timestamp: Date.now()
      });

      return { symbol: fallbackSymbol, name: fallbackName, decimals: fallbackDecimals };
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
      
      this.logger.info(`💰 USD Calculation Stats: Correct=${this.processingStats.usdCalculationStats.correctCalculations}, Fallback=${this.processingStats.usdCalculationStats.fallbackCalculations}, Error=${this.processingStats.usdCalculationStats.errorCalculations}`);
      
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
          this.logger.info(`🚀 Webhook server started on port ${this.port} with API economy stubs`);
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