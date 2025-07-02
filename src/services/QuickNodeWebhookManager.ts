// src/services/QuickNodeWebhookManager.ts - 🔥 ИСПРАВЛЕНО: ПРАВИЛЬНЫЙ ВЫБОР ТОКЕНОВ ДЛЯ BUY/SELL
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
  private readonly SIGNATURES_LIMIT = 9; 
  
  private isPollingActive: boolean = false;
  private pollingInterval: NodeJS.Timeout | null = null;
  private lastProcessedSignatures = new Map<string, string>();
  private monitoredWallets: SmartMoneyWallet[] = [];
  
  private recentSignatures = new Set<string>();
  private lastCleanupTime = Date.now();
  private botStartTime = Date.now();
  
  // 🔥🔥🔥 PAYMENT TOKENS ДЛЯ ПРАВИЛЬНОГО ОПРЕДЕЛЕНИЯ BUY/SELL 🔥🔥🔥
  private readonly PAYMENT_TOKENS = new Set([
    'So11111111111111111111111111111111111111112', // SOL
    'So11111111111111111111111111111111111111111', // WSOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
    'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // JitoSOL
    '7Q2afV64in6N6SeZsAAB81TJzwDoD6zpqmHkzi9Dcavn', // stSOL
    'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', // bSOL
    'he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A'  // hSOL
  ]);
  
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
    this.logger.info('🔥 QuickNodeWebhookManager initialized with improved buy/sell detection');
  }

  setTelegramNotifier(telegramNotifier: TelegramNotifier): void {
    this.telegramNotifier = telegramNotifier;
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
  }

  setDependencies(smDatabase: SmartMoneyDatabase, telegramNotifier: TelegramNotifier): void {
    this.smDatabase = smDatabase;
    this.telegramNotifier = telegramNotifier;
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
  }

  async createSmartMoneyWebhook(webhookUrl: string): Promise<string> {
    try {
      if (!this.canMakeRequest()) {
        this.logger.warn('API limit reached, switching to polling mode');
        const smartWallets = await this.smDatabase.getAllActiveSmartWallets();
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
      
      return streamResponse.id;

    } catch (error) {
      this.logger.warn('Webhook creation failed, falling back to polling:', error);
      const smartWallets = await this.smDatabase.getAllActiveSmartWallets();
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

    } catch (error) {
      this.logger.error('Error deleting stream:', error);
      throw error;
    }
  }

  async startPollingMode(smartWallets: SmartMoneyWallet[]): Promise<string> {
    try {
      this.monitoredWallets = smartWallets;
      this.isPollingActive = true;
      
      this.syncStats.walletsFoundInLastUpdate = smartWallets.length;
      this.syncStats.lastWalletListUpdate = new Date();
      this.syncStats.walletListUpdates++;
      
      this.pollingInterval = setInterval(() => this.pollWalletsForTransactions(), this.POLLING_INTERVAL);
      
      await this.pollWalletsForTransactions();
      
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
  }

  private async pollWalletsForTransactions(): Promise<void> {
    if (!this.isPollingActive || !this.smDatabase) return;

    try {
      const previousCount = this.monitoredWallets.length;
      this.monitoredWallets = await this.smDatabase.getAllActiveSmartWallets();
      
      this.syncStats.totalPollingCycles++;
      this.syncStats.walletListUpdates++;
      this.syncStats.walletsFoundInLastUpdate = this.monitoredWallets.length;
      this.syncStats.lastWalletListUpdate = new Date();
      
      if (this.monitoredWallets.length !== previousCount) {
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
      this.errorStats.walletProcessingErrors++;
      return;
    }
    
    if (this.monitoredWallets.length === 0) {
      this.syncStats.emptyListCycles++;
      return;
    }

    const activeWallets = this.monitoredWallets;
    let totalProcessed = 0;
    let totalErrors = 0;

    for (let i = 0; i < activeWallets.length; i += this.CONCURRENT_WALLET_PROCESSING) {
      if (!this.isPollingActive) break;

      const walletSubBatch = activeWallets.slice(i, i + this.CONCURRENT_WALLET_PROCESSING);
      const batchPromises = walletSubBatch.map(wallet => this.processWalletBatchSafely(wallet));
      const results = await Promise.allSettled(batchPromises);
      
      for (const result of results) {
        if (result.status === 'fulfilled') {
          totalProcessed++;
          if (result.value === 'error') totalErrors++;
        } else {
          totalErrors++;
          this.errorStats.walletProcessingErrors++;
        }
      }

      if (i + this.CONCURRENT_WALLET_PROCESSING < activeWallets.length) {
        await this.sleep(this.DELAY_BETWEEN_WALLETS);
      }
    }
    
    this.logApiUsageWithProviderStats();
  }

  private async processWalletBatchSafely(wallet: SmartMoneyWallet): Promise<'success' | 'error'> {
    try {
      if (!this.canMakeRequest()) {
        await this.sleep(10000);
        return 'error';
      }
      
      let signatures: Array<{signature: string; blockTime: number}> = [];
      try {
        signatures = await this.getWalletSignatures(wallet.address);
      } catch (error) {
        return 'error';
      }
      
      if (signatures.length > 0) {
        let transactionErrors = 0;
        for (const sig of signatures) {
          try {
            await this.processWalletTransactionSafely(sig.signature, wallet);
            await this.sleep(this.DELAY_BETWEEN_TRANSACTIONS);
          } catch (error) {
            transactionErrors++;
            this.errorStats.transactionProcessingErrors++;
          }
        }
      }
      
      await this.sleep(200);
      return 'success';
      
    } catch (error) {
      this.errorStats.walletProcessingErrors++;
      this.errorStats.lastErrorTime = new Date();
      await this.sleep(500);
      return 'error';
    }
  }

  private async processWalletTransactionSafely(signature: string, wallet: SmartMoneyWallet): Promise<void> {
    try {
      if (this.recentSignatures.has(signature)) return;
      this.recentSignatures.add(signature);

      if (!this.canMakeRequest()) return;

      this.trackApiRequest();
      
      let transaction: any = null;
      try {
        transaction = await this.getTransactionDetails(signature);
      } catch (error) {
        return;
      }
      
      if (!transaction) return;
      
      if (!this.isTransactionRecentAndValid(transaction)) {
        return;
      }

      // 🔥🔥🔥 ИСПОЛЬЗУЕМ ИСПРАВЛЕННУЮ ФУНКЦИЮ ИЗВЛЕЧЕНИЯ СВАПОВ 🔥🔥🔥
      const swapInfo = await this.extractSwapInfoFromBalances(transaction);
      if (!swapInfo) return;

      // Вызываем единый расчетный центр
      const valueCalculation = await this.tokenMetadataService.calculateSwapUSDValue(
        swapInfo.inputMint, swapInfo.inputAmountRaw, swapInfo.outputMint, swapInfo.outputAmountRaw
      );

      if (!valueCalculation) return;

      const { amountUSD, swapType, tokenAddress, paymentToken, paymentTokenAmount, paymentTokenPrice } = valueCalculation;

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

        await this.saveAndNotifySwap(smartMoneySwap);
      }

    } catch (error) {
      this.errorStats.transactionProcessingErrors++;
      throw error;
    }
  }

  // 🔥🔥🔥 ИСПРАВЛЕНО: ПРАВИЛЬНЫЙ ВЫБОР ТОКЕНОВ ДЛЯ BUY/SELL 🔥🔥🔥
  private async extractSwapInfoFromBalances(txData: any): Promise<{
    walletAddress: string; inputMint: string; outputMint: string;
    inputAmountRaw: number; outputAmountRaw: number;
  } | null> {
    try {
      const transaction = txData;
      if (!transaction?.meta) return null;

      const preTokenBalances = transaction.meta.preTokenBalances || [];
      const postTokenBalances = transaction.meta.postTokenBalances || [];
      const walletAddress = this.extractWalletAddressFromTransaction(transaction);

      if (!walletAddress) return null;

      // 🔥 УНИФИЦИРОВАННАЯ СТРУКТУРА: используем changeRaw как в WebhookServer
      const tokenChanges = new Map<string, { changeUI: number, changeRaw: number, mint: string, decimals: number }>();

      // Анализ существующих токен-аккаунтов
      for (const pre of preTokenBalances) {
        if (pre.owner !== walletAddress) continue;
        
        const post = postTokenBalances.find(p => p.accountIndex === pre.accountIndex);
        
        const preAmountUI = parseFloat(pre.uiTokenAmount.uiAmountString || pre.uiTokenAmount.uiAmount?.toString() || '0');
        const postAmountUI = post ? parseFloat(post.uiTokenAmount.uiAmountString || post.uiTokenAmount.uiAmount?.toString() || '0') : 0;
        const changeUI = postAmountUI - preAmountUI;
        
        const preAmountRaw = parseInt(pre.uiTokenAmount.amount || '0');
        const postAmountRaw = post ? parseInt(post.uiTokenAmount.amount || '0') : 0;
        const changeRaw = postAmountRaw - preAmountRaw;
        
        if (Math.abs(changeUI) > 1e-9) {
          tokenChanges.set(pre.mint, { 
            changeUI, 
            changeRaw,
            mint: pre.mint, 
            decimals: pre.uiTokenAmount.decimals 
          });
        }
      }

      // Анализ НОВЫХ токен-аккаунтов
      for (const post of postTokenBalances) {
        if (post.owner !== walletAddress || tokenChanges.has(post.mint)) continue;
        
        const isNewAccount = !preTokenBalances.find(p => p.accountIndex === post.accountIndex);
        if (isNewAccount) {
          const changeUI = parseFloat(post.uiTokenAmount.uiAmountString || post.uiTokenAmount.uiAmount?.toString() || '0');
          const changeRaw = parseInt(post.uiTokenAmount.amount || '0');
          
          if (changeUI > 1e-9) {
            tokenChanges.set(post.mint, { 
              changeUI, 
              changeRaw,
              mint: post.mint, 
              decimals: post.uiTokenAmount.decimals 
            });
          }
        }
      }

      // Анализ изменений нативного SOL
      const accountKeys = transaction.transaction?.message?.accountKeys || [];
      const walletIndex = accountKeys.findIndex((key: any) => {
        const keyString = typeof key === 'string' ? key : key?.pubkey || key?.toString?.() || '';
        return keyString === walletAddress;
      });
      
      if (walletIndex !== -1 && transaction.meta?.preBalances && transaction.meta?.postBalances) {
        const preSolBalance = transaction.meta.preBalances[walletIndex] || 0;
        const postSolBalance = transaction.meta.postBalances[walletIndex] || 0;
        const solChangeRaw = postSolBalance - preSolBalance;
        const solChangeUI = solChangeRaw / 1e9;
        
        if (Math.abs(solChangeUI) > 0.01) {
          tokenChanges.set('So11111111111111111111111111111111111111112', {
            changeUI: solChangeUI,
            changeRaw: solChangeRaw,
            mint: 'So11111111111111111111111111111111111111112',
            decimals: 9
          });
        }
      }
      console.log(`\n🔍 ALL TOKEN CHANGES BEFORE FILTERING:`);
for (const [mint, change] of tokenChanges.entries()) {
  const symbol = this.tokenMetadataService.getTokenSymbol(mint);
  console.log(`${symbol} (${mint.slice(0,8)}...): ${change.changeUI > 0 ? '+' : ''}${change.changeUI} (raw: ${change.changeRaw})`);
}

      // 🔥 УНИФИЦИРОВАННАЯ ЛОГИКА: используем changeUI для фильтрации, changeRaw для расчетов
      const spentTokens = Array.from(tokenChanges.values()).filter(c => c.changeUI < 0);
      const receivedTokens = Array.from(tokenChanges.values()).filter(c => c.changeUI > 0);

      // 🔥🔥🔥 ПРАВИЛЬНАЯ ЛОГИКА: ИЩЕМ PAYMENT TOKEN ПАРУ 🔥🔥🔥
      if (spentTokens.length === 0 || receivedTokens.length === 0) {
        return null;
      }

      // 🚀 НОВАЯ ЛОГИКА: Ищем правильную пару токенов
      let inputMint: string | null = null;
      let outputMint: string | null = null;
      let inputAmountRaw = 0;
      let outputAmountRaw = 0;
      console.log(`🔍 SPENT TOKENS:`, spentTokens.map(t => this.tokenMetadataService.getTokenSymbol(t.mint)));
      console.log(`🔍 RECEIVED TOKENS:`, receivedTokens.map(t => this.tokenMetadataService.getTokenSymbol(t.mint)));
      console.log(`🔍 LOOKING FOR PAYMENT IN SPENT...`);

      // Ищем payment token в потраченных токенах
      const spentPaymentToken = spentTokens.find(token => this.PAYMENT_TOKENS.has(token.mint));
      
      if (spentPaymentToken) {
        // BUY: Тратим payment token -> получаем обычный токен
        const receivedNonPaymentToken = receivedTokens.find(token => !this.PAYMENT_TOKENS.has(token.mint));
        
        if (receivedNonPaymentToken) {
          inputMint = spentPaymentToken.mint;
          outputMint = receivedNonPaymentToken.mint;
          inputAmountRaw = Math.abs(spentPaymentToken.changeRaw);
          outputAmountRaw = receivedNonPaymentToken.changeRaw;
        }
      } else {
        // Ищем payment token в полученных токенах
        const receivedPaymentToken = receivedTokens.find(token => this.PAYMENT_TOKENS.has(token.mint));
        
        if (receivedPaymentToken) {
          // SELL: Тратим обычный токен -> получаем payment token
          const spentNonPaymentToken = spentTokens.find(token => !this.PAYMENT_TOKENS.has(token.mint));
          
          if (spentNonPaymentToken) {
            inputMint = spentNonPaymentToken.mint;
            outputMint = receivedPaymentToken.mint;
            inputAmountRaw = Math.abs(spentNonPaymentToken.changeRaw);
            outputAmountRaw = receivedPaymentToken.changeRaw;
          }
        }
      }

      // Если не нашли правильную пару - используем fallback (первые операции)
      if (!inputMint || !outputMint) {
        const spentToken = spentTokens[0];
        const receivedToken = receivedTokens[0];
        inputMint = receivedToken.mint;
        outputMint = spentToken.mint; 
        inputAmountRaw = Math.abs(spentToken.changeRaw);
        outputAmountRaw = receivedToken.changeRaw;
      }

      // 🔥🔥🔥 ДЕТАЛЬНАЯ ОТЛАДКА ДЛЯ АНАЛИЗА РЕЗУЛЬТАТА 🔥🔥🔥
      console.log(`\n🔍 [QuickNode] FINAL SWAP ANALYSIS FOR: ${transaction.signature?.slice(0,12)}...`);
      console.log(`💸 INPUT: ${this.tokenMetadataService.getTokenSymbol(inputMint)} (${inputMint.slice(0,8)}...) = ${inputAmountRaw}`);
      console.log(`💰 OUTPUT: ${this.tokenMetadataService.getTokenSymbol(outputMint)} (${outputMint.slice(0,8)}...) = ${outputAmountRaw}`);

      // Фильтрация технических операций (деньги в деньги)
      const inputIsPayment = this.PAYMENT_TOKENS.has(inputMint);
      const outputIsPayment = this.PAYMENT_TOKENS.has(outputMint);

      if (inputIsPayment && outputIsPayment) {
        return null;
      }

      // Также фильтруем операции между двумя неплатежными токенами
      if (!inputIsPayment && !outputIsPayment) {
        return null;
      }

      return { walletAddress, inputMint, outputMint, inputAmountRaw, outputAmountRaw };

    } catch (error) {
      console.error(`❌ [QuickNode] extractSwapInfoFromBalances error:`, error);
      return null;
    }
  }

  private async getWalletSignatures(walletAddress: string): Promise<Array<{signature: string; blockTime: number}>> {
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
      
      // 🔥 ТОЛЬКО НОВЫЕ ТРАНЗАКЦИИ: последние 10 минут
      const tenMinutesAgo = Math.floor(Date.now() / 1000) - (10 * 60);
      const recentSignatures = signatures.filter((sig: any) => sig.blockTime > tenMinutesAgo);
      
      return recentSignatures;

    } catch (error) {
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

  // 🔥🔥🔥 ТОЛЬКО НОВЫЕ ТРАНЗАКЦИИ: Простая и надежная проверка времени (последние 10 минут)
  private isTransactionRecentAndValid(transaction: any): boolean {
    if (!transaction || !transaction.blockTime) return false;
    
    const transactionTime = transaction.blockTime * 1000;
    const now = Date.now();
    const timeDifference = now - transactionTime;
    const maxAge = 10 * 60 * 1000; // 10 минут
    
    // 🔥 ЕДИНСТВЕННАЯ НАДЕЖНАЯ ПРОВЕРКА: используем Math.abs() для защиты от рассинхронизации
    const absoluteTimeDifference = Math.abs(timeDifference);
    
    if (absoluteTimeDifference > maxAge) {
      return false;
    }
    
    if (!transaction.meta || transaction.meta.err) {
      return false;
    }
    
    return true;
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
    try {
      if (!this.telegramNotifier) return;

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

      await this.telegramNotifier.sendSmartMoneySwapAlert(swap);
      
      this.errorStats.recoveredFromErrors++;

    } catch (error) {
      // Ignore errors in notifications
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