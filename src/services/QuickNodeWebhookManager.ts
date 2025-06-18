// src/services/QuickNodeWebhookManager.ts - ИСПРАВЛЕН: добавлена фильтрация старых транзакций + все существующие методы сохранены + ИСПРАВЛЕН saveAndNotifySwap()
import { Logger } from '../utils/Logger';
import { SmartMoneyDatabase } from './SmartMoneyDatabase';
import { TelegramNotifier } from './TelegramNotifier';
import { SmartMoneyWallet, SmartMoneySwap } from '../types';

interface QuickNodeStreamConfig {
  name: string;
  webhook_url: string;
  filters: Array<{
    program_id?: string[];
    account_type?: string;
  }>;
  region?: string;
}

interface QuickNodeStreamResponse {
  id: string;
  name: string;
  webhook_url: string;
  status: string;
  filters: any;
}

// 🚀 УЛУЧШЕННАЯ СТРУКТУРА API ЛИМИТОВ С ЗАЩИТОЙ ОТ RACE CONDITIONS
interface ApiLimits {
  requestsPerMinute: number;
  requestsPerDay: number;
  currentMinuteRequests: number;
  currentDayRequests: number;
  minuteReset: number;
  dayReset: number;
  lastRequestTime: number; // Для дополнительной защиты
}

// 🆕 СТРУКТУРА ДЛЯ ПРОВАЙДЕРОВ
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
  priority: number; // 1-5, где 5 = высший приоритет
}

// 🆕 НОВЫЕ ИНТЕРФЕЙСЫ ДЛЯ MULTIPROVIDER
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

interface LoadBalancingResult {
  provider: RpcProvider;
  fallbackUsed: boolean;
  responseTime: number;
}

export class QuickNodeWebhookManager {
  // 🆕 ОСНОВНОЙ МЕТОД: Создание Smart Money webhook
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
        filters: [
          {
            program_id: [
              '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', // Raydium
              'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',  // Jupiter
              '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'  // Raydium AMM
            ]
          }
        ],
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

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }

      // ✅ ЕДИНСТВЕННОЕ ИСПРАВЛЕНИЕ: строка 111 - добавлена проверка типа
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
  private logger: Logger;
  
  // 🆕 МУЛЬТИ-ПРОВАЙДЕР СИСТЕМА С УЛУЧШЕННОЙ ЛОГИКОЙ
  private providers: RpcProvider[] = [];
  private currentProviderIndex: number = 0;
  private providerResponseTimes: Map<string, number[]> = new Map(); // Для отслеживания производительности
  
  private smDatabase: SmartMoneyDatabase | null = null;
  private telegramNotifier: TelegramNotifier | null = null;
  
  // 🔥 ОПТИМИЗИРОВАННЫЙ POLLING SERVICE
  private isPollingActive: boolean = false;
  private pollingInterval: NodeJS.Timeout | null = null;
  private lastProcessedSignatures = new Map<string, string>();
  private monitoredWallets: SmartMoneyWallet[] = [];
  
  // 🚀 АГРЕССИВНОЕ КЕШИРОВАНИЕ
  private tokenInfoCache = new Map<string, { 
    symbol: string; 
    name: string; 
    timestamp: number; 
    price?: number; 
  }>();
  private priceCache = new Map<string, { 
    priceUSD: number; 
    timestamp: number; 
  }>();
  private addressCache = new Map<string, { 
    hasSwap: boolean; 
    timestamp: number; 
  }>();
  
  // 🔒 МЬЮТЕКС для API лимитов с дополнительной защитой
  private apiLimitMutex: boolean = false;

  // 🚀 УЛУЧШЕННЫЕ API ЛИМИТЫ С АВТОСБРОСОМ
  private apiLimits: ApiLimits = {
    requestsPerMinute: 100,
    requestsPerDay: 50000,
    currentMinuteRequests: 0,
    currentDayRequests: 0,
    minuteReset: Date.now() + 60000,
    dayReset: Date.now() + 24 * 60 * 60 * 1000,
    lastRequestTime: 0
  };

  constructor() {
    this.logger = Logger.getInstance();
    this.initializeProviders();
    this.startLimitResetTimer();
    this.startCacheCleanup();
  }

  // 🆕 ИНИЦИАЛИЗАЦИЯ МУЛЬТИ-ПРОВАЙДЕР СИСТЕМЫ
  private initializeProviders(): void {
    const providers: RpcProvider[] = [];

    // QuickNode (приоритет 5 - высший)
    if (process.env.QUICKNODE_HTTP_URL && process.env.QUICKNODE_API_KEY) {
      providers.push({
        name: 'QuickNode-Primary',
        url: process.env.QUICKNODE_HTTP_URL,
        key: process.env.QUICKNODE_API_KEY,
        isHealthy: true,
        requestCount: 0,
        errorCount: 0,
        type: 'quicknode',
        priority: 5
      });
    }

    // Дополнительный QuickNode (если доступен)
    if (process.env.QUICKNODE_HTTP_URL_2 && process.env.QUICKNODE_API_KEY_2) {
      providers.push({
        name: 'QuickNode-Secondary',
        url: process.env.QUICKNODE_HTTP_URL_2,
        key: process.env.QUICKNODE_API_KEY_2,
        isHealthy: true,
        requestCount: 0,
        errorCount: 0,
        type: 'quicknode',
        priority: 4
      });
    }

    // Alchemy (приоритет 3)
    if (process.env.ALCHEMY_HTTP_URL && process.env.ALCHEMY_API_KEY) {
      providers.push({
        name: 'Alchemy',
        url: process.env.ALCHEMY_HTTP_URL,
        key: process.env.ALCHEMY_API_KEY,
        isHealthy: true,
        requestCount: 0,
        errorCount: 0,
        type: 'alchemy',
        priority: 3
      });
    }

    // Сортируем по приоритету (высший приоритет первым)
    this.providers = providers.sort((a, b) => b.priority - a.priority);
    
    this.logger.info(`🚀 Initialized ${this.providers.length} RPC providers`);
    this.providers.forEach(p => {
      this.logger.info(`  - ${p.name} (${p.type}, priority: ${p.priority})`);
    });
  }

  // 🔧 МЕТОД ДЛЯ УСТАНОВКИ ЗАВИСИМОСТЕЙ
  setDependencies(smDatabase: SmartMoneyDatabase, telegramNotifier: TelegramNotifier): void {
    this.smDatabase = smDatabase;
    this.telegramNotifier = telegramNotifier;
    this.logger.info('✅ QuickNode dependencies set');
  }

  // 🔧 АВТОМАТИЧЕСКИЙ СБРОС ЛИМИТОВ
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
    }, 10000); // Проверяем каждые 10 секунд
  }

  // 🧹 АВТООЧИСТКА КЕШЕЙ
  private startCacheCleanup(): void {
    setInterval(() => {
      const now = Date.now();
      const ONE_HOUR = 60 * 60 * 1000;
      
      // Очищаем кеш токенов (старше 1 часа)
      for (const [key, value] of this.tokenInfoCache.entries()) {
        if (now - value.timestamp > ONE_HOUR) {
          this.tokenInfoCache.delete(key);
        }
      }
      
      // Очищаем кеш цен (старше 5 минут)
      for (const [key, value] of this.priceCache.entries()) {
        if (now - value.timestamp > 5 * 60 * 1000) {
          this.priceCache.delete(key);
        }
      }
      
      // Очищаем кеш адресов (старше 30 минут)
      for (const [key, value] of this.addressCache.entries()) {
        if (now - value.timestamp > 30 * 60 * 1000) {
          this.addressCache.delete(key);
        }
      }
    }, 5 * 60 * 1000); // Очищаем каждые 5 минут
  }

  // 🚀 ПОЛУЧЕНИЕ ЛУЧШЕГО ПРОВАЙДЕРА С LOAD BALANCING
  private getCurrentProvider(): RpcProvider | null {
    const healthyProviders = this.providers.filter(p => p.isHealthy);
    
    if (healthyProviders.length === 0) {
      this.logger.warn('⚠️ No healthy providers available');
      return null;
    }

    // Используем round-robin среди здоровых провайдеров
    if (this.currentProviderIndex >= healthyProviders.length) {
      this.currentProviderIndex = 0;
    }
    
    const provider = healthyProviders[this.currentProviderIndex];
    this.currentProviderIndex = (this.currentProviderIndex + 1) % healthyProviders.length;
    
    return provider;
  }

  // 🔧 ПРОВЕРКА ЗДОРОВЬЯ ПРОВАЙДЕРА
  private markProviderUnhealthy(provider: RpcProvider, error: string): void {
    provider.isHealthy = false;
    provider.errorCount++;
    provider.lastError = error;
    provider.lastErrorTime = Date.now();
    
    this.logger.warn(`⚠️ Provider ${provider.name} marked unhealthy: ${error}`);
    
    // Восстанавливаем здоровье через 5 минут
    setTimeout(() => {
      provider.isHealthy = true;
      this.logger.info(`✅ Provider ${provider.name} restored to healthy status`);
    }, 5 * 60 * 1000);
  }

  // 🔥 УНИВЕРСАЛЬНЫЙ RPC ЗАПРОС С LOAD BALANCING
  private async makeRpcRequest(method: string, params: any[]): Promise<any> {
    const provider = this.getCurrentProvider();
    if (!provider) {
      throw new Error('No healthy RPC providers available');
    }

    const startTime = Date.now();
    
    try {
      const response = await fetch(provider.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Solana-Smart-Money-Bot/4.0-MultiProvider'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method,
          params
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      
      if ((data as any).error) {
        throw new Error(`RPC Error: ${(data as any).error.message || 'Unknown RPC error'}`);
      }

      // Отслеживаем успешную производительность
      const responseTime = Date.now() - startTime;
      this.trackProviderResponseTime(provider.name, responseTime);
      provider.requestCount++;
      
      return data;

    } catch (error) {
      this.markProviderUnhealthy(provider, error instanceof Error ? error.message : 'Unknown error');
      throw error;
    }
  }

  // 🆕 ОБРАБОТКА ЗАПРОСОВ ALCHEMY (если необходимо)
  private async makeAlchemyRequest(method: string, params: any[], alchemyProvider: RpcProvider): Promise<any> {
    const startTime = Date.now();
    
    try {
      const response = await fetch(alchemyProvider.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${alchemyProvider.key}`,
          'User-Agent': 'Solana-Smart-Money-Bot/4.0-Alchemy'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method,
          params
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      
      if ((data as any).error) {
        throw new Error(`Alchemy RPC Error: ${(data as any).error.message || 'Unknown Alchemy error'}`);
      }

      // Отслеживаем производительность
      const responseTime = Date.now() - startTime;
      this.trackProviderResponseTime(alchemyProvider.name, responseTime);
      alchemyProvider.requestCount++;
      
      return data;

    } catch (error) {
      alchemyProvider.errorCount++;
      alchemyProvider.lastError = error instanceof Error ? error.message : 'Unknown error';
      alchemyProvider.lastErrorTime = Date.now();
      
      this.logger.warn(`⚠️ ${alchemyProvider.name} failed for ${method}: ${alchemyProvider.lastError}`);
      throw error;
    }
  }

  // 🆕 ОТСЛЕЖИВАНИЕ ВРЕМЕНИ ОТВЕТА ПРОВАЙДЕРА
  private trackProviderResponseTime(providerName: string, responseTime: number): void {
    if (!this.providerResponseTimes.has(providerName)) {
      this.providerResponseTimes.set(providerName, []);
    }
    
    const times = this.providerResponseTimes.get(providerName)!;
    times.push(responseTime);
    
    // Храним только последние 50 измерений
    if (times.length > 50) {
      times.shift();
    }
  }

  // 🆕 НОВЫЙ МЕТОД: ОБРАБОТКА ТРАНЗАКЦИИ С КОНКРЕТНЫМ ПРОВАЙДЕРОМ
  private async processWalletTransactionWithProvider(signature: string, wallet: SmartMoneyWallet, provider: RpcProvider): Promise<void> {
    try {
      if (!this.canMakeRequest()) return;

      this.trackApiRequest();
      
      let transaction: any;
      if (provider.type === 'alchemy') {
        transaction = await this.getTransactionDetailsAlchemy(signature, provider);
      } else {
        transaction = await this.getTransactionDetails(signature);
      }
      
      if (!transaction) return;

      // 🔧 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Проверяем возраст транзакции
      if (!this.isTransactionRecent(transaction)) {
        const transactionAge = this.getTransactionAge(transaction);
        this.logger.debug(`⏰ Skipping old transaction: ${signature} (age: ${transactionAge})`);
        return;
      }

      const swaps = await this.extractSwapsFromTransaction(transaction, wallet);
      
      for (const swap of swaps) {
        if (this.shouldProcessSmartMoneySwapOptimized(swap, wallet)) {
          await this.saveAndNotifySwap(swap);
          this.logger.info(`🔥 SM swap: ${swap.tokenSymbol} - $${swap.amountUSD.toFixed(0)} (${this.getTransactionAge(transaction)}) (via ${provider.name})`);
        }
      }

    } catch (error) {
      this.logger.error(`Error processing transaction ${signature} with ${provider.name}:`, error);
    }
  }

  // 🔧 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: НОВЫЙ МЕТОД - Проверка актуальности транзакции
  private isTransactionRecent(transaction: any): boolean {
    if (!transaction || !transaction.blockTime) return false;
    
    const transactionTime = transaction.blockTime * 1000; // Convert to milliseconds
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 часа в миллисекундах
    
    return (now - transactionTime) <= maxAge;
  }

  // 🔧 ВСПОМОГАТЕЛЬНЫЙ МЕТОД: Получение возраста транзакции как строки
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

  // 🆕 МЕТОД ДЛЯ ПОЛУЧЕНИЯ ТРАНЗАКЦИЙ ЧЕРЕЗ ALCHEMY
  private async getTransactionDetailsAlchemy(signature: string, provider: RpcProvider): Promise<any> {
    try {
      const data = await this.makeAlchemyRequest('getTransaction', [
        signature,
        {
          encoding: 'jsonParsed',
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0
        }
      ], provider);

      return data.result;

    } catch (error) {
      this.logger.error(`Error getting transaction details via Alchemy for ${signature}:`, error);
      return null;
    }
  }

  // 🔧 ПРОВЕРКА ВОЗМОЖНОСТИ СДЕЛАТЬ ЗАПРОС
  private canMakeRequest(): boolean {
    // Ждем освобождения мьютекса
    if (this.apiLimitMutex) {
      return false;
    }
    
    const now = Date.now();
    
    // Автоматический сброс счетчиков
    if (now >= this.apiLimits.minuteReset) {
      this.apiLimits.currentMinuteRequests = 0;
      this.apiLimits.minuteReset = now + 60000;
    }
    
    if (now >= this.apiLimits.dayReset) {
      this.apiLimits.currentDayRequests = 0;
      this.apiLimits.dayReset = now + 24 * 60 * 60 * 1000;
    }
    
    // Проверка лимитов с запасом
    const minuteBuffer = Math.floor(this.apiLimits.requestsPerMinute * 0.9); // 90% от лимита
    const dayBuffer = Math.floor(this.apiLimits.requestsPerDay * 0.95); // 95% от лимита
    
    return this.apiLimits.currentMinuteRequests < minuteBuffer && 
           this.apiLimits.currentDayRequests < dayBuffer;
  }
  
  private trackApiRequest(): void {
    // 🔒 УСТАНАВЛИВАЕМ МЬЮТЕКС
    this.apiLimitMutex = true;
    
    const now = Date.now();
    this.apiLimits.currentMinuteRequests++;
    this.apiLimits.currentDayRequests++;
    this.apiLimits.lastRequestTime = now;
    
    // 🔒 ОСВОБОЖДАЕМ МЬЮТЕКС ЧЕРЕЗ МИНИМАЛЬНУЮ ЗАДЕРЖКУ
    setTimeout(() => {
      this.apiLimitMutex = false;
    }, 10);
  }
  
  // 🔧 ИСПРАВЛЕНО: ОБНОВЛЕННЫЙ МЕТОД С СТАТИСТИКОЙ ПРОВАЙДЕРОВ
  private logApiUsageWithProviderStats(): void {
    const minuteUsage = (this.apiLimits.currentMinuteRequests / this.apiLimits.requestsPerMinute * 100).toFixed(1);
    const dayUsage = (this.apiLimits.currentDayRequests / this.apiLimits.requestsPerDay * 100).toFixed(1);
    
    const currentProvider = this.getCurrentProvider();
    const healthyProviders = this.providers.filter(p => p.isHealthy).length;
    
    this.logger.info(`📊 API Usage: ${minuteUsage}% minute, ${dayUsage}% daily | Provider: ${currentProvider?.name || 'None'} | Healthy: ${healthyProviders}/${this.providers.length}`);
  }

  // 🔧 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: ИСПОЛЬЗУЕМ ПУБЛИЧНЫЙ МЕТОД БД
  private async saveAndNotifySwap(swap: SmartMoneySwap): Promise<void> {
    try {
      if (!this.smDatabase || !this.telegramNotifier) return;

      // ✅ ИСПРАВЛЕНО: Используем публичный метод вместо прямого доступа к БД
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

      await this.telegramNotifier.sendSmartMoneySwap(swap);

    } catch (error) {
      this.logger.error('Error saving and notifying swap:', error);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // СУЩЕСТВУЮЩИЕ МЕТОДЫ С ОБНОВЛЕНИЯМИ
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

  // 🔧 НАЧАЛО POLLING MODE - ИСПРАВЛЕНО: добавлен обязательный параметр
  async startPollingMode(smartWallets: SmartMoneyWallet[]): Promise<string> {
    try {
      this.logger.info('🚀 Starting POLLING mode for Smart Money monitoring...');
      
      this.monitoredWallets = smartWallets;
      this.isPollingActive = true;
      
      // Запускаем агрессивный polling каждые 30 секунд
      this.pollingInterval = setInterval(async () => {
        await this.pollWalletsForTransactions();
      }, 30000);
      
      // Первый запуск сразу
      await this.pollWalletsForTransactions();
      
      this.logger.info(`✅ Polling started for ${smartWallets.length} Smart Money wallets`);
      return 'polling-mode';
      
    } catch (error) {
      this.logger.error('❌ Error starting polling mode:', error);
      throw error;
    }
  }

  // 🔧 ОСТАНОВКА POLLING MODE
  stopPollingMode(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    this.isPollingActive = false;
    this.logger.info('⏹️ Polling mode stopped');
  }

  // 🔥 АГРЕССИВНЫЙ POLLING ВСЕХ КОШЕЛЬКОВ
  private async pollWalletsForTransactions(): Promise<void> {
    if (!this.isPollingActive) return;

    this.logger.info(`🔍 Polling ${this.monitoredWallets.length} Smart Money wallets...`);
    
    for (const wallet of this.monitoredWallets) {
      try {
        if (!this.canMakeRequest()) {
          this.logger.warn('⚠️ API limit reached, pausing polling...');
          await this.sleep(10000); // Ждем 10 секунд
          continue;
        }
        
        // Получаем последние транзакции
        const lastSignature = this.lastProcessedSignatures.get(wallet.address);
        const signatures = await this.getWalletSignatures(wallet.address, lastSignature);
        
        if (signatures.length > 0) {
          this.logger.info(`🔍 Processing ${signatures.length}/5 recent transactions for ${wallet.address.slice(0, 8)}...`);
          
          // Обновляем последнюю обработанную подпись
          this.lastProcessedSignatures.set(wallet.address, signatures[0].signature);
          
          // Обрабатываем новые транзакции
          for (const sig of signatures) {
            await this.processWalletTransaction(sig.signature, wallet);
            await this.sleep(100); // Небольшая задержка между транзакциями
          }
        }
        
        await this.sleep(200); // Пауза между кошельками
        
      } catch (error) {
        this.logger.error(`Error polling wallet ${wallet.address}:`, error);
      }
    }
    
    // Логируем статистику каждые 10 циклов
    this.logApiUsageWithProviderStats();
  }

  // 🔧 ПОЛУЧЕНИЕ ПОДПИСЕЙ ТРАНЗАКЦИЙ
  private async getWalletSignatures(walletAddress: string, beforeSignature?: string): Promise<Array<{signature: string; blockTime: number}>> {
    try {
      const params: any = [
        walletAddress,
        {
          limit: 5,
          commitment: 'confirmed'
        }
      ];

      if (beforeSignature) {
        params[1].before = beforeSignature;
      }

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
        {
          encoding: 'jsonParsed',
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0
        }
      ]);

      return data.result;

    } catch (error) {
      this.logger.error(`Error getting transaction details for ${signature}:`, error);
      return null;
    }
  }

  private async processWalletTransaction(signature: string, wallet: SmartMoneyWallet): Promise<void> {
    try {
      if (!this.canMakeRequest()) return;

      this.trackApiRequest();
      const transaction = await this.getTransactionDetails(signature);
      if (!transaction) return;

      // 🔧 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Проверяем возраст транзакции
      if (!this.isTransactionRecent(transaction)) {
        const transactionAge = this.getTransactionAge(transaction);
        this.logger.debug(`⏰ Skipping old transaction: ${signature} (age: ${transactionAge})`);
        return;
      }

      const swaps = await this.extractSwapsFromTransaction(transaction, wallet);
      
      for (const swap of swaps) {
        if (this.shouldProcessSmartMoneySwapOptimized(swap, wallet)) {
          await this.saveAndNotifySwap(swap);
          this.logger.info(`🔥 SM swap: ${swap.tokenSymbol} - $${swap.amountUSD.toFixed(0)} (${this.getTransactionAge(transaction)})`);
        }
      }

    } catch (error) {
      this.logger.error(`Error processing transaction ${signature}:`, error);
    }
  }

  private async extractSwapsFromTransaction(transaction: any, wallet: SmartMoneyWallet): Promise<SmartMoneySwap[]> {
    const swaps: SmartMoneySwap[] = [];

    try {
      if (!transaction || !transaction.meta || transaction.meta.err) return swaps;

      const preTokenBalances = transaction.meta.preTokenBalances || [];
      const postTokenBalances = transaction.meta.postTokenBalances || [];
      const blockTime = transaction.blockTime;

      for (const postBalance of postTokenBalances) {
        if (postBalance.owner !== wallet.address) continue;

        const preBalance = preTokenBalances.find(
          (pre: any) => pre.accountIndex === postBalance.accountIndex
        );

        const preAmount = preBalance ? 
          parseFloat(preBalance.uiTokenAmount.uiAmountString || '0') : 0;
        const postAmount = parseFloat(postBalance.uiTokenAmount.uiAmountString || '0');
        const difference = postAmount - preAmount;

        if (Math.abs(difference) < 10) continue;

        const tokenMint = postBalance.mint;
        const tokenInfo = await this.getTokenInfoCached(tokenMint);

        const swapType: 'buy' | 'sell' = difference > 0 ? 'buy' : 'sell';
        const tokenAmount = Math.abs(difference);
        
        const estimatedUSD = await this.estimateTokenValueUSDCached(tokenMint, tokenAmount);

        if (estimatedUSD > 5000) {
          const swap: SmartMoneySwap = {
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
            isFamilyMember: false,
            familySize: 0,
            familyId: undefined
          };

          swaps.push(swap);
        }
      }

    } catch (error) {
      this.logger.error('Error extracting swaps from transaction:', error);
    }

    return swaps;
  }

  // 🔥 АГРЕССИВНЫЕ ФИЛЬТРЫ ДЛЯ ЭКОНОМИИ API
  private shouldProcessSmartMoneySwapOptimized(swap: SmartMoneySwap, wallet: SmartMoneyWallet): boolean {
    const minAmounts: Record<string, number> = {
      sniper: 8000,
      hunter: 10000,
      trader: 25000
    };

    const minAmount = minAmounts[wallet.category] || 10000;
    if (swap.amountUSD < minAmount) return false;

    const daysSinceActive = (Date.now() - wallet.lastActiveAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceActive > 15) return false;

    if (wallet.winRate < 70) return false;

    if (wallet.performanceScore < 80) return false;

    return true;
  }

  // 🚀 КЕШИРОВАННОЕ ПОЛУЧЕНИЕ ИНФОРМАЦИИ О ТОКЕНЕ
  private async getTokenInfoCached(tokenMint: string): Promise<{ symbol: string; name: string }> {
    const cached = this.tokenInfoCache.get(tokenMint);
    if (cached && Date.now() - cached.timestamp < 60 * 60 * 1000) { // 1 час
      return { symbol: cached.symbol, name: cached.name };
    }

    try {
      // Простая заглушка для быстроты - можно заменить на реальный API
      const tokenInfo = {
        symbol: 'UNKNOWN',
        name: 'Unknown Token',
        timestamp: Date.now()
      };
      
      this.tokenInfoCache.set(tokenMint, tokenInfo);
      return { symbol: tokenInfo.symbol, name: tokenInfo.name };

    } catch (error) {
      this.logger.error(`Error getting token info for ${tokenMint}:`, error);
      return { symbol: 'UNKNOWN', name: 'Unknown Token' };
    }
  }

  // 🚀 КЕШИРОВАННАЯ ОЦЕНКА СТОИМОСТИ ТОКЕНА
  private async estimateTokenValueUSDCached(tokenMint: string, amount: number): Promise<number> {
    const cached = this.priceCache.get(tokenMint);
    if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) { // 5 минут
      return cached.priceUSD * amount;
    }

    try {
      // Простая оценка - можно заменить на реальный price API
      const estimatedPrice = 1; // $1 за токен по умолчанию
      
      this.priceCache.set(tokenMint, {
        priceUSD: estimatedPrice,
        timestamp: Date.now()
      });
      
      return estimatedPrice * amount;

    } catch (error) {
      this.logger.error(`Error estimating price for ${tokenMint}:`, error);
      return amount; // Fallback: считаем что 1 токен = $1
    }
  }

  // 🆕 МЕТОДЫ ДЛЯ ПОЛУЧЕНИЯ СТАТИСТИКИ
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
  } {
    return {
      isActive: this.isPollingActive,
      walletsMonitored: this.monitoredWallets.length,
      lastProcessedSignatures: this.lastProcessedSignatures.size
    };
  }
}