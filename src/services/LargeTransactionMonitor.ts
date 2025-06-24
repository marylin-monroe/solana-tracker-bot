// src/services/LargeTransactionMonitor.ts - 🔥 ИСПРАВЛЕНО: USD расчеты + MAJOR_TOKENS логика + riskScore добавлен
import { TelegramNotifier } from './TelegramNotifier';
import { MultiProviderService } from './MultiProviderService';
import { TokenMetadataService } from './TokenMetadataService';
import { SmartMoneyDatabase } from './SmartMoneyDatabase';
import { Logger } from '../utils/Logger';

export interface LargeTransaction {
  signature: string;
  timestamp: Date;
  walletAddress: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  amountUSD: number;
  transactionType: 'buy' | 'sell';
  dex?: string;
  isFiltered: boolean;
  filterReason?: string;
  tokenPrice?: number;
  rawTokenAmount?: number;
  actualTokenAmount?: number;
  decimals?: number;
  riskScore?: number; // 🔧 ДОБАВЛЕНО для типобезопасности TelegramNotifier
}

interface FilterResult {
  shouldFilter: boolean;
  reason?: string;
  riskScore: number;
}

interface MonitoringStats {
  totalScanned: number;
  largeTransactionsFound: number;
  filtered: number;
  alertsSent: number;
  lastScanTime: Date;
  avgScanTime: number;
  errorCount: number;
  filterReasons: Record<string, number>;
}

interface EnhancedMintInfo {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  decimals: number;
  supply: number;
  isInitialized: boolean;
  hasTransferFeeConfig: boolean;
  hasTransferHook: boolean;
  hasPermanentDelegate: boolean;
  hasNonTransferable: boolean;
  extensionTypes: string[];
  tokenProgram: string;
  isToken2022: boolean;
}

interface TokenCreatorAnalysis {
  isDeployer: boolean;
  isMintAuthority: boolean;
  isFreezeAuthority: boolean;
  deployerConfidence: number;
  firstTransactionRole: 'creator' | 'early_buyer' | 'liquidity_provider' | 'unknown';
  creationTimeDistance: number;
}

export class LargeTransactionMonitor {
  private telegramNotifier: TelegramNotifier;
  private multiProvider: MultiProviderService;
  private tokenMetadataService: TokenMetadataService;
  private smDatabase: SmartMoneyDatabase;
  private logger: Logger;
  
  private isMonitoring: boolean = false;
  private monitoringInterval: NodeJS.Timeout | null = null;
  private lastProcessedSlot: number = 0;
  
  private processedSignatures = new Map<string, number>();
  private readonly DUPLICATE_WINDOW = 30 * 60 * 1000;
  
  // 🔥 КРИТИЧЕСКИЕ API ОПТИМИЗАЦИИ
  private readonly TRANSACTION_THRESHOLD_USD = 2_000_000;
  private readonly SCAN_INTERVAL_MS = 2 * 60 * 1000; // 2 минуты (было 30 сек)
  private readonly MAX_SLOTS_PER_SCAN = 15; // 15 слотов (было 50)
  private readonly DEEP_ANALYSIS_THRESHOLD = 5_000_000; // $5M+ для глубокого анализа
  
  private stats: MonitoringStats = {
    totalScanned: 0, largeTransactionsFound: 0, filtered: 0, alertsSent: 0,
    lastScanTime: new Date(), avgScanTime: 0, errorCount: 0, filterReasons: {}
  };
  
  // Кеши
  private scamAddressCache = new Map<string, { isScam: boolean; timestamp: number }>();
  private enrichedTokenCache = new Map<string, { symbol: string; name: string; price: number | null; decimals: number; timestamp: number; }>();
  private mintInfoCache = new Map<string, { mintInfo: EnhancedMintInfo; timestamp: number }>();
  private tokenCreatorCache = new Map<string, { analysis: TokenCreatorAnalysis; timestamp: number }>();
  
  private readonly CACHE_TTL = 60 * 60 * 1000; // 1 час
  private readonly TOKEN_CACHE_TTL = 10 * 60 * 1000; // 10 минут
  private readonly CREATOR_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 часа
  
  // 🔥 ИСПРАВЛЕНО: Major токены НЕ блокируются для действительно больших сумм
  private readonly MAJOR_TOKENS = new Set([
    'So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
  ]);
  
  private readonly KNOWN_EXCHANGES = new Set([
    '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', 'AnH4zG6TBB8irVZLJ3ASoRhWLNBvFLekKqnH7fWfnrsY',
    'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE', 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS'
  ]);
  
  private readonly TOKEN_PROGRAMS = {
    TOKEN_PROGRAM: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    TOKEN_2022_PROGRAM: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
  };
  
  private readonly FILTER_THRESHOLDS = {
    SCAM_AUTO_BLOCK: 100, HIGH_RISK_BLOCK: 70, SUSPICIOUS_WARNING: 30, LEGITIMATE_THRESHOLD: 0
  };

  constructor(telegramNotifier: TelegramNotifier, multiProvider: MultiProviderService, 
              tokenMetadataService: TokenMetadataService, smDatabase: SmartMoneyDatabase) {
    this.telegramNotifier = telegramNotifier;
    this.multiProvider = multiProvider;
    this.tokenMetadataService = tokenMetadataService;
    this.smDatabase = smDatabase;
    this.logger = Logger.getInstance();
    this.startCacheCleanup();
    this.logger.info('🚨 LargeTransactionMonitor FIXED: Correct USD calc + Major tokens logic + riskScore added');
  }

  async startMonitoring(): Promise<void> {
    if (this.isMonitoring) return;

    try {
      this.logger.info(`🚨 Starting optimized monitoring (${this.SCAN_INTERVAL_MS/1000}s intervals, ${this.MAX_SLOTS_PER_SCAN} slots)`);
      
      const slotResponse = await this.multiProvider.getSlot();
      this.lastProcessedSlot = slotResponse.success && slotResponse.data ? slotResponse.data : 0;
      this.isMonitoring = true;
      
      this.monitoringInterval = setInterval(() => this.scanForLargeTransactions(), this.SCAN_INTERVAL_MS);
      
      await this.telegramNotifier.sendCycleLog(
        `🚨 <b>FIXED Large TX Monitor Started</b>\n\n` +
        `💰 <b>Threshold:</b> <code>$${this.TRANSACTION_THRESHOLD_USD.toLocaleString()}</code>\n` +
        `⏰ <b>Scan Interval:</b> <code>${this.SCAN_INTERVAL_MS / 1000}s</code> (🔥 OPTIMIZED)\n` +
        `📊 <b>Max Slots:</b> <code>${this.MAX_SLOTS_PER_SCAN}</code> per scan\n` +
        `🚀 <b>Deep Analysis:</b> <code>$${this.DEEP_ANALYSIS_THRESHOLD.toLocaleString()}+</code>\n` +
        `🛡️ <b>Smart Money Block:</b> <code>Active</code>\n` +
        `✅ <b>Major Tokens:</b> <code>Fixed Logic</code>\n\n` +
        `⏰ <code>${new Date().toLocaleString()}</code>`
      );

    } catch (error) {
      this.logger.error('❌ Error starting monitoring:', error);
      this.isMonitoring = false;
      throw error;
    }
  }

  async stopMonitoring(): Promise<void> {
    if (!this.isMonitoring) return;
    this.isMonitoring = false;
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    this.logger.info('✅ Optimized monitoring stopped');
  }

  // 🔥 ОПТИМИЗИРОВАННОЕ СКАНИРОВАНИЕ
  private async scanForLargeTransactions(): Promise<void> {
    if (!this.isMonitoring) return;

    const startTime = Date.now();
    try {
      const currentSlotResponse = await this.multiProvider.getSlot();
      if (!currentSlotResponse.success || !currentSlotResponse.data) return;

      const currentSlot = currentSlotResponse.data;
      const startSlot = this.lastProcessedSlot + 1;
      const endSlot = Math.min(currentSlot, startSlot + this.MAX_SLOTS_PER_SCAN - 1);

      if (startSlot > endSlot) return;

      const blocks = await this.getBlocksInRangeBatched(startSlot, endSlot);
      
      for (const block of blocks) {
        if (!this.isMonitoring) break;
        await this.processBlockOptimized(block);
      }

      this.lastProcessedSlot = endSlot;
      this.stats.avgScanTime = (this.stats.avgScanTime + Date.now() - startTime) / 2;
      this.stats.lastScanTime = new Date();

    } catch (error) {
      this.logger.error('Error in optimized scanning:', error);
      this.stats.errorCount++;
    }
  }

  private async getBlocksInRangeBatched(startSlot: number, endSlot: number): Promise<any[]> {
    const blocks: any[] = [];
    const BATCH_SIZE = 10;

    for (let slot = startSlot; slot <= endSlot; slot += BATCH_SIZE) {
      if (!this.isMonitoring) break;
      
      const batchEnd = Math.min(slot + BATCH_SIZE - 1, endSlot);
      const batchPromises = [];
      
      for (let s = slot; s <= batchEnd; s++) {
        batchPromises.push(this.getBlock(s));
      }
      
      const batchResults = await Promise.allSettled(batchPromises);
      batchResults.forEach(result => {
        if (result.status === 'fulfilled' && result.value) {
          blocks.push(result.value);
        }
      });
      
      await this.sleep(200);
    }
    
    return blocks;
  }

  private async getBlock(slot: number): Promise<any | null> {
    try {
      const response = await this.multiProvider.makeRequest('getBlock', [slot, {
        encoding: 'jsonParsed', transactionDetails: 'full', rewards: false,
        commitment: 'confirmed', maxSupportedTransactionVersion: 0
      }]);
      return response.success ? response.data : null;
    } catch (error) {
      return null;
    }
  }

  private async processBlockOptimized(block: any): Promise<void> {
    if (!block?.transactions) return;

    for (const transaction of block.transactions) {
      if (!this.isMonitoring) break;
      await this.processTransactionOptimized(transaction);
      this.stats.totalScanned++;
    }
  }

  private async processTransactionOptimized(transaction: any): Promise<void> {
    try {
      if (!transaction?.meta || transaction.meta.err) return;

      const signature = transaction.transaction?.signatures?.[0];
      if (!signature || this.isAlreadyProcessed(signature)) return;

      this.markAsProcessed(signature);

      const swapInfo = await this.extractSwapInfoWithEnrichment(transaction);
      if (!swapInfo || swapInfo.amountUSD < this.TRANSACTION_THRESHOLD_USD) return;

      this.stats.largeTransactionsFound++;

      // 🚀 1. ДЕШЕВАЯ ФИЛЬТРАЦИЯ СНАЧАЛА
      if (await this.cheapPreFilter(swapInfo)) {
        this.stats.filtered++;
        return;
      }

      // 🚀 2. ДОРОГАЯ ФИЛЬТРАЦИЯ только для больших сумм
      const filterResult = swapInfo.amountUSD >= this.DEEP_ANALYSIS_THRESHOLD 
        ? await this.expensiveFullAnalysis(swapInfo)
        : await this.basicAnalysis(swapInfo);
      
      if (filterResult.shouldFilter) {
        this.stats.filtered++;
        this.stats.filterReasons[filterResult.reason || 'unknown'] = 
          (this.stats.filterReasons[filterResult.reason || 'unknown'] || 0) + 1;
        return;
      }

      // 🔧 УСТАНАВЛИВАЕМ riskScore в транзакцию перед отправкой
      swapInfo.riskScore = filterResult.riskScore;
      
      await this.sendLargeTransactionAlert(swapInfo);
      this.stats.alertsSent++;

    } catch (error) {
      this.logger.error('Error processing transaction:', error);
    }
  }

  // 🔥 ИСПРАВЛЕНО: MAJOR_TOKENS логика - не блокируем действительно большие транзакции
  private async cheapPreFilter(tx: LargeTransaction): Promise<boolean> {
    // 1. Проверка известных бирж
    if (this.KNOWN_EXCHANGES.has(tx.walletAddress)) return true;
    
    // 🔥 ИСПРАВЛЕНО: Major токены блокируем только если сумма не очень большая
    if (this.MAJOR_TOKENS.has(tx.tokenAddress) && tx.amountUSD < 10_000_000) {
      tx.filterReason = `Major token (${tx.tokenSymbol}) under $10M threshold`;
      return true;
    }

    // 2. БД запрос (дешевый)
    const ourGenius = await this.smDatabase.getSmartWallet(tx.walletAddress);
    if (ourGenius?.isActive) {
      tx.filterReason = `✅ VERIFIED GENIUS - ${ourGenius.category.toUpperCase()}`;
      this.logger.info(`🚫 BLOCKED Large TX for SM wallet: $${tx.amountUSD.toFixed(0)}`);
      return true;
    }

    return false;
  }

  private async expensiveFullAnalysis(transaction: LargeTransaction): Promise<FilterResult> {
    let riskScore = 0;
    const reasons: string[] = [];

    try {
      const honeypotScore = await this.calculateEnhancedHoneypotScore(transaction);
      riskScore += honeypotScore;
      if (honeypotScore > 0) reasons.push(`Honeypot(${honeypotScore})`);

      const creatorScore = await this.calculateAdvancedCreatorScore(transaction);
      riskScore += creatorScore;
      if (creatorScore > 0) reasons.push(`Creator(${creatorScore})`);

      return this.evaluateRiskScore(riskScore, reasons, transaction);
    } catch (error) {
      return { shouldFilter: false, riskScore: 0 };
    }
  }

  private async basicAnalysis(transaction: LargeTransaction): Promise<FilterResult> {
    let riskScore = 0;
    if (this.isRoundAmount(transaction.amountUSD)) riskScore += 30;
    return this.evaluateRiskScore(riskScore, [], transaction);
  }

  private evaluateRiskScore(riskScore: number, reasons: string[], transaction: LargeTransaction): FilterResult {
    if (riskScore >= this.FILTER_THRESHOLDS.HIGH_RISK_BLOCK) {
      return { shouldFilter: true, reason: `High risk (${riskScore}): ${reasons.join(', ')}`, riskScore };
    } else if (riskScore >= this.FILTER_THRESHOLDS.SUSPICIOUS_WARNING) {
      transaction.filterReason = `⚠️ SUSPICIOUS (${riskScore}): ${reasons.join(', ')}`;
      return { shouldFilter: false, riskScore };
    }
    return { shouldFilter: false, riskScore };
  }

  // 🔥 ИСПРАВЛЕНО: правильные decimals + корректный USD расчет
  private async extractSwapInfoWithEnrichment(transaction: any): Promise<LargeTransaction | null> {
    try {
      const signature = transaction.transaction?.signatures?.[0];
      const timestamp = transaction.blockTime ? new Date(transaction.blockTime * 1000) : new Date();
      const postTokenBalances = transaction.meta?.postTokenBalances || [];
      const preTokenBalances = transaction.meta?.preTokenBalances || [];
      const accountKeys = transaction.transaction?.message?.accountKeys || [];

      for (const postBalance of postTokenBalances) {
        const preBalance = preTokenBalances.find((pre: any) => pre.accountIndex === postBalance.accountIndex);
        
        const postRawAmount = parseFloat(postBalance.uiTokenAmount.amount || '0');
        const preRawAmount = preBalance ? parseFloat(preBalance.uiTokenAmount.amount || '0') : 0;
        const rawDifference = postRawAmount - preRawAmount;
        
        const tokenMint = postBalance.mint;
        const decimals = postBalance.uiTokenAmount.decimals || this.getDefaultDecimals(tokenMint);
        const actualDifference = rawDifference / Math.pow(10, decimals);

        if (Math.abs(actualDifference) < 1) continue;

        const enrichedInfo = await this.getEnrichedTokenInfo(tokenMint);
        const tokenAmount = Math.abs(actualDifference);
        const amountUSD = enrichedInfo.price ? tokenAmount * enrichedInfo.price : tokenAmount * 0.001;

        return {
          signature, timestamp,
          walletAddress: accountKeys[postBalance.accountIndex]?.pubkey || '',
          tokenAddress: tokenMint,
          tokenSymbol: enrichedInfo.symbol,
          tokenName: enrichedInfo.name,
          amountUSD,
          transactionType: actualDifference > 0 ? 'buy' : 'sell',
          isFiltered: false,
          tokenPrice: enrichedInfo.price,
          actualTokenAmount: tokenAmount,
          decimals,
          riskScore: 0 // 🔧 ИНИЦИАЛИЗИРУЕМ по умолчанию
        };
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  // 🔥 ИСПРАВЛЕНО: добавлен метод getDefaultDecimals
  private getDefaultDecimals(tokenMint: string): number {
    if (tokenMint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') return 6; // USDC
    if (tokenMint === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') return 6; // USDT  
    return 9; // SOL и большинство других
  }

  private async getEnrichedTokenInfo(tokenAddress: string) {
    const cached = this.enrichedTokenCache.get(tokenAddress);
    if (cached && Date.now() - cached.timestamp < this.TOKEN_CACHE_TTL) {
      return { symbol: cached.symbol, name: cached.name, price: cached.price };
    }

    try {
      const [tokenInfo, price] = await Promise.all([
        this.tokenMetadataService.getTokenMetadata(tokenAddress),
        this.tokenMetadataService.getTokenPrice(tokenAddress)
      ]);

      const result = {
        symbol: tokenInfo?.symbol || `TOKEN_${tokenAddress.slice(0, 6)}`,
        name: tokenInfo?.name || 'Unknown Token',
        price,
        decimals: tokenInfo?.decimals || this.getDefaultDecimals(tokenAddress),
        timestamp: Date.now()
      };

      this.enrichedTokenCache.set(tokenAddress, result);
      return result;
    } catch (error) {
      return { symbol: `TOKEN_${tokenAddress.slice(0, 6)}`, name: 'Unknown Token', price: 0.001 };
    }
  }

  private async calculateEnhancedHoneypotScore(transaction: LargeTransaction): Promise<number> {
    let score = 0;
    try {
      const mintInfo = await this.getEnhancedMintInfo(transaction.tokenAddress);
      if (mintInfo.freezeAuthority) score += 40;
      if (mintInfo.mintAuthority) score += 35;
      if (mintInfo.isToken2022 && mintInfo.hasNonTransferable) score += 100;
      return Math.min(score, 100);
    } catch { return 0; }
  }

  private async calculateAdvancedCreatorScore(transaction: LargeTransaction): Promise<number> {
    let score = 0;
    try {
      const analysis = await this.analyzeTokenCreator(transaction.walletAddress, transaction.tokenAddress);
      if (analysis.isMintAuthority) score += 40;
      if (analysis.isFreezeAuthority) score += 35;
      if (analysis.isDeployer) score += Math.min(analysis.deployerConfidence, 30);
      return Math.min(score, 100);
    } catch { return 0; }
  }

  private async getEnhancedMintInfo(tokenAddress: string): Promise<EnhancedMintInfo> {
    const cached = this.mintInfoCache.get(tokenAddress);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) return cached.mintInfo;

    try {
      const response = await this.multiProvider.getAccountInfo(tokenAddress);
      if (!response.success) throw new Error('Failed to get mint info');

      const parsed = response.data?.parsed?.info || {};
      const mintInfo: EnhancedMintInfo = {
        mintAuthority: parsed.mintAuthority || null,
        freezeAuthority: parsed.freezeAuthority || null,
        decimals: parsed.decimals || this.getDefaultDecimals(tokenAddress),
        supply: parsed.supply || 0,
        isInitialized: parsed.isInitialized === true,
        hasTransferFeeConfig: false,
        hasTransferHook: false,
        hasPermanentDelegate: false,
        hasNonTransferable: false,
        extensionTypes: [],
        tokenProgram: response.data?.owner || this.TOKEN_PROGRAMS.TOKEN_PROGRAM,
        isToken2022: response.data?.owner === this.TOKEN_PROGRAMS.TOKEN_2022_PROGRAM
      };

      this.mintInfoCache.set(tokenAddress, { mintInfo, timestamp: Date.now() });
      return mintInfo;
    } catch {
      return {
        mintAuthority: null, freezeAuthority: null, decimals: this.getDefaultDecimals(tokenAddress), supply: 0,
        isInitialized: false, hasTransferFeeConfig: false, hasTransferHook: false,
        hasPermanentDelegate: false, hasNonTransferable: false, extensionTypes: [],
        tokenProgram: this.TOKEN_PROGRAMS.TOKEN_PROGRAM, isToken2022: false
      };
    }
  }

  private async analyzeTokenCreator(walletAddress: string, tokenAddress: string): Promise<TokenCreatorAnalysis> {
    const cacheKey = `${walletAddress}_${tokenAddress}`;
    const cached = this.tokenCreatorCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CREATOR_CACHE_TTL) return cached.analysis;

    try {
      const mintInfo = await this.getEnhancedMintInfo(tokenAddress);
      const analysis: TokenCreatorAnalysis = {
        isDeployer: mintInfo.mintAuthority === walletAddress || mintInfo.freezeAuthority === walletAddress,
        isMintAuthority: mintInfo.mintAuthority === walletAddress,
        isFreezeAuthority: mintInfo.freezeAuthority === walletAddress,
        deployerConfidence: mintInfo.mintAuthority === walletAddress ? 70 : 0,
        firstTransactionRole: 'unknown',
        creationTimeDistance: 0
      };

      this.tokenCreatorCache.set(cacheKey, { analysis, timestamp: Date.now() });
      return analysis;
    } catch {
      return { isDeployer: false, isMintAuthority: false, isFreezeAuthority: false, deployerConfidence: 0, firstTransactionRole: 'unknown', creationTimeDistance: 9999 };
    }
  }

  // 🔥 ИСПРАВЛЕНО: используем sendLargeTransactionAlert из TelegramNotifier
  private async sendLargeTransactionAlert(transaction: LargeTransaction): Promise<void> {
    try {
      await this.telegramNotifier.sendLargeTransactionAlert(transaction);
      this.logger.info(`🚨 Large TX alert sent: ${transaction.tokenSymbol} $${transaction.amountUSD.toLocaleString()}`);
    } catch (error) {
      this.logger.error('Error sending large transaction alert:', error);
    }
  }

  private getRiskEmoji(riskScore: number): string {
    if (riskScore >= 80) return '🔴';
    if (riskScore >= 50) return '🟡'; 
    if (riskScore >= 20) return '🟢';
    return '✅';
  }

  // Утилиты
  private isAlreadyProcessed(signature: string): boolean {
    const processedTime = this.processedSignatures.get(signature);
    return processedTime ? (Date.now() - processedTime) < this.DUPLICATE_WINDOW : false;
  }

  private markAsProcessed(signature: string): void {
    this.processedSignatures.set(signature, Date.now());
  }

  private isRoundAmount(amount: number): boolean {
    const roundAmounts = [1000000, 2000000, 5000000, 10000000];
    return roundAmounts.some(round => Math.abs(amount - round) < round * 0.01);
  }

  private startCacheCleanup(): void {
    setInterval(() => {
      const now = Date.now();
      for (const [signature, timestamp] of this.processedSignatures) {
        if (now - timestamp > this.DUPLICATE_WINDOW) {
          this.processedSignatures.delete(signature);
        }
      }
      [this.scamAddressCache, this.enrichedTokenCache, this.mintInfoCache, this.tokenCreatorCache].forEach(cache => {
        for (const [key, value] of cache) {
          if (value.timestamp && now - value.timestamp > this.CACHE_TTL) {
            cache.delete(key);
          }
        }
      });
    }, 5 * 60 * 1000);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getStats(): MonitoringStats {
    return { ...this.stats };
  }

  async shutdown(): Promise<void> {
    await this.stopMonitoring();
    this.processedSignatures.clear();
    [this.scamAddressCache, this.enrichedTokenCache, this.mintInfoCache, this.tokenCreatorCache].forEach(cache => cache.clear());
    this.logger.info('✅ LargeTransactionMonitor shutdown completed');
  }
}