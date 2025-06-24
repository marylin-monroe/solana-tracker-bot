// src/services/QuickNodeWebhookManager.ts - 🔥 API OPTIMIZED: 2min intervals, 20 batch wallets, 3 signatures
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
  
  private smDatabase: SmartMoneyDatabase | null = null;
  private telegramNotifier: TelegramNotifier | null = null;
  private tokenMetadataService: TokenMetadataService;
  
  // 🔥 ОПТИМИЗИРОВАННЫЕ КОНСТАНТЫ
  private readonly POLLING_INTERVAL = 2 * 60 * 1000; // 2 минуты (было 1 минута)
  private readonly MAX_WALLETS_PER_BATCH = 20; // максимум 20 кошельков за раз
  private readonly SIGNATURES_LIMIT = 3; // только 3 последние транзакции (было 5)
  
  private isPollingActive: boolean = false;
  private pollingInterval: NodeJS.Timeout | null = null;
  private lastProcessedSignatures = new Map<string, string>();
  private monitoredWallets: SmartMoneyWallet[] = [];
  
  private recentSignatures = new Set<string>();
  private lastCleanupTime = Date.now();
  private botStartTime = Date.now();
  
  // Кеши
  private tokenInfoCache = new Map<string, { symbol: string; name: string; decimals: number; timestamp: number; price?: number; }>();
  private priceCache = new Map<string, { priceUSD: number; timestamp: number; }>();
  private addressCache = new Map<string, { hasSwap: boolean; timestamp: number; }>();
  
  private apiLimitMutex: boolean = false;
  private apiLimits: ApiLimits = {
    requestsPerMinute: 100, requestsPerDay: 50000, currentMinuteRequests: 0, currentDayRequests: 0,
    minuteReset: Date.now() + 60000, dayReset: Date.now() + 24 * 60 * 60 * 1000, lastRequestTime: 0
  };

  constructor() {
    this.logger = Logger.getInstance();
    this.tokenMetadataService = new TokenMetadataService();
    this.initializeProviders();
    this.startLimitResetTimer();
    this.startCacheCleanup();
    this.logger.info('🔥 QuickNodeWebhookManager optimized: 2min intervals, 20 batch wallets, 3 signatures');
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
    this.logger.info(`🚀 Initialized ${this.providers.length} RPC providers`);
  }

  setDependencies(smDatabase: SmartMoneyDatabase, telegramNotifier: TelegramNotifier): void {
    this.smDatabase = smDatabase;
    this.telegramNotifier = telegramNotifier;
    this.logger.info('✅ QuickNode dependencies set');
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
        this.logger.debug('🧹 Simple signature cleanup performed');
      }
    }, 5 * 60 * 1000);
  }

  private getCurrentProvider(): RpcProvider | null {
    const healthyProviders = this.providers.filter(p => p.isHealthy);
    if (healthyProviders.length === 0) {
      this.logger.warn('⚠️ No healthy providers available');
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
    
    this.logger.warn(`💔 Provider ${provider.name} marked as unhealthy`);
    setTimeout(() => {
      provider.isHealthy = true;
      this.logger.info(`✅ Provider ${provider.name} restored to healthy status`);
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
    
    this.logger.info(`📊 API Usage: ${minuteUsage}% minute, ${dayUsage}% daily | Provider: ${currentProvider?.name || 'None'} | Healthy: ${healthyProviders}/${this.providers.length}`);
  }

  async createSmartMoneyWebhook(webhookUrl: string): Promise<string> {
    try {
      this.logger.info('🎯 Creating Smart Money webhook...');

      if (!this.canMakeRequest()) {
        this.logger.warn('⚠️ API limit reached, switching to polling mode');
        const smartWallets = await this.smDatabase?.getAllActiveSmartWallets() || [];
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
      this.logger.info(`✅ Smart Money webhook created: ${streamResponse.id}`);
      
      return streamResponse.id;

    } catch (error) {
      this.logger.warn('⚠️ Webhook creation failed, falling back to polling:', error);
      const smartWallets = await this.smDatabase?.getAllActiveSmartWallets() || [];
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

      this.logger.info(`🗑️ Deleting QuickNode stream: ${streamId}`);

      if (!this.canMakeRequest()) {
        this.logger.warn('⚠️ Cannot delete stream - API limit reached');
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

      this.logger.info(`✅ Stream deleted successfully: ${streamId}`);

    } catch (error) {
      this.logger.error('❌ Error deleting stream:', error);
      throw error;
    }
  }

  // 🔥 OPTIMIZED POLLING MODE: 2 минуты интервал
  async startPollingMode(smartWallets: SmartMoneyWallet[]): Promise<string> {
    try {
      this.logger.info('🚀 Starting OPTIMIZED POLLING mode for Smart Money monitoring...');
      
      this.monitoredWallets = smartWallets;
      this.isPollingActive = true;
      
      this.pollingInterval = setInterval(() => this.pollWalletsForTransactions(), this.POLLING_INTERVAL);
      
      await this.pollWalletsForTransactions();
      
      this.logger.info(`✅ Optimized polling started for ${smartWallets.length} wallets (${this.POLLING_INTERVAL/1000}s interval)`);
      return 'polling-mode';
      
    } catch (error) {
      this.logger.error('❌ Error starting polling mode:', error);
      throw error;
    }
  }

  stopPollingMode(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    this.isPollingActive = false;
    this.logger.info('⏹️ Polling mode stopped');
  }

  // 🔥 БАТЧИНГ КОШЕЛЬКОВ: 20 за раз
  private async pollWalletsForTransactions(): Promise<void> {
    if (!this.isPollingActive) return;

    this.logger.info(`🔍 Polling ${this.monitoredWallets.length} Smart Money wallets in batches of ${this.MAX_WALLETS_PER_BATCH}...`);
    
    for (let i = 0; i < this.monitoredWallets.length; i += this.MAX_WALLETS_PER_BATCH) {
      if (!this.isPollingActive) break;
      
      const batch = this.monitoredWallets.slice(i, i + this.MAX_WALLETS_PER_BATCH);
      
      await Promise.allSettled(
        batch.map(wallet => this.processWalletBatch(wallet))
      );
      
      // Пауза между батчами
      if (i + this.MAX_WALLETS_PER_BATCH < this.monitoredWallets.length) {
        await this.sleep(2000); // 2 секунды между батчами
        this.logger.info(`📊 Processed batch ${Math.floor(i/this.MAX_WALLETS_PER_BATCH) + 1}/${Math.ceil(this.monitoredWallets.length/this.MAX_WALLETS_PER_BATCH)}`);
      }
    }
    
    this.logApiUsageWithProviderStats();
  }

  private async processWalletBatch(wallet: SmartMoneyWallet): Promise<void> {
    try {
      if (!this.canMakeRequest()) {
        this.logger.warn('⚠️ API limit reached, pausing wallet processing...');
        await this.sleep(30000);
        return;
      }
      
      const lastSignature = this.lastProcessedSignatures.get(wallet.address);
      const signatures = await this.getWalletSignatures(wallet.address, lastSignature);
      
      if (signatures.length > 0) {
        this.logger.info(`🔍 Processing ${signatures.length}/${this.SIGNATURES_LIMIT} recent transactions for ${wallet.address.slice(0, 8)}...`);
        
        this.lastProcessedSignatures.set(wallet.address, signatures[0].signature);
        
        for (const sig of signatures) {
          await this.processWalletTransaction(sig.signature, wallet);
          await this.sleep(200);
        }
      }
      
      await this.sleep(500);
      
    } catch (error) {
      this.logger.error(`Error processing wallet batch ${wallet.address}:`, error);
      await this.sleep(1000);
    }
  }

  // 🔥 УМЕНЬШЕННЫЙ ЛИМИТ СИГНАТУР: 3 вместо 5
  private async getWalletSignatures(walletAddress: string, beforeSignature?: string): Promise<Array<{signature: string; blockTime: number}>> {
    try {
      const params: any = [
        walletAddress,
        { limit: this.SIGNATURES_LIMIT, commitment: 'confirmed' }
      ];

      if (beforeSignature) params[1].before = beforeSignature;

      const data = await this.makeRpcRequest('getSignaturesForAddress', params);
      return data.result || [];

    } catch (error) {
      this.logger.error(`Error getting signatures for ${walletAddress}:`, error);
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

  private async processWalletTransaction(signature: string, wallet: SmartMoneyWallet): Promise<void> {
    try {
      if (this.recentSignatures.has(signature)) return;
      this.recentSignatures.add(signature);

      if (!this.canMakeRequest()) return;

      this.trackApiRequest();
      const transaction = await this.getTransactionDetails(signature);
      if (!transaction) return;

      if (!this.isTransactionRecentAndValid(transaction)) {
        const transactionAge = this.getTransactionAge(transaction);
        this.logger.debug(`⏰ Skipping old/invalid transaction: ${signature.slice(0, 12)}... (age: ${transactionAge})`);
        return;
      }

      const swaps = await this.extractSwapsFromTransaction(transaction, wallet);
      
      for (const swap of swaps) {
        if (this.shouldProcessSmartMoneySwapOptimized(swap, wallet)) {
          await this.saveAndNotifySwap(swap);
          this.logger.info(`🔥 SM swap: ${swap.tokenSymbol} - $${swap.amountUSD.toFixed(0)} (${this.getTransactionAge(transaction)}) ${swap.actualTokenAmount ? `| ACTUAL: ${swap.actualTokenAmount.toLocaleString()}` : ''}`);
        }
      }

    } catch (error) {
      this.logger.error(`Error processing transaction ${signature}:`, error);
    }
  }

  private isTransactionRecentAndValid(transaction: any): boolean {
    if (!transaction || !transaction.blockTime) return false;
    
    const transactionTime = transaction.blockTime * 1000;
    const now = Date.now();
    const timeSinceTransaction = now - transactionTime;
    const maxAge = 24 * 60 * 60 * 1000; // 24 часа
    
    if (timeSinceTransaction > maxAge) {
      this.logger.debug(`🚫 Transaction too old (${this.formatTimeDiff(timeSinceTransaction)} ago)`);
      return false;
    }
    
    if (!transaction.meta || transaction.meta.err) {
      this.logger.debug(`🚫 Invalid transaction: Has errors or missing meta`);
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

  // 🔥 ИСПРАВЛЕНО: правильный расчет USD с decimals + улучшенная логика
  private async extractSwapsFromTransaction(transaction: any, wallet: SmartMoneyWallet): Promise<SmartMoneySwap[]> {
    const swaps: SmartMoneySwap[] = [];

    try {
      if (!transaction || !transaction.meta || transaction.meta.err) return swaps;

      const preTokenBalances = transaction.meta.preTokenBalances || [];
      const postTokenBalances = transaction.meta.postTokenBalances || [];
      const blockTime = transaction.blockTime;

      for (const postBalance of postTokenBalances) {
        if (postBalance.owner !== wallet.address) continue;

        const preBalance = preTokenBalances.find((pre: any) => pre.accountIndex === postBalance.accountIndex);

        // 🔥 ИСПРАВЛЕНО: Используем правильное поле API
        const postRawAmount = parseFloat(postBalance.uiTokenAmount.amount || '0');
        const preRawAmount = preBalance ? parseFloat(preBalance.uiTokenAmount.amount || '0') : 0;
        const rawDifference = postRawAmount - preRawAmount;
        
        // 🔥 ИСПРАВЛЕНО: Правильные fallback decimals
        const tokenMint = postBalance.mint;
        const decimals = postBalance.uiTokenAmount.decimals || this.getDefaultDecimals(tokenMint);
        const actualDifference = rawDifference / Math.pow(10, decimals);

        if (Math.abs(actualDifference) < 1) continue;

        const [tokenInfo, tokenPrice] = await Promise.all([
          this.getTokenInfoCached(tokenMint),
          this.tokenMetadataService.getTokenPrice(tokenMint)
        ]);

        const swapType: 'buy' | 'sell' = actualDifference > 0 ? 'buy' : 'sell';
        const tokenAmount = Math.abs(actualDifference);
        
        const estimatedUSD = await this.estimateTokenValueUSDCached(tokenMint, tokenAmount, decimals);

        this.logger.info(`🔍 ${swapType.toUpperCase()} | ${tokenInfo.symbol} | RAW: ${Math.abs(rawDifference).toLocaleString()} | ACTUAL: ${tokenAmount.toLocaleString()} | USD: ${estimatedUSD.toLocaleString()}`);

        if (estimatedUSD > 5000) {
          swaps.push({
            transactionId: transaction.transaction.signatures[0],
            walletAddress: wallet.address,
            tokenAddress: tokenMint,
            tokenSymbol: tokenInfo.symbol,
            tokenName: tokenInfo.name,
            tokenAmount,
            amountUSD: estimatedUSD,
            swapType,
            timestamp: new Date(blockTime * 1000),
            category: wallet.category,
            winRate: wallet.winRate,
            pnl: wallet.totalPnL,
            totalTrades: wallet.totalTrades,
            tokenPrice: tokenPrice || undefined,
            isFamilyMember: false,
            familySize: 0,
            familyId: undefined,
            actualTokenAmount: tokenAmount,
            decimals: decimals
          });
        }
      }

    } catch (error) {
      this.logger.error('Error extracting swaps from transaction:', error);
    }

    return swaps;
  }

  private shouldProcessSmartMoneySwapOptimized(swap: SmartMoneySwap, wallet: SmartMoneyWallet): boolean {
    const minAmounts: Record<string, number> = { sniper: 8000, hunter: 10000, trader: 25000 };
    const minAmount = minAmounts[wallet.category] || 10000;
    if (swap.amountUSD < minAmount) return false;

    const daysSinceActive = (Date.now() - wallet.lastActiveAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceActive > 15) return false;
    if (wallet.winRate < 70) return false;
    if (wallet.performanceScore < 80) return false;

    return true;
  }

  // 🔥 ИСПРАВЛЕНО: добавлен метод getDefaultDecimals
  private getDefaultDecimals(tokenMint: string): number {
    if (tokenMint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') return 6; // USDC
    if (tokenMint === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') return 6; // USDT  
    return 9; // SOL и большинство других
  }

  private async getTokenInfoCached(tokenMint: string): Promise<{ symbol: string; name: string; decimals: number }> {
    const cached = this.tokenInfoCache.get(tokenMint);
    if (cached && Date.now() - cached.timestamp < 60 * 60 * 1000) {
      return { symbol: cached.symbol, name: cached.name, decimals: cached.decimals };
    }

    try {
      const metadata = await this.tokenMetadataService.getTokenMetadata(tokenMint);
      
      const tokenInfo = {
        symbol: metadata?.symbol || `${tokenMint.slice(0, 6).toUpperCase()}`,
        name: metadata?.name || 'Unknown Token',
        decimals: metadata?.decimals || this.getDefaultDecimals(tokenMint),
        timestamp: Date.now()
      };
      
      this.tokenInfoCache.set(tokenMint, tokenInfo);
      return { symbol: tokenInfo.symbol, name: tokenInfo.name, decimals: tokenInfo.decimals };

    } catch (error) {
      this.logger.error(`Error getting token info for ${tokenMint}:`, error);
      return { 
        symbol: `${tokenMint.slice(0, 6).toUpperCase()}`, 
        name: 'Unknown Token',
        decimals: this.getDefaultDecimals(tokenMint)
      };
    }
  }

  private async estimateTokenValueUSDCached(tokenMint: string, amount: number, decimals?: number): Promise<number> {
    const cached = this.priceCache.get(tokenMint);
    if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
      return cached.priceUSD * amount;
    }

    try {
      const tokenPrice = await this.tokenMetadataService.getTokenPrice(tokenMint);
      
      let estimatedPrice = tokenPrice || 1;
      
      if (!tokenPrice) {
        if (tokenMint === 'So11111111111111111111111111111111111111112') {
          estimatedPrice = 140; // SOL
        } else if (tokenMint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') {
          estimatedPrice = 1; // USDC
        } else if (tokenMint === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') {
          estimatedPrice = 1; // USDT
        } else {
          estimatedPrice = 0.001;
        }
      }
      
      this.priceCache.set(tokenMint, { priceUSD: estimatedPrice, timestamp: Date.now() });
      
      const estimatedUSD = estimatedPrice * amount;
      if (decimals) {
        this.logger.debug(`💰 Price: ${estimatedPrice} | Amount: ${amount.toLocaleString()} | Decimals: ${decimals} | USD: ${estimatedUSD.toLocaleString()}`);
      }
      
      return estimatedUSD;

    } catch (error) {
      this.logger.error(`Error estimating price for ${tokenMint}:`, error);
      return amount * 0.001;
    }
  }

  private async saveAndNotifySwap(swap: SmartMoneySwap): Promise<void> {
    try {
      if (!this.smDatabase || !this.telegramNotifier) return;

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
        winRate: swap.winRate,
        pnl: swap.pnl,
        totalTrades: swap.totalTrades,
        dex: 'Multi-Provider'
      });

      await this.telegramNotifier.sendSmartMoneySwapAlert(swap, 'QuickNodeWebhookManager');

    } catch (error) {
      this.logger.error('Error saving and notifying swap:', error);
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

  getPollingStats(): {
    isActive: boolean;
    walletsMonitored: number;
    lastProcessedSignatures: number;
    recentSignatures: number;
    botStartTime: string;
    pollingInterval: string;
    maxWalletsPerBatch: number;
    signaturesLimit: number;
  } {
    return {
      isActive: this.isPollingActive,
      walletsMonitored: this.monitoredWallets.length,
      lastProcessedSignatures: this.lastProcessedSignatures.size,
      recentSignatures: this.recentSignatures.size,
      botStartTime: new Date(this.botStartTime).toISOString(),
      pollingInterval: `${this.POLLING_INTERVAL/1000}s`,
      maxWalletsPerBatch: this.MAX_WALLETS_PER_BATCH,
      signaturesLimit: this.SIGNATURES_LIMIT
    };
  }
}