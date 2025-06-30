// src/services/QuickNodeWebhookManager.ts - 🔥 ПОЛНОСТЬЮ ИСПРАВЛЕННЫЙ С ПРАВИЛЬНОЙ ЛОГИКОЙ ИЗВЛЕЧЕНИЯ БАЛАНСОВ
import { Logger } from '../utils/Logger';
import { SmartMoneyDatabase } from './SmartMoneyDatabase';
import { TelegramNotifier } from './TelegramNotifier';
import { TokenMetadataService } from './TokenMetadataService';
import { SmartMoneyWallet, SmartMoneySwap } from '../types';

interface QuickNodeStreamConfig {
  name: string;
  webhook_url: string;
  filters: Array<{ program_id?: string[]; account_type?: string; }>;
  region?: string;
}

interface QuickNodeStreamResponse {
  id: string;
  name: string;
  webhook_url: string;
  status: string;
  filters: any;
}

interface ApiLimits {
  requestsPerMinute: number;
  requestsPerDay: number;
  currentMinuteRequests: number;
  currentDayRequests: number;
  minuteReset: number;
  dayReset: number;
  lastRequestTime: number;
}

interface RpcProvider {
  name: string;
  url: string;
  key?: string;
  isHealthy: boolean;
  requestCount: number;
  errorCount: number;
  lastError?: string;
  lastErrorTime?: number;
  type: 'quicknode' | 'alchemy';
  priority: number;
}

interface ProviderStats {
  name: string;
  type: string;
  requestCount: number;
  errorCount: number;
  successRate: number;
  avgResponseTime: number;
  isHealthy: boolean;
  priority: number;
}

export class QuickNodeWebhookManager {
  private logger: Logger;
  private providers: RpcProvider[] = [];
  private currentProviderIndex: number = 0;
  private providerResponseTimes: Map<string, number[]> = new Map();
  
  private smDatabase: SmartMoneyDatabase;
  private telegramNotifier: TelegramNotifier | null = null;
  private tokenMetadataService: TokenMetadataService;
  
  private readonly POLLING_INTERVAL = 2 * 60 * 1000;
  private readonly MAX_WALLETS_PER_BATCH = 10;
  private readonly CONCURRENT_WALLET_PROCESSING = 5;
  private readonly DELAY_BETWEEN_WALLETS = 1000;
  private readonly DELAY_BETWEEN_TRANSACTIONS = 300;
  private readonly SIGNATURES_LIMIT = 5;
  
  private isPollingActive: boolean = false;
  private pollingInterval: NodeJS.Timeout | null = null;
  private lastProcessedSignatures = new Map<string, string>();
  private monitoredWallets: SmartMoneyWallet[] = [];
  
  private recentSignatures = new Set<string>();
  private lastCleanupTime = Date.now();
  private botStartTime = Date.now();
  
  private errorStats = {
    walletProcessingErrors: 0,
    transactionProcessingErrors: 0,
    apiErrors: 0,
    lastErrorTime: new Date(),
    recoveredFromErrors: 0
  };
  
  private syncStats = {
    walletListUpdates: 0,
    lastWalletListUpdate: new Date(),
    walletsFoundInLastUpdate: 0,
    totalPollingCycles: 0,
    emptyListCycles: 0
  };
  
  private tokenInfoCache = new Map<string, { symbol: string; name: string; decimals: number; timestamp: number; price?: number; }>();
  private priceCache = new Map<string, { priceUSD: number; timestamp: number; }>();
  private addressCache = new Map<string, { hasSwap: boolean; timestamp: number; }>();
  
  private apiLimitMutex: boolean = false;
  private apiLimits: ApiLimits = {
    requestsPerMinute: 100, requestsPerDay: 50000, currentMinuteRequests: 0, currentDayRequests: 0,
    minuteReset: Date.now() + 60000, dayReset: Date.now() + 24 * 60 * 60 * 1000, lastRequestTime: 0
  };

  constructor(smDatabase: SmartMoneyDatabase, telegramNotifier?: TelegramNotifier) {
    this.logger = Logger.getInstance();
    this.smDatabase = smDatabase;
    this.telegramNotifier = telegramNotifier || null;
    this.tokenMetadataService = new TokenMetadataService();
    this.initializeProviders();
    this.startLimitResetTimer();
    this.startCacheCleanup();
    this.logger.info(`🔥 QuickNodeWebhookManager: ПОЛНОСТЬЮ ИСПРАВЛЕН - ПРОТОКОЛ "ЖЕЛЕЗНЫЙ ДОЛЛАР" + ПРАВИЛЬНОЕ ИЗВЛЕЧЕНИЕ БАЛАНСОВ`);
  }

  setTelegramNotifier(telegramNotifier: TelegramNotifier): void {
    this.telegramNotifier = telegramNotifier;
    this.logger.info('TelegramNotifier set for QuickNode');
  }

  private initializeProviders(): void {
    const providers: RpcProvider[] = [];

    if (process.env.QUICKNODE_HTTP_URL && process.env.QUICKNODE_API_KEY) {
      providers.push({
        name: 'QuickNode-Primary', url: process.env.QUICKNODE_HTTP_URL, key: process.env.QUICKNODE_API_KEY,
        isHealthy: true, requestCount: 0, errorCount: 0, type: 'quicknode', priority: 5
      });
    }

    if (process.env.QUICKNODE_HTTP_URL_2 && process.env.QUICKNODE_API_KEY_2) {
      providers.push({
        name: 'QuickNode-Secondary', url: process.env.QUICKNODE_HTTP_URL_2, key: process.env.QUICKNODE_API_KEY_2,
        isHealthy: true, requestCount: 0, errorCount: 0, type: 'quicknode', priority: 4
      });
    }

    if (process.env.ALCHEMY_HTTP_URL && process.env.ALCHEMY_API_KEY) {
      providers.push({
        name: 'Alchemy-Enhanced', url: process.env.ALCHEMY_HTTP_URL, key: process.env.ALCHEMY_API_KEY,
        isHealthy: true, requestCount: 0, errorCount: 0, type: 'alchemy', priority: 5
      });
    }

    this.providers = providers.sort((a, b) => b.priority - a.priority);
    this.logger.info(`Initialized ${this.providers.length} RPC providers`);
  }

  setDependencies(smDatabase: SmartMoneyDatabase, telegramNotifier: TelegramNotifier): void {
    this.smDatabase = smDatabase;
    this.telegramNotifier = telegramNotifier;
    this.logger.info('QuickNode dependencies set');
  }

  private startLimitResetTimer(): void {
    setInterval(() => {
      const now = Date.now();
      if (now >= this.apiLimits.minuteReset) {
        this.apiLimits.currentMinuteRequests = 0;
        this.apiLimits.minuteReset = now + 60000;
      }
      if (now >= this.apiLimits.dayReset) {
        this.apiLimits.currentDayRequests = 0;
        this.apiLimits.dayReset = now + 24 * 60 * 60 * 1000;
      }
    }, 10000);
  }

  private startCacheCleanup(): void {
    setInterval(() => {
      const now = Date.now();
      const ONE_HOUR = 60 * 60 * 1000;
      
      for (const [key, value] of this.tokenInfoCache.entries()) {
        if (now - value.timestamp > ONE_HOUR) this.tokenInfoCache.delete(key);
      }
      for (const [key, value] of this.priceCache.entries()) {
        if (now - value.timestamp > 5 * 60 * 1000) this.priceCache.delete(key);
      }
      for (const [key, value] of this.addressCache.entries()) {
        if (now - value.timestamp > 30 * 60 * 1000) this.addressCache.delete(key);
      }
      
      if (this.recentSignatures.size > 1000 && now - this.lastCleanupTime > 10 * 60 * 1000) {
        this.recentSignatures.clear();
        this.lastCleanupTime = now;
        this.logger.debug('Simple signature cleanup performed');
      }
    }, 5 * 60 * 1000);
  }

  private getCurrentProvider(): RpcProvider | null {
    const healthyProviders = this.providers.filter(p => p.isHealthy);
    if (healthyProviders.length === 0) {
      this.logger.warn('No healthy providers available');
      return null;
    }

    if (this.currentProviderIndex >= healthyProviders.length) this.currentProviderIndex = 0;
    const provider = healthyProviders[this.currentProviderIndex];
    this.currentProviderIndex = (this.currentProviderIndex + 1) % healthyProviders.length;
    return provider;
  }

  private markProviderUnhealthy(provider: RpcProvider, error: string): void {
    provider.isHealthy = false;
    provider.errorCount++;
    provider.lastError = error;
    provider.lastErrorTime = Date.now();
    
    this.logger.warn(`Provider ${provider.name} marked as unhealthy: ${error}`);
    setTimeout(() => {
      provider.isHealthy = true;
      this.logger.info(`Provider ${provider.name} restored to healthy status`);
    }, 5 * 60 * 1000);
  }

  private async makeRpcRequest(method: string, params: any[]): Promise<any> {
    const provider = this.getCurrentProvider();
    if (!provider) throw new Error('No healthy RPC providers available');

    const startTime = Date.now();
    
    try {
      const response = await fetch(provider.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Solana-Smart-Money-Bot/4.0-MultiProvider' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

      const data = await response.json();
      if ((data as any).error) throw new Error(`RPC Error: ${(data as any).error.message || 'Unknown RPC error'}`);

      const responseTime = Date.now() - startTime;
      this.trackProviderResponseTime(provider.name, responseTime);
      provider.requestCount++;
      return data;

    } catch (error) {
      this.errorStats.apiErrors++;
      this.errorStats.lastErrorTime = new Date();
      this.markProviderUnhealthy(provider, error instanceof Error ? error.message : 'Unknown error');
      throw error;
    }
  }

  private trackProviderResponseTime(providerName: string, responseTime: number): void {
    if (!this.providerResponseTimes.has(providerName)) {
      this.providerResponseTimes.set(providerName, []);
    }
    
    const times = this.providerResponseTimes.get(providerName)!;
    times.push(responseTime);
    if (times.length > 50) times.shift();
  }

  private canMakeRequest(): boolean {
    if (this.apiLimitMutex) return false;
    
    const now = Date.now();
    if (now >= this.apiLimits.minuteReset) {
      this.apiLimits.currentMinuteRequests = 0;
      this.apiLimits.minuteReset = now + 60000;
    }
    if (now >= this.apiLimits.dayReset) {
      this.apiLimits.currentDayRequests = 0;
      this.apiLimits.dayReset = now + 24 * 60 * 60 * 1000;
    }
    
    const minuteLimit = Math.floor(this.apiLimits.requestsPerMinute * 0.8);
    const dayLimit = Math.floor(this.apiLimits.requestsPerDay * 0.8);
    
    return this.apiLimits.currentMinuteRequests < minuteLimit && this.apiLimits.currentDayRequests < dayLimit;
  }
  
  private trackApiRequest(): void {
    this.apiLimitMutex = true;
    const now = Date.now();
    this.apiLimits.currentMinuteRequests++;
    this.apiLimits.currentDayRequests++;
    this.apiLimits.lastRequestTime = now;
    
    setTimeout(() => { this.apiLimitMutex = false; }, 10);
  }
  
  private logApiUsageWithProviderStats(): void {
    const minuteUsage = (this.apiLimits.currentMinuteRequests / this.apiLimits.requestsPerMinute * 100).toFixed(1);
    const dayUsage = (this.apiLimits.currentDayRequests / this.apiLimits.requestsPerDay * 100).toFixed(1);
    
    const currentProvider = this.getCurrentProvider();
    const healthyProviders = this.providers.filter(p => p.isHealthy).length;
    
    const syncEfficiency = this.syncStats.totalPollingCycles > 0 ? 
      ((this.syncStats.totalPollingCycles - this.syncStats.emptyListCycles) / this.syncStats.totalPollingCycles * 100).toFixed(1) : '100';
    
    this.logger.info(`API: ${minuteUsage}%/min, ${dayUsage}%/day | Provider: ${currentProvider?.name || 'None'} | Healthy: ${healthyProviders}/${this.providers.length} | Errors: ${this.errorStats.walletProcessingErrors} wallet, ${this.errorStats.apiErrors} API | Sync: ${syncEfficiency}% efficiency`);
  }

  async createSmartMoneyWebhook(webhookUrl: string): Promise<string> {
    try {
      this.logger.info('Creating Smart Money webhook...');

      if (!this.canMakeRequest()) {
        this.logger.warn('API limit reached, switching to polling mode');
        const smartWallets = await this.smDatabase.getAllActiveSmartWallets();
        this.logger.info(`FALLBACK: Fetched ${smartWallets.length} wallets from database for polling mode`);
        return await this.startPollingMode(smartWallets);
      }

      this.trackApiRequest();
      
      const streamConfig: QuickNodeStreamConfig = {
        name: 'Smart Money DEX Monitor',
        webhook_url: webhookUrl,
        filters: [{
          program_id: [
            '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', // Raydium
            'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',  // Jupiter
            '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'  // Raydium AMM
          ]
        }],
        region: 'us-east-1'
      };

      const response = await fetch(`${this.getApiBaseUrl()}/streams`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.providers[0]?.key || '',
          'User-Agent': 'Smart-Money-Bot/4.0'
        },
        body: JSON.stringify(streamConfig)
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);

      const responseData = await response.json();
      const streamResponse: QuickNodeStreamResponse = responseData as QuickNodeStreamResponse;
      this.logger.info(`Smart Money webhook created: ${streamResponse.id}`);
      
      return streamResponse.id;

    } catch (error) {
      this.logger.warn('Webhook creation failed, falling back to polling:', error);
      const smartWallets = await this.smDatabase.getAllActiveSmartWallets();
      this.logger.info(`FALLBACK: Fetched ${smartWallets.length} wallets from database for polling mode after webhook failure`);
      return await this.startPollingMode(smartWallets);
    }
  }

  private getApiBaseUrl(): string {
    const primaryProvider = this.providers[0];
    if (!primaryProvider) return '';
    
    const baseUrl = primaryProvider.url.replace(/\/$/, '');
    return baseUrl.replace(/\/rpc$/, '') + '/api/v1';
  }

  async deleteStream(streamId: string): Promise<void> {
    try {
      if (streamId === 'polling-mode') {
        this.stopPollingMode();
        return;
      }

      this.logger.info(`Deleting QuickNode stream: ${streamId}`);

      if (!this.canMakeRequest()) {
        this.logger.warn('Cannot delete stream - API limit reached');
        return;
      }

      this.trackApiRequest();
      const response = await fetch(`${this.getApiBaseUrl()}/streams/${streamId}`, {
        method: 'DELETE',
        headers: {
          'x-api-key': this.providers[0]?.key || '',
          'Authorization': `Bearer ${this.providers[0]?.key || ''}`,
          'User-Agent': 'Solana-Smart-Money-Bot/4.0-MultiProvider'
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
      }

      this.logger.info(`Stream deleted successfully: ${streamId}`);

    } catch (error) {
      this.logger.error('Error deleting stream:', error);
      throw error;
    }
  }

  async startPollingMode(smartWallets: SmartMoneyWallet[]): Promise<string> {
    try {
      console.log('=== POLLING MODE START ===');
      console.log(`Starting polling mode with ${smartWallets.length} wallets`);
      
      this.monitoredWallets = smartWallets;
      this.isPollingActive = true;
      
      this.syncStats.walletsFoundInLastUpdate = smartWallets.length;
      this.syncStats.lastWalletListUpdate = new Date();
      this.syncStats.walletListUpdates++;
      
      this.pollingInterval = setInterval(() => this.pollWalletsForTransactions(), this.POLLING_INTERVAL);
      
      await this.pollWalletsForTransactions();
      
      this.logger.info(`Polling mode activated for ${smartWallets.length} wallets`);
      return 'polling-mode';
      
    } catch (error) {
      this.logger.error('Error starting polling mode:', error);
      throw error;
    }
  }

  stopPollingMode(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    this.isPollingActive = false;
    this.logger.info('Polling mode stopped');
  }

  private async pollWalletsForTransactions(): Promise<void> {
    console.log('=== POLLING CYCLE START ===');
    console.log(`Time: ${new Date().toISOString()}`);
    console.log(`Polling active: ${this.isPollingActive}`);
    console.log(`Database connection: ${this.smDatabase ? 'OK' : 'NULL'}`);
    
    if (!this.isPollingActive || !this.smDatabase) {
      console.log('POLLING STOPPED: inactive or no database');
      return;
    }

    try {
      const previousCount = this.monitoredWallets.length;
      this.monitoredWallets = await this.smDatabase.getAllActiveSmartWallets();
      
      console.log(`Wallets loaded from database: ${this.monitoredWallets.length}`);
      if (this.monitoredWallets.length > 0) {
        console.log(`First 3 wallets: ${this.monitoredWallets.slice(0,3).map(w => w.address.slice(0,8)).join(', ')}`);
      }
      
      this.syncStats.totalPollingCycles++;
      this.syncStats.walletListUpdates++;
      this.syncStats.walletsFoundInLastUpdate = this.monitoredWallets.length;
      this.syncStats.lastWalletListUpdate = new Date();
      
      if (this.monitoredWallets.length !== previousCount) {
        console.log(`WALLET LIST UPDATED: ${previousCount} -> ${this.monitoredWallets.length}`);
        
        if (this.telegramNotifier && Math.abs(this.monitoredWallets.length - previousCount) >= 5) {
          await this.telegramNotifier.sendCycleLog(
            `Wallet List Auto-Update\n\n` +
            `Previous: ${previousCount}\n` +
            `Current: ${this.monitoredWallets.length}\n` +
            `Change: ${this.monitoredWallets.length - previousCount > 0 ? '+' : ''}${this.monitoredWallets.length - previousCount}\n` +
            `Auto-refresh working correctly!`
          );
        }
      }
      
    } catch (error) {
      console.log('CRITICAL: Failed to update wallet list from database:', error);
      this.errorStats.walletProcessingErrors++;
      return;
    }
    
    if (this.monitoredWallets.length === 0) {
      console.log('NO WALLETS TO MONITOR - waiting for next cycle');
      this.syncStats.emptyListCycles++;
      return;
    }

    console.log(`Starting wallet processing: ${this.monitoredWallets.length} wallets, ${this.CONCURRENT_WALLET_PROCESSING} concurrent`);
    
    const activeWallets = this.monitoredWallets;
    let totalProcessed = 0;
    let totalErrors = 0;

    for (let i = 0; i < activeWallets.length; i += this.CONCURRENT_WALLET_PROCESSING) {
      if (!this.isPollingActive) break;

      const walletSubBatch = activeWallets.slice(i, i + this.CONCURRENT_WALLET_PROCESSING);
      console.log(`Processing wallet batch ${Math.floor(i/this.CONCURRENT_WALLET_PROCESSING) + 1}: [${walletSubBatch.map(w => w.address.slice(0,6)).join(', ')}]`);

      const batchPromises = walletSubBatch.map(wallet => this.processWalletBatchSafely(wallet));
      const results = await Promise.allSettled(batchPromises);
      
      for (const result of results) {
        if (result.status === 'fulfilled') {
          totalProcessed++;
          if (result.value === 'error') totalErrors++;
        } else {
          totalErrors++;
          this.errorStats.walletProcessingErrors++;
          console.log(`CRITICAL: Wallet batch promise rejected: ${result.reason}`);
        }
      }

      if (i + this.CONCURRENT_WALLET_PROCESSING < activeWallets.length) {
        console.log(`Pausing ${this.DELAY_BETWEEN_WALLETS}ms between wallet batches...`);
        await this.sleep(this.DELAY_BETWEEN_WALLETS);
      }
    }
    
    console.log(`POLLING CYCLE COMPLETE: ${totalProcessed} processed, ${totalErrors} errors, ${activeWallets.length} total wallets`);
    this.logApiUsageWithProviderStats();
  }

  private async processWalletBatchSafely(wallet: SmartMoneyWallet): Promise<'success' | 'error'> {
    console.log(`--- Processing wallet: ${wallet.address.slice(0,8)} ---`);
    console.log(`Can make request: ${this.canMakeRequest()}`);
    
    try {
      if (!this.canMakeRequest()) {
        console.log(`API limit reached for wallet ${wallet.address.slice(0,8)}`);
        await this.sleep(10000);
        return 'error';
      }
      
      let signatures: Array<{signature: string; blockTime: number}> = [];
      try {
        signatures = await this.getWalletSignatures(wallet.address);
      } catch (error) {
        console.log(`Error getting signatures for ${wallet.address.slice(0, 8)}: ${error}`);
        return 'error';
      }
      
      console.log(`Wallet ${wallet.address.slice(0,8)}: found ${signatures.length} recent signatures`);
      
      if (signatures.length > 0) {
        let transactionErrors = 0;
        for (const sig of signatures) {
          try {
            await this.processWalletTransactionSafely(sig.signature, wallet);
            await this.sleep(this.DELAY_BETWEEN_TRANSACTIONS);
          } catch (error) {
            transactionErrors++;
            this.errorStats.transactionProcessingErrors++;
            console.log(`Error processing transaction ${sig.signature.slice(0, 12)} for ${wallet.address.slice(0, 8)}: ${error}`);
          }
        }
        
        if (transactionErrors > 0) {
          console.log(`Wallet ${wallet.address.slice(0, 8)}: ${transactionErrors}/${signatures.length} transactions failed`);
        }
      }
      
      await this.sleep(200);
      return 'success';
      
    } catch (error) {
      this.errorStats.walletProcessingErrors++;
      this.errorStats.lastErrorTime = new Date();
      console.log(`CRITICAL ERROR processing wallet ${wallet.address.slice(0, 8)}: ${error}`);
      await this.sleep(500);
      return 'error';
    }
  }

  private async processWalletTransactionSafely(signature: string, wallet: SmartMoneyWallet): Promise<void> {
    console.log(`Processing transaction: ${signature.slice(0,12)} for wallet: ${wallet.address.slice(0,8)}`);
    
    try {
      if (this.recentSignatures.has(signature)) {
        console.log(`Skipping duplicate transaction: ${signature.slice(0,12)}`);
        return;
      }
      this.recentSignatures.add(signature);

      if (!this.canMakeRequest()) return;

      this.trackApiRequest();
      
      let transaction: any = null;
      try {
        transaction = await this.getTransactionDetails(signature);
      } catch (error) {
        console.log(`Error getting transaction details for ${signature.slice(0, 12)}: ${error}`);
        return;
      }
      
      if (!transaction) {
        console.log(`No transaction details for ${signature.slice(0,12)}`);
        return;
      }
      
      console.log(`Transaction details received for ${signature.slice(0,12)}, processing swaps...`);

      if (!this.isTransactionRecentAndValid(transaction)) {
        const transactionAge = this.getTransactionAge(transaction);
        console.log(`Skipping old/invalid transaction: ${signature.slice(0, 12)} (age: ${transactionAge})`);
        return;
      }

      // 🔥🔥🔥 ИСПОЛЬЗУЕМ УНИВЕРСАЛЬНУЮ ФУНКЦИЮ ИЗВЛЕЧЕНИЯ СВАПОВ 🔥🔥🔥
      const swapInfo = await this.extractSwapInfoFromBalances(transaction);
      if (!swapInfo) {
        console.log(`No valid swap found in transaction ${signature.slice(0,12)}`);
        return;
      }

      console.log(`🎯 Perfect swap detected: ${swapInfo.inputMint.slice(0,8)}... → ${swapInfo.outputMint.slice(0,8)}...`);

      // Вызываем единый расчетный центр
      const valueCalculation = await this.tokenMetadataService.calculateSwapUSDValue(
        swapInfo.inputMint, swapInfo.inputAmountRaw, swapInfo.outputMint, swapInfo.outputAmountRaw
      );

      if (!valueCalculation) {
        console.log(`❌ Value calculation FAILED - swap filtered out by unified calculator`);
        return;
      }

      const { amountUSD, swapType, tokenAddress, paymentToken, paymentTokenAmount, paymentTokenPrice } = valueCalculation;

      console.log(`✅ Value calculation SUCCESS: $${amountUSD.toFixed(2)} ${swapType}`);

      if (amountUSD >= 2000) {
        const tokenInfo = await this.getTokenInfoCached(tokenAddress);
        const paymentTokenInfo = await this.getTokenInfoCached(paymentToken);

        // Получаем правильное количество основного токена
        const actualTokenAmount = swapType === 'buy' ? 
          swapInfo.outputAmountRaw / Math.pow(10, tokenInfo.decimals) :
          swapInfo.inputAmountRaw / Math.pow(10, tokenInfo.decimals);

        // Формируем объект SmartMoneySwap
        const smartMoneySwap: SmartMoneySwap = {
          transactionId: signature,
          walletAddress: wallet.address,
          tokenAddress,
          tokenSymbol: tokenInfo.symbol,
          tokenName: tokenInfo.name,
          tokenAmount: actualTokenAmount,
          amountUSD,
          swapType,
          timestamp: new Date(transaction.blockTime * 1000),
          category: wallet.category,
          usdProfit7d: wallet.usdProfit7d,
          winrate7d: wallet.winrate7d,
          buy7d: wallet.buy7d,
          tokenPrice: actualTokenAmount > 0 ? amountUSD / actualTokenAmount : 0,
          paymentTokenSymbol: paymentTokenInfo.symbol,
          paymentTokenAmount: paymentTokenAmount,
          paymentTokenPrice: paymentTokenPrice,
          isFamilyMember: false,
        };

        console.log(`🎉 SWAP CREATED: ${tokenInfo.symbol} - $${amountUSD.toFixed(2)} - ${swapType}`);
        await this.saveAndNotifySwap(smartMoneySwap);
        console.log(`🚀 SWAP NOTIFICATION SENT: ${smartMoneySwap.tokenSymbol} - $${smartMoneySwap.amountUSD.toFixed(0)}`);
      } else {
        console.log(`💸 Swap below $2000 threshold: $${amountUSD.toFixed(2)}`);
      }

    } catch (error) {
      this.errorStats.transactionProcessingErrors++;
      console.log(`CRITICAL ERROR processing transaction ${signature.slice(0, 12)}: ${error}`);
      throw error;
    }
  }

  // 🔥🔥🔥 УНИВЕРСАЛЬНАЯ ФУНКЦИЯ ИЗВЛЕЧЕНИЯ СВАПОВ - ФИНАЛЬНАЯ ВЕРСИЯ 🔥🔥🔥
  private async extractSwapInfoFromBalances(txData: any): Promise<{
    walletAddress: string; inputMint: string; outputMint: string;
    inputAmountRaw: number; outputAmountRaw: number;
  } | null> {
    try {
      // В QuickNodeWebhookManager txData - это уже объект транзакции
      const transaction = txData;
      
      if (!transaction?.meta) return null;

      const preTokenBalances = transaction.meta.preTokenBalances || [];
      const postTokenBalances = transaction.meta.postTokenBalances || [];
      
      // 🔥 ИСПРАВЛЕНИЕ №1: Правильный путь к accountKeys
      const accountKeys = transaction.transaction?.message?.accountKeys || [];
      const walletAddress = this.extractWalletAddressFromTransaction(transaction);

      if (!walletAddress) return null;

      const tokenChanges = new Map<string, { change: number, mint: string, decimals: number }>();

      // Анализ существующих токен-аккаунтов
      for (const pre of preTokenBalances) {
      if (pre.owner !== walletAddress) continue;
      const post = postTokenBalances.find(p => p.accountIndex === pre.accountIndex);
  
      // 🔥 ИСПРАВЛЕНИЕ: Правильное извлечение UI amount vs raw amount
      const preAmount = parseFloat(pre.uiTokenAmount.uiAmountString || pre.uiTokenAmount.uiAmount?.toString() || '0');
      const postAmount = post ? parseFloat(post.uiTokenAmount.uiAmountString || post.uiTokenAmount.uiAmount?.toString() || '0') : 0;
      const change = postAmount - preAmount;
  
      console.log(`🔍 TOKEN DEBUG: ${pre.mint.slice(0,8)}, pre=${preAmount}, post=${postAmount}, change=${change}, decimals=${pre.uiTokenAmount.decimals}`);
  
      if (Math.abs(change) > 1e-9) {
        console.log(`📊 Existing token change: ${pre.mint.slice(0,8)}... = ${change}`);
        tokenChanges.set(pre.mint, { change, mint: pre.mint, decimals: pre.uiTokenAmount.decimals });
      }
    }

      // 🔥 ИСПРАВЛЕНИЕ №2: Анализ НОВЫХ токен-аккаунтов
      for (const post of postTokenBalances) {
        if (post.owner !== walletAddress || tokenChanges.has(post.mint)) continue;
      const isNewAccount = !preTokenBalances.find(p => p.accountIndex === post.accountIndex);
        if (isNewAccount) {
        // 🔥 ИСПРАВЛЕНО: используем UI amount вместо raw amount
      const change = parseFloat(post.uiTokenAmount.uiAmountString || post.uiTokenAmount.uiAmount?.toString() || '0');
      console.log(`🔍 NEW TOKEN DEBUG: ${post.mint.slice(0,8)}, change=${change}, decimals=${post.uiTokenAmount.decimals}`);
        if (change > 1e-9) {
      console.log(`🆕 New token account: ${post.mint.slice(0,8)}... = ${change}`);
      tokenChanges.set(post.mint, { change, mint: post.mint, decimals: post.uiTokenAmount.decimals });
        }
      }
    }

      // Анализ нативного SOL
      const walletIndex = accountKeys.findIndex((key: any) => (key.pubkey || key) === walletAddress);
      if (walletIndex !== -1 && transaction.meta.preBalances && transaction.meta.postBalances) {
        const solChange = (transaction.meta.postBalances[walletIndex] - transaction.meta.preBalances[walletIndex]) / 1e9;
        if (Math.abs(solChange) > 1e-9) {
          console.log(`💰 NATIVE SOL CHANGE: ${solChange} SOL`);
          tokenChanges.set('So11111111111111111111111111111111111111112', {
            change: solChange,
            mint: 'So11111111111111111111111111111111111111112',
            decimals: 9
          });
        }
      }

      const spentTokens = Array.from(tokenChanges.values()).filter(c => c.change < 0);
      const receivedTokens = Array.from(tokenChanges.values()).filter(c => c.change > 0);

      console.log(`🔄 Balance changes: ${tokenChanges.size} total, ${spentTokens.length} spent, ${receivedTokens.length} received`);

      if (spentTokens.length === 1 && receivedTokens.length === 1) {
        const inputMint = spentTokens[0].mint;
        const outputMint = receivedTokens[0].mint;
        const inputAmountRaw = Math.abs(spentTokens[0].change) * Math.pow(10, spentTokens[0].decimals);
        const outputAmountRaw = receivedTokens[0].change * Math.pow(10, receivedTokens[0].decimals);

        console.log(`🎯 Perfect swap: ${inputMint.slice(0,8)}... → ${outputMint.slice(0,8)}...`);
        return { walletAddress, inputMint, outputMint, inputAmountRaw, outputAmountRaw };
      }

      console.log(`⚠️ Complex or invalid swap: ${spentTokens.length} spent, ${receivedTokens.length} received`);
      return null;

    } catch (error) {
      console.log(`❌ Error extracting swap from balances: ${error}`);
      return null;
    }
  }

  private async getWalletSignatures(walletAddress: string): Promise<Array<{signature: string; blockTime: number}>> {
    console.log(`Getting signatures for wallet: ${walletAddress.slice(0,8)}`);
    
    try {
      const params: any = [
        walletAddress,
        { 
          limit: this.SIGNATURES_LIMIT, 
          commitment: 'confirmed'
        }
      ];

      const data = await this.makeRpcRequest('getSignaturesForAddress', params);
      const signatures = data.result || [];
      
      console.log(`Raw signatures received: ${signatures.length}`);
      
      // 🔥 ИСПРАВЛЕНО: Увеличен временной фильтр до 24 часов
      const twentyFourHoursAgo = Math.floor(Date.now() / 1000) - (24 * 60 * 60);
      const recentSignatures = signatures.filter((sig: any) => sig.blockTime > twentyFourHoursAgo);
      
      console.log(`After time filter (24h): ${recentSignatures.length}`);
      console.log(`Filter timestamp: ${twentyFourHoursAgo}, current: ${Math.floor(Date.now() / 1000)}`);
      
      if (signatures.length > 0) {
        const latestTime = signatures[0].blockTime;
        const currentTime = Math.floor(Date.now() / 1000);
        const timeDiff = currentTime - latestTime;
        console.log(`Latest signature time: ${latestTime}, current: ${currentTime}, diff: ${timeDiff} seconds ago`);
      }
      
      return recentSignatures;

    } catch (error) {
      console.log(`Error getting signatures for ${walletAddress}: ${error}`);
      return [];
    }
  }

  private async getTransactionDetails(signature: string): Promise<any> {
    try {
      const data = await this.makeRpcRequest('getTransaction', [
        signature,
        { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }
      ]);
      return data.result;
    } catch (error) {
      this.logger.error(`Error getting transaction details for ${signature}:`, error);
      return null;
    }
  }

  // 🔥🔥🔥 ИСПРАВЛЕНО: Простая и надежная проверка времени с Math.abs()
  private isTransactionRecentAndValid(transaction: any): boolean {
    if (!transaction || !transaction.blockTime) return false;
    
    const transactionTime = transaction.blockTime * 1000;
    const now = Date.now();
    const timeDifference = now - transactionTime;
    const maxAge = 24 * 60 * 60 * 1000; // 24 часа
    
    // 🔥 ЕДИНСТВЕННАЯ НАДЕЖНАЯ ПРОВЕРКА: используем Math.abs() для защиты от рассинхронизации
    const absoluteTimeDifference = Math.abs(timeDifference);
    
    if (absoluteTimeDifference > maxAge) {
      this.logger.debug(`Transaction too old (${this.formatTimeDiff(timeDifference)} ago)`);
      return false;
    }
    
    if (!transaction.meta || transaction.meta.err) {
      this.logger.debug(`Invalid transaction: Has errors or missing meta`);
      return false;
    }
    
    return true;
  }

  private formatTimeDiff(ms: number): string {
    const minutes = Math.floor(ms / (1000 * 60));
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    return `${minutes}m`;
  }

  private getTransactionAge(transaction: any): string {
    if (!transaction || !transaction.blockTime) return 'unknown';
    
    const transactionTime = transaction.blockTime * 1000;
    const now = Date.now();
    const ageMs = now - transactionTime;
    
    const ageMinutes = Math.floor(ageMs / (1000 * 60));
    const ageHours = Math.floor(ageMinutes / 60);
    const ageDays = Math.floor(ageHours / 24);
    
    if (ageDays > 0) return `${ageDays}d`;
    if (ageHours > 0) return `${ageHours}h`;
    return `${ageMinutes}m`;
  }

  // 🔥🔥🔥 ИСПРАВЛЕНО: Правильное извлечение адреса кошелька с правильным приоритетом
  private extractWalletAddressFromTransaction(txData: any): string | null {
    // 🔥 ПРАВИЛЬНЫЙ ПОРЯДОК ПРИОРИТЕТОВ:
    // 1. feePayer (наиболее надежный - это всегда кошелек пользователя)
    if (txData.feePayer) return txData.feePayer;
    
    // 2. Из балансов - берем первого owner (это реальный кошелек пользователя)
    if (txData.meta?.preTokenBalances?.[0]?.owner) return txData.meta.preTokenBalances[0].owner;
    if (txData.meta?.postTokenBalances?.[0]?.owner) return txData.meta.postTokenBalances[0].owner;
    
    // 3. ТОЛЬКО В КРАЙНЕМ СЛУЧАЕ: первый accountKey (может быть программой!)
    if (txData.transaction?.message?.accountKeys?.[0]) return txData.transaction.message.accountKeys[0];
    
    return null;
  }

  private getDefaultDecimals(tokenMint: string): number {
    // 🔥 УСТРАНЯЕМ ДУБЛИРОВАНИЕ - используем TokenMetadataService
    return this.tokenMetadataService.getTokenSymbol(tokenMint) === 'USDC' || 
           this.tokenMetadataService.getTokenSymbol(tokenMint) === 'USDT' ? 6 : 9;
  }

  private async getTokenInfoCached(tokenMint: string): Promise<{ symbol: string; name: string; decimals: number }> {
    const cached = this.tokenInfoCache.get(tokenMint);
    if (cached && Date.now() - cached.timestamp < 60 * 60 * 1000) {
      return { symbol: cached.symbol, name: cached.name, decimals: cached.decimals };
    }

    try {
      const metadata = await this.tokenMetadataService.getTokenMetadata(tokenMint);
      
      const tokenInfo = {
        symbol: metadata?.symbol || this.tokenMetadataService.getTokenSymbol(tokenMint),
        name: metadata?.name || 'Unknown Token',
        decimals: metadata?.decimals || this.getDefaultDecimals(tokenMint),
        timestamp: Date.now()
      };
      
      this.tokenInfoCache.set(tokenMint, tokenInfo);
      return { symbol: tokenInfo.symbol, name: tokenInfo.name, decimals: tokenInfo.decimals };

    } catch (error) {
      this.logger.error(`Error getting token info for ${tokenMint}:`, error);
      return { 
        symbol: this.tokenMetadataService.getTokenSymbol(tokenMint), 
        name: 'Unknown Token',
        decimals: this.getDefaultDecimals(tokenMint)
      };
    }
  }

  private async saveAndNotifySwap(swap: SmartMoneySwap): Promise<void> {
    console.log(`Saving and notifying swap: ${swap.tokenSymbol} - $${swap.amountUSD.toFixed(2)}`);
    
    try {
      if (!this.telegramNotifier) {
        console.log(`No telegram notifier available for swap notification`);
        return;
      }

      await this.smDatabase.saveSmartMoneyTransaction({
        transactionId: swap.transactionId,
        walletAddress: swap.walletAddress,
        tokenAddress: swap.tokenAddress,
        tokenSymbol: swap.tokenSymbol,
        tokenName: swap.tokenName,
        tokenAmount: swap.tokenAmount,
        amountUSD: swap.amountUSD,
        swapType: swap.swapType,
        timestamp: swap.timestamp,
        category: swap.category,
        
        usdProfit7d: swap.usdProfit7d,
        winrate7d: swap.winrate7d,
        buy7d: swap.buy7d,
        
        dex: 'Multi-Provider'
      });

      console.log(`Swap saved to database, sending Telegram notification...`);
      await this.telegramNotifier.sendSmartMoneySwapAlert(swap);
      console.log(`Telegram notification sent successfully`);
      
      this.errorStats.recoveredFromErrors++;

    } catch (error) {
      console.log(`Error saving and notifying swap: ${error}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getProviderStats(): ProviderStats[] {
    return this.providers.map(provider => {
      const responseTimes = this.providerResponseTimes.get(provider.name) || [];
      const avgResponseTime = responseTimes.length > 0 
        ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length 
        : 0;
      
      const successRate = provider.requestCount > 0 
        ? ((provider.requestCount - provider.errorCount) / provider.requestCount * 100)
        : 100;

      return {
        name: provider.name,
        type: provider.type,
        requestCount: provider.requestCount,
        errorCount: provider.errorCount,
        successRate: parseFloat(successRate.toFixed(2)),
        avgResponseTime: parseFloat(avgResponseTime.toFixed(2)),
        isHealthy: provider.isHealthy,
        priority: provider.priority
      };
    });
  }

  getApiLimitStats(): { 
    minuteUsage: string; 
    dayUsage: string; 
    canMakeRequest: boolean; 
    nextMinuteReset: string; 
    nextDayReset: string; 
  } {
    const minuteUsage = (this.apiLimits.currentMinuteRequests / this.apiLimits.requestsPerMinute * 100).toFixed(1);
    const dayUsage = (this.apiLimits.currentDayRequests / this.apiLimits.requestsPerDay * 100).toFixed(1);
    
    return {
      minuteUsage: minuteUsage + '%',
      dayUsage: dayUsage + '%',
      canMakeRequest: this.canMakeRequest(),
      nextMinuteReset: new Date(this.apiLimits.minuteReset).toLocaleTimeString(),
      nextDayReset: new Date(this.apiLimits.dayReset).toLocaleTimeString()
    };
  }

  getErrorStats(): {
    walletProcessingErrors: number;
    transactionProcessingErrors: number;
    apiErrors: number;
    lastErrorTime: string;
    recoveredFromErrors: number;
    errorRate: string;
  } {
    const totalAttempts = this.errorStats.walletProcessingErrors + this.errorStats.transactionProcessingErrors + this.errorStats.recoveredFromErrors;
    const errorRate = totalAttempts > 0 ? 
      (((this.errorStats.walletProcessingErrors + this.errorStats.transactionProcessingErrors) / totalAttempts) * 100).toFixed(2) + '%' : '0%';
    
    return {
      walletProcessingErrors: this.errorStats.walletProcessingErrors,
      transactionProcessingErrors: this.errorStats.transactionProcessingErrors,
      apiErrors: this.errorStats.apiErrors,
      lastErrorTime: this.errorStats.lastErrorTime.toISOString(),
      recoveredFromErrors: this.errorStats.recoveredFromErrors,
      errorRate
    };
  }

  getSyncStats(): {
    walletListUpdates: number;
    lastWalletListUpdate: string;
    walletsFoundInLastUpdate: number;
    totalPollingCycles: number;
    emptyListCycles: number;
    syncEfficiency: string;
    isHealthy: boolean;
  } {
    const syncEfficiency = this.syncStats.totalPollingCycles > 0 ? 
      ((this.syncStats.totalPollingCycles - this.syncStats.emptyListCycles) / this.syncStats.totalPollingCycles * 100).toFixed(1) + '%' : '100%';
    
    const isHealthy = this.syncStats.emptyListCycles / Math.max(this.syncStats.totalPollingCycles, 1) < 0.5;
    
    return {
      walletListUpdates: this.syncStats.walletListUpdates,
      lastWalletListUpdate: this.syncStats.lastWalletListUpdate.toISOString(),
      walletsFoundInLastUpdate: this.syncStats.walletsFoundInLastUpdate,
      totalPollingCycles: this.syncStats.totalPollingCycles,
      emptyListCycles: this.syncStats.emptyListCycles,
      syncEfficiency,
      isHealthy
    };
  }

  getPollingStats(): {
    isActive: boolean;
    walletsMonitored: number;
    lastProcessedSignatures: number;
    recentSignatures: number;
    botStartTime: string;
    pollingInterval: string;
    maxWalletsPerBatch: number;
    signaturesLimit: number;
    concurrentWalletProcessing: number;
    delayBetweenWallets: number;
    delayBetweenTransactions: number;
    errorStats: any;
    syncStats: any;
  } {
    return {
      isActive: this.isPollingActive,
      walletsMonitored: this.monitoredWallets.length,
      lastProcessedSignatures: this.lastProcessedSignatures.size,
      recentSignatures: this.recentSignatures.size,
      botStartTime: new Date(this.botStartTime).toISOString(),
      pollingInterval: `${this.POLLING_INTERVAL/60000}min`,
      maxWalletsPerBatch: this.MAX_WALLETS_PER_BATCH,
      signaturesLimit: this.SIGNATURES_LIMIT,
      concurrentWalletProcessing: this.CONCURRENT_WALLET_PROCESSING,
      delayBetweenWallets: this.DELAY_BETWEEN_WALLETS,
      delayBetweenTransactions: this.DELAY_BETWEEN_TRANSACTIONS,
      errorStats: this.getErrorStats(),
      syncStats: this.getSyncStats()
    };
  }
}