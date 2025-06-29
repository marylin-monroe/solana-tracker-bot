// src/services/LargeTransactionMonitor.ts - 🔥 УВЕЛИЧЕННЫЕ ИНТЕРВАЛЫ ДЛЯ API БЕЗОПАСНОСТИ
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
  riskScore?: number;
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

export class LargeTransactionMonitor {
  toggleMonitoring() {
    throw new Error('Method not implemented.');
  }
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
  
  // 🔥 КРИТИЧЕСКИЕ API ОПТИМИЗАЦИИ - УВЕЛИЧЕННЫЕ ИНТЕРВАЛЫ
  private readonly TRANSACTION_THRESHOLD_USD = 2_000_000;
  private readonly SCAN_INTERVAL_MS = 6 * 60 * 1000; // 🔥 6 минут (было 2 минуты)
  private readonly MAX_SLOTS_PER_SCAN = 10;          // 🔥 10 слотов за раз (было 15)
  private readonly DEEP_ANALYSIS_THRESHOLD = 5_000_000;
  
  private stats: MonitoringStats = {
    totalScanned: 0, largeTransactionsFound: 0, filtered: 0, alertsSent: 0,
    lastScanTime: new Date(), avgScanTime: 0, errorCount: 0, filterReasons: {}
  };
  
  // Кеши
  private enrichedTokenCache = new Map<string, { symbol: string; name: string; price: number | null; decimals: number; timestamp: number; }>();
  private readonly TOKEN_CACHE_TTL = 10 * 60 * 1000;
  
  // 🔥 PAYMENT_ASSETS для консистентности с WebhookServer
  private readonly PAYMENT_ASSETS = new Set([
    'So11111111111111111111111111111111111111112', // SOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
    'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // JitoSOL
    '7Q2afV64in6N6SeZsAAB81TJzwDoD6zpqmHkzi9Dcavn', // stSOL
    'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', // bSOL
    'he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A' // hSOL
  ]);

  private readonly MAJOR_TOKENS = new Set([
    'So11111111111111111111111111111111111111112', // SOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' // USDT
  ]);
  
  private readonly KNOWN_EXCHANGES = new Set([
    '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', 'AnH4zG6TBB8irVZLJ3ASoRhWLNBvFLekKqnH7fWfnrsY',
    'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE', 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS'
  ]);
  
  private readonly FILTER_THRESHOLDS = {
    HIGH_RISK_BLOCK: 70, SUSPICIOUS_WARNING: 30
  };

  constructor(telegramNotifier: TelegramNotifier, multiProvider: MultiProviderService, 
              tokenMetadataService: TokenMetadataService, smDatabase: SmartMoneyDatabase) {
    this.telegramNotifier = telegramNotifier;
    this.multiProvider = multiProvider;
    this.tokenMetadataService = tokenMetadataService;
    this.smDatabase = smDatabase;
    this.logger = Logger.getInstance();
    this.startCacheCleanup();
    this.logger.info('🚨 LargeTransactionMonitor OPTIMIZED: 6min intervals, 10 slots per scan for API safety');
  }

  async startMonitoring(): Promise<void> {
    return; //отключил
    if (this.isMonitoring) return;

    try {
      this.logger.info(`🚨 Starting optimized monitoring (${this.SCAN_INTERVAL_MS/60000}min intervals, ${this.MAX_SLOTS_PER_SCAN} slots)`);
      
      const slotResponse = await this.multiProvider.getSlot();
      this.lastProcessedSlot = slotResponse.success && slotResponse.data ? slotResponse.data : 0;
      this.isMonitoring = true;
      
      this.monitoringInterval = setInterval(() => this.scanForLargeTransactions(), this.SCAN_INTERVAL_MS);
      
      await this.telegramNotifier.sendCycleLog(
        `🚨 <b>OPTIMIZED Large TX Monitor Started</b>\n\n` +
        `💰 <b>Threshold:</b> <code>$${this.TRANSACTION_THRESHOLD_USD.toLocaleString()}</code>\n` +
        `⏰ <b>Scan Interval:</b> <code>${this.SCAN_INTERVAL_MS / 60000}min</code> (🔥 OPTIMIZED)\n` +
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

      // 🔥 ИСПРАВЛЕНО: Правильный расчет USD
      const swapInfo = await this.extractSwapInfoWithEnrichment(transaction);
      if (!swapInfo || swapInfo.amountUSD < this.TRANSACTION_THRESHOLD_USD) return;

      this.stats.largeTransactionsFound++;

      // Дешевая фильтрация
      if (await this.cheapPreFilter(swapInfo)) {
        this.stats.filtered++;
        return;
      }

      // Дорогая фильтрация для больших сумм
      const filterResult = swapInfo.amountUSD >= this.DEEP_ANALYSIS_THRESHOLD 
        ? await this.expensiveFullAnalysis(swapInfo)
        : await this.basicAnalysis(swapInfo);
      
      if (filterResult.shouldFilter) {
        this.stats.filtered++;
        this.stats.filterReasons[filterResult.reason || 'unknown'] = 
          (this.stats.filterReasons[filterResult.reason || 'unknown'] || 0) + 1;
        return;
      }

      swapInfo.riskScore = filterResult.riskScore;
      
      await this.sendLargeTransactionAlert(swapInfo);
      this.stats.alertsSent++;

    } catch (error) {
      this.logger.error('Error processing transaction:', error);
    }
  }

  private async cheapPreFilter(tx: LargeTransaction): Promise<boolean> {
    // 1. Биржи
    if (this.KNOWN_EXCHANGES.has(tx.walletAddress)) return true;
    
    // 2. 🔥 ИСПРАВЛЕНО: Блокируем только базовые токены SOL/USDC/USDT (НЕ LST!)
    if (this.MAJOR_TOKENS.has(tx.tokenAddress) && tx.amountUSD < 10_000_000) {
      tx.filterReason = `Major token (${tx.tokenSymbol}) under $10M`;
      return true;
    }

    // 3. Smart Money кошельки
    const ourGenius = await this.smDatabase.getSmartWallet(tx.walletAddress);
    if (ourGenius?.isActive) {
      tx.filterReason = `✅ Smart Money wallet - ${ourGenius.category.toUpperCase()}`;
      return true;
    }

    return false;
  }

  private async expensiveFullAnalysis(transaction: LargeTransaction): Promise<FilterResult> {
    let riskScore = 0;
    const reasons: string[] = [];

    try {
      // Анализ создателя токена
      const creatorScore = await this.calculateCreatorScore(transaction);
      riskScore += creatorScore;
      if (creatorScore > 0) reasons.push(`Creator(${creatorScore})`);

      // Анализ возраста кошелька
      const walletAge = await this.calculateWalletAge(transaction.walletAddress);
      if (walletAge < 10) { // Кошелек младше 10 минут
        riskScore += 50;
        reasons.push(`NewWallet(${walletAge}min)`);
      }

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

  // 🔥 ИСПРАВЛЕНО: Более точный расчет USD учитывающий тип изменения баланса
  private async extractSwapInfoWithEnrichment(transaction: any): Promise<LargeTransaction | null> {
    try {
      const signature = transaction.transaction?.signatures?.[0];
      const timestamp = transaction.blockTime ? new Date(transaction.blockTime * 1000) : new Date();
      const postTokenBalances = transaction.meta?.postTokenBalances || [];
      const preTokenBalances = transaction.meta?.preTokenBalances || [];
      const accountKeys = transaction.transaction?.message?.accountKeys || [];

      // 🔥 АНАЛИЗИРУЕМ ВСЕ ИЗМЕНЕНИЯ БАЛАНСОВ ДЛЯ ПОИСКА СВАПА
      const balanceChanges: Array<{
        tokenMint: string;
        change: number;
        decimals: number;
        accountIndex: number;
        walletAddress: string;
      }> = [];

      for (const postBalance of postTokenBalances) {
        const preBalance = preTokenBalances.find((pre: any) => pre.accountIndex === postBalance.accountIndex);
        
        const postRawAmount = parseFloat(postBalance.uiTokenAmount.amount || '0');
        const preRawAmount = preBalance ? parseFloat(preBalance.uiTokenAmount.amount || '0') : 0;
        const rawDifference = postRawAmount - preRawAmount;
        
        if (Math.abs(rawDifference) < 1) continue;

        const tokenMint = postBalance.mint;
        const metadata = await this.tokenMetadataService.getTokenMetadata(tokenMint);
        const decimals = metadata?.decimals || this.getDefaultDecimals(tokenMint);
        
        balanceChanges.push({
          tokenMint,
          change: rawDifference / Math.pow(10, decimals),
          decimals,
          accountIndex: postBalance.accountIndex,
          walletAddress: accountKeys[postBalance.accountIndex]?.pubkey || ''
        });
      }

      // 🔥 ИЩЕМ ПАТТЕРН СВАПА: одного токена стало меньше, другого больше
      let largestUSDChange = 0;
      let bestTransaction: LargeTransaction | null = null;

      for (const change of balanceChanges) {
        if (Math.abs(change.change) < 1) continue;

        let amountUSD = 0;
        const tokenAmount = Math.abs(change.change);

        // 🔥 СТРАТЕГИЯ РАСЧЕТА USD:
        // 1. Если это payment asset (SOL/USDC/USDT/LST) - считаем по его цене (точно)
        // 2. Если это неизвестный токен - ищем парный payment asset в том же свапе
        // 3. Иначе используем цену токена (может быть неточно)

        const isPaymentAsset = this.isPaymentAsset(change.tokenMint);
        
        if (isPaymentAsset) {
          // Точный расчет - это payment asset
          const tokenPrice = await this.tokenMetadataService.getTokenPrice(change.tokenMint);
          amountUSD = tokenAmount * (tokenPrice || this.getPaymentAssetFallbackPrice(change.tokenMint));
        } else {
          // Поиск парного payment asset в том же свапе
          const pairedPaymentAsset = balanceChanges.find(other => 
            other.walletAddress === change.walletAddress && 
            other.tokenMint !== change.tokenMint &&
            this.isPaymentAsset(other.tokenMint) &&
            Math.sign(other.change) !== Math.sign(change.change) // противоположные изменения
          );

          if (pairedPaymentAsset) {
            // 🔥 ТОЧНЫЙ РАСЧЕТ через парный payment asset
            const paymentPrice = await this.tokenMetadataService.getTokenPrice(pairedPaymentAsset.tokenMint) || 
                                this.getPaymentAssetFallbackPrice(pairedPaymentAsset.tokenMint);
            amountUSD = Math.abs(pairedPaymentAsset.change) * paymentPrice;
            this.logger.debug(`💰 Swap detected: ${Math.abs(pairedPaymentAsset.change)} ${pairedPaymentAsset.tokenMint.slice(0,6)} (${amountUSD.toFixed(2)}) → ${tokenAmount} ${change.tokenMint.slice(0,6)}`);
          } else {
            // Фоллбэк - пытаемся получить цену токена
            const tokenPrice = await this.tokenMetadataService.getTokenPrice(change.tokenMint);
            if (tokenPrice && tokenPrice > 0) {
              amountUSD = tokenAmount * tokenPrice;
            } else {
              const isNewToken = await this.isTokenNew(change.tokenMint);
              if (isNewToken) {
                amountUSD = tokenAmount > 1000000 ? tokenAmount * 0.01 : tokenAmount * 0.001;
              } else {
                amountUSD = tokenAmount * 0.001;
              }
            }
          }
        }

        if (amountUSD > largestUSDChange) {
          largestUSDChange = amountUSD;
          const enrichedInfo = await this.getEnrichedTokenInfo(change.tokenMint);
          
          bestTransaction = {
            signature, timestamp,
            walletAddress: change.walletAddress,
            tokenAddress: change.tokenMint,
            tokenSymbol: enrichedInfo.symbol,
            tokenName: enrichedInfo.name,
            amountUSD,
            transactionType: change.change > 0 ? 'buy' : 'sell',
            isFiltered: false,
            tokenPrice: amountUSD > 0 && tokenAmount > 0 ? amountUSD / tokenAmount : 0,
            actualTokenAmount: tokenAmount,
            rawTokenAmount: Math.abs(change.change * Math.pow(10, change.decimals)),
            decimals: change.decimals,
            riskScore: 0
          };
          
          // 🔥 ДЕТАЛЬНОЕ ЛОГИРОВАНИЕ как в QuickNodeWebhookManager
          this.logger.info(`📊 LARGE TX DETECTED: ${enrichedInfo.symbol} | ` +
            `RAW: ${Math.abs(change.change * Math.pow(10, change.decimals)).toLocaleString()} | ` +
            `DECIMALS: ${change.decimals} | ` +
            `ACTUAL: ${tokenAmount.toFixed(4)} | ` +
            `PRICE: ${bestTransaction.tokenPrice.toFixed(6)} | ` +
            `USD: ${amountUSD.toLocaleString()} | ` +
            `TYPE: ${change.change > 0 ? 'BUY' : 'SELL'} | ` +
            `WALLET: ${change.walletAddress.slice(0,8)}...`);
        }
      }

      if (!bestTransaction) {
        this.logger.debug(`🚫 No evaluable large transactions found in ${signature?.slice(0,8)}... (${balanceChanges.length} balance changes analyzed)`);
      }

      return bestTransaction;
    } catch (error) {
      return null;
    }
  }

  private isPaymentAsset(tokenMint: string): boolean {
    return this.PAYMENT_ASSETS.has(tokenMint);
  }

  private getPaymentAssetFallbackPrice(tokenMint: string): number {
    if (tokenMint === 'So11111111111111111111111111111111111111112') return 140.8; // SOL
    if (tokenMint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') return 1.0; // USDC
    if (tokenMint === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') return 1.0; // USDT
    if (tokenMint === 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So') return 140.0; // mSOL
    if (tokenMint === 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn') return 140.0; // JitoSOL
    if (tokenMint === '7Q2afV64in6N6SeZsAAB81TJzwDoD6zpqmHkzi9Dcavn') return 140.0; // stSOL
    if (tokenMint === 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1') return 140.0; // bSOL
    if (tokenMint === 'he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A') return 140.0; // hSOL
    return 1.0;
  }

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

  // 🔥 ИСПРАВЛЕНО: Анализ создателя токена БЕЗ ОШИБОЧНЫХ API ЗАПРОСОВ
  private async calculateCreatorScore(transaction: LargeTransaction): Promise<number> {
    let score = 0;
    try {
      // 1. Проверяем является ли кошелек mint authority (самый важный признак)
      const mintInfo = await this.getMintInfo(transaction.tokenAddress);
      if (mintInfo?.mintAuthority === transaction.walletAddress) {
        score += 80; // КРИТИЧЕСКИЙ РИСК - кошелек = создатель токена
        this.logger.warn(`🚨 CREATOR DETECTED: Wallet ${transaction.walletAddress.slice(0,8)} is mint authority for ${transaction.tokenSymbol}`);
      }

      // 2. Анализ возраста кошелька
      const walletAge = await this.calculateWalletAge(transaction.walletAddress);
      if (walletAge < 30) { // Кошелек младше 30 минут
        score += 40;
        this.logger.warn(`⚠️ NEW WALLET: ${transaction.walletAddress.slice(0,8)} age: ${walletAge.toFixed(1)} minutes`);
      } else if (walletAge < 120) { // Кошелек младше 2 часов
        score += 20;
      }

      // 3. Анализ возраста токена
      const isNewToken = await this.isTokenNew(transaction.tokenAddress);
      if (isNewToken) {
        score += 30;
        this.logger.warn(`⚠️ NEW TOKEN: ${transaction.tokenSymbol} appears to be very new`);
      }

      // 4. Комбо: новый кошелек + новый токен = очень подозрительно
      if (walletAge < 60 && isNewToken) {
        score += 50; // Дополнительный риск за комбинацию
        this.logger.warn(`🚨 SUSPICIOUS COMBO: New wallet (${walletAge.toFixed(1)}min) trading new token ${transaction.tokenSymbol}`);
      }

      return Math.min(score, 100);
    } catch (error) {
      this.logger.debug(`Error in creator analysis for ${transaction.tokenAddress}:`, error);
      return 0;
    }
  }

  private async getMintInfo(tokenAddress: string): Promise<any> {
    try {
      const response = await this.multiProvider.getAccountInfo(tokenAddress);
      return response.success ? response.data?.parsed?.info : null;
    } catch {
      return null;
    }
  }

  private async isTokenNew(tokenAddress: string): Promise<boolean> {
    try {
      // 🔥 ИСПРАВЛЕНО: Получаем больше транзакций и анализируем паттерн
      const response = await this.multiProvider.makeRequest('getSignaturesForAddress', [
        tokenAddress, { limit: 20 } // Берем 20 последних транзакций
      ]);
      
      if (response.success && response.data?.length > 0) {
        const transactions = response.data;
        const oldestTx = transactions[transactions.length - 1]; // Самая старая из полученных
        const newestTx = transactions[0]; // Самая новая
        
        const oldestTime = oldestTx.blockTime * 1000;
        const newestTime = newestTx.blockTime * 1000;
        const now = Date.now();
        
        // Если все 20 транзакций произошли за последние 24 часа - скорее всего новый токен
        const oldestAge = (now - oldestTime) / (1000 * 60 * 60); // часы
        const isVeryActive = transactions.length >= 20 && oldestAge < 24;
        
        // Простая эвристика: если самая старая из 20 транзакций младше 24 часов = новый токен
        return oldestAge < 24 || isVeryActive;
      }
      
      return false; // Нет данных = считаем старым
    } catch {
      return false;
    }
  }

  private async calculateWalletAge(walletAddress: string): Promise<number> {
    try {
      // 🔥 ИСПРАВЛЕНО: Получаем несколько транзакций для определения возраста
      const response = await this.multiProvider.makeRequest('getSignaturesForAddress', [
        walletAddress, { limit: 10 } // Берем 10 последних транзакций
      ]);
      
      if (response.success && response.data?.length > 0) {
        const transactions = response.data;
        const oldestTx = transactions[transactions.length - 1]; // Самая старая из полученных
        
        const firstTxTime = oldestTx.blockTime * 1000;
        const ageMinutes = (Date.now() - firstTxTime) / (1000 * 60);
        
        // Если у нас менее 10 транзакций и все они очень свежие - вероятно молодой кошелек
        if (transactions.length < 5 && ageMinutes < 60) {
          return ageMinutes; // Очень молодой кошелек
        }
        
        return Math.max(0, ageMinutes);
      }
      
      return 9999; // Нет данных = считаем очень старым
    } catch {
      return 9999;
    }
  }

  private async sendLargeTransactionAlert(transaction: LargeTransaction): Promise<void> {
    try {
      await this.telegramNotifier.sendLargeTransactionAlert(transaction);
      this.logger.info(`🚨 Large TX alert: ${transaction.tokenSymbol} $${transaction.amountUSD.toLocaleString()}`);
    } catch (error) {
      this.logger.error('Error sending alert:', error);
    }
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
      for (const [key, value] of this.enrichedTokenCache) {
        if (value.timestamp && now - value.timestamp > this.TOKEN_CACHE_TTL) {
          this.enrichedTokenCache.delete(key);
        }
      }
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
    this.enrichedTokenCache.clear();
    this.logger.info('✅ LargeTransactionMonitor shutdown completed');
  }
}