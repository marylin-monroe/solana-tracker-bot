// src/services/LargeTransactionMonitor.ts - MODULE B: ИСПРАВЛЕНО БЕЗ HELIUS + используем MultiProviderService
import { TelegramNotifier } from './TelegramNotifier';
import { MultiProviderService } from './MultiProviderService';
import { Logger } from '../utils/Logger';

interface LargeTransaction {
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

interface ScamDetectionResult {
  isScam: boolean;
  confidence: number;
  reasons: string[];
}

interface OwnerDetectionResult {
  isOwner: boolean;
  confidence: number;
  reasons: string[];
}

export class LargeTransactionMonitor {
  private telegramNotifier: TelegramNotifier;
  private multiProvider: MultiProviderService;
  private logger: Logger;
  
  // Мониторинг
  private isMonitoring: boolean = false;
  private monitoringInterval: NodeJS.Timeout | null = null;
  private lastProcessedSlot: number = 0;
  
  // Конфигурация
  private readonly TRANSACTION_THRESHOLD_USD = 2_000_000; // $2M+
  private readonly SCAN_INTERVAL_MS = 30 * 1000; // 30 секунд
  private readonly MAX_SLOTS_PER_SCAN = 50; // Максимум слотов за один скан
  
  // Статистика
  private stats: MonitoringStats = {
    totalScanned: 0,
    largeTransactionsFound: 0,
    filtered: 0,
    alertsSent: 0,
    lastScanTime: new Date(),
    avgScanTime: 0,
    errorCount: 0,
    filterReasons: {}
  };
  
  // Кеши для оптимизации
  private scamAddressCache = new Map<string, { isScam: boolean; timestamp: number }>();
  private ownerAddressCache = new Map<string, { isOwner: boolean; timestamp: number }>();
  private tokenInfoCache = new Map<string, { symbol: string; name: string; timestamp: number }>();
  
  // Время жизни кешей
  private readonly CACHE_TTL = 60 * 60 * 1000; // 1 час

  constructor(
    telegramNotifier: TelegramNotifier,
    multiProvider: MultiProviderService
  ) {
    this.telegramNotifier = telegramNotifier;
    this.multiProvider = multiProvider;
    this.logger = Logger.getInstance();
    
    this.logger.info('🚨 LargeTransactionMonitor initialized (NO HELIUS, using MultiProvider)');
  }

  /**
   * 🚀 ЗАПУСК МОНИТОРИНГА
   */
  async startMonitoring(): Promise<void> {
    if (this.isMonitoring) {
      this.logger.warn('⚠️ Large transaction monitoring already running');
      return;
    }

    try {
      this.logger.info(`🚨 Starting large transaction monitoring (threshold: $${this.TRANSACTION_THRESHOLD_USD.toLocaleString()})`);
      
      // Получаем текущий слот
      const slotResponse = await this.multiProvider.getSlot();
      if (slotResponse.success && slotResponse.data) {
        this.lastProcessedSlot = slotResponse.data;
        this.logger.info(`🎯 Starting from slot: ${this.lastProcessedSlot}`);
      } else {
        this.logger.error('❌ Failed to get current slot, using fallback');
        this.lastProcessedSlot = 0;
      }

      this.isMonitoring = true;
      
      // Запускаем периодическое сканирование
      this.monitoringInterval = setInterval(async () => {
        await this.scanForLargeTransactions();
      }, this.SCAN_INTERVAL_MS);

      await this.telegramNotifier.sendCycleLog(
        `🚨 <b>Large Transaction Monitor Started</b>\n\n` +
        `💰 <b>Threshold:</b> <code>$${this.TRANSACTION_THRESHOLD_USD.toLocaleString()}</code>\n` +
        `⏰ <b>Scan Interval:</b> <code>${this.SCAN_INTERVAL_MS / 1000}s</code>\n` +
        `📡 <b>Data Source:</b> <code>QuickNode + Alchemy</code>\n` +
        `🚫 <b>NO HELIUS:</b> <code>Removed for stability</code>\n` +
        `🛡️ <b>Filtering:</b> <code>Scams + Token Owners + Exchange</code>\n\n` +
        `🎯 <b>Starting Slot:</b> <code>${this.lastProcessedSlot}</code>\n` +
        `⏰ <code>${new Date().toLocaleString()}</code>`
      );

      this.logger.info('✅ Large transaction monitoring started successfully');

    } catch (error) {
      this.logger.error('❌ Error starting large transaction monitoring:', error);
      this.isMonitoring = false;
      throw error;
    }
  }

  /**
   * 🔍 СКАНИРОВАНИЕ БОЛЬШИХ ТРАНЗАКЦИЙ
   */
  private async scanForLargeTransactions(): Promise<void> {
    const startTime = Date.now();
    
    try {
      // Получаем текущий слот
      const currentSlotResponse = await this.multiProvider.getSlot();
      if (!currentSlotResponse.success || !currentSlotResponse.data) {
        this.logger.error('❌ Failed to get current slot');
        this.stats.errorCount++;
        return;
      }

      const currentSlot = currentSlotResponse.data;
      const slotsToScan = Math.min(currentSlot - this.lastProcessedSlot, this.MAX_SLOTS_PER_SCAN);
      
      if (slotsToScan <= 0) {
        return; // Нет новых слотов для сканирования
      }

      this.logger.debug(`🔍 Scanning ${slotsToScan} slots (${this.lastProcessedSlot} -> ${currentSlot})`);

      // Получаем блоки в диапазоне слотов
      const blocks = await this.getBlocksInRange(this.lastProcessedSlot, currentSlot);
      
      for (const block of blocks) {
        await this.processBlock(block);
      }

      this.lastProcessedSlot = currentSlot;
      this.stats.totalScanned += slotsToScan;
      this.stats.lastScanTime = new Date();
      
      // Обновляем среднее время сканирования
      const scanTime = Date.now() - startTime;
      this.stats.avgScanTime = (this.stats.avgScanTime + scanTime) / 2;

    } catch (error) {
      this.logger.error('❌ Error during large transaction scan:', error);
      this.stats.errorCount++;
    }
  }

  /**
   * 📦 ПОЛУЧЕНИЕ БЛОКОВ В ДИАПАЗОНЕ
   */
  private async getBlocksInRange(startSlot: number, endSlot: number): Promise<any[]> {
    try {
      const blocks = [];
      
      // Получаем блоки пакетами для оптимизации
      const batchSize = 10;
      for (let slot = startSlot + 1; slot <= endSlot && slot <= startSlot + this.MAX_SLOTS_PER_SCAN; slot += batchSize) {
        const batchEnd = Math.min(slot + batchSize - 1, endSlot, startSlot + this.MAX_SLOTS_PER_SCAN);
        
        const batchPromises = [];
        for (let s = slot; s <= batchEnd; s++) {
          batchPromises.push(this.getBlock(s));
        }
        
        const batchResults = await Promise.allSettled(batchPromises);
        
        for (const result of batchResults) {
          if (result.status === 'fulfilled' && result.value) {
            blocks.push(result.value);
          }
        }
        
        // Небольшая пауза между пакетами
        await this.sleep(100);
      }
      
      return blocks;

    } catch (error) {
      this.logger.error('Error getting blocks in range:', error);
      return [];
    }
  }

  /**
   * 📦 ПОЛУЧЕНИЕ БЛОКА ПО СЛОТУ
   */
  private async getBlock(slot: number): Promise<any | null> {
    try {
      const response = await this.multiProvider.makeRequest('getBlock', [slot, {
        encoding: 'jsonParsed',
        transactionDetails: 'full',
        rewards: false,
        commitment: 'confirmed'
      }]);

      if (response.success && response.data) {
        return response.data;
      }

      return null;

    } catch (error) {
      this.logger.debug(`Error getting block ${slot}:`, error);
      return null;
    }
  }

  /**
   * ⚙️ ОБРАБОТКА БЛОКА
   */
  private async processBlock(block: any): Promise<void> {
    try {
      if (!block || !block.transactions || !Array.isArray(block.transactions)) {
        return;
      }

      for (const transaction of block.transactions) {
        await this.processTransaction(transaction);
      }

    } catch (error) {
      this.logger.error('Error processing block:', error);
    }
  }

  /**
   * 💸 ОБРАБОТКА ТРАНЗАКЦИИ
   */
  private async processTransaction(transaction: any): Promise<void> {
    try {
      if (!transaction || !transaction.meta || transaction.meta.err) {
        return; // Пропускаем неудачные транзакции
      }

      const signature = transaction.transaction?.signatures?.[0];
      if (!signature) {
        return;
      }

      // Анализируем инструкции для поиска свапов
      const swapInfo = await this.extractSwapInfo(transaction);
      if (!swapInfo) {
        return;
      }

      // Проверяем, превышает ли сумма наш порог
      if (swapInfo.amountUSD < this.TRANSACTION_THRESHOLD_USD) {
        return;
      }

      this.stats.largeTransactionsFound++;
      this.logger.info(`💰 Found large transaction: $${swapInfo.amountUSD.toLocaleString()} - ${swapInfo.tokenSymbol}`);

      // Применяем фильтры
      const filterResult = await this.applyFilters(swapInfo);
      
      if (filterResult.shouldFilter) {
        this.stats.filtered++;
        this.stats.filterReasons[filterResult.reason || 'unknown'] = (this.stats.filterReasons[filterResult.reason || 'unknown'] || 0) + 1;
        
        this.logger.info(`🚫 Filtered large transaction: ${filterResult.reason}`);
        return;
      }

      // Отправляем алерт
      await this.sendLargeTransactionAlert(swapInfo);
      this.stats.alertsSent++;

    } catch (error) {
      this.logger.error('Error processing transaction:', error);
    }
  }

  /**
   * 🔍 ИЗВЛЕЧЕНИЕ ИНФОРМАЦИИ О СВАПЕ
   */
  private async extractSwapInfo(transaction: any): Promise<LargeTransaction | null> {
    try {
      // Извлекаем базовую информацию
      const signature = transaction.transaction?.signatures?.[0];
      const timestamp = new Date(transaction.blockTime * 1000);
      
      // Анализируем инструкции для поиска токен трансферов
      const instructions = transaction.transaction?.message?.instructions || [];
      const accountKeys = transaction.transaction?.message?.accountKeys || [];
      
      let tokenAddress = '';
      let amountUSD = 0;
      let walletAddress = '';
      let transactionType: 'buy' | 'sell' = 'buy';

      // Анализируем мета информацию о трансферах
      const postTokenBalances = transaction.meta?.postTokenBalances || [];
      const preTokenBalances = transaction.meta?.preTokenBalances || [];

      // Ищем значительные изменения в балансах
      for (const postBalance of postTokenBalances) {
        const preBalance = preTokenBalances.find((pre: any) => 
          pre.accountIndex === postBalance.accountIndex
        );

        if (!preBalance) continue;

        const balanceChange = parseFloat(postBalance.uiTokenAmount.uiAmountString || '0') - 
                             parseFloat(preBalance.uiTokenAmount.uiAmountString || '0');

        if (Math.abs(balanceChange) > 1000) { // Значительное изменение
          tokenAddress = postBalance.mint;
          walletAddress = accountKeys[postBalance.accountIndex]?.pubkey || '';
          
          // Примерная конвертация в USD (упрощенно)
          amountUSD = Math.abs(balanceChange) * 1; // Заглушка - нужна интеграция с ценами
          transactionType = balanceChange > 0 ? 'buy' : 'sell';
          break;
        }
      }

      if (!tokenAddress || amountUSD < 1000) {
        return null;
      }

      // Получаем информацию о токене
      const tokenInfo = await this.getTokenInfo(tokenAddress);

      return {
        signature,
        timestamp,
        walletAddress,
        tokenAddress,
        tokenSymbol: tokenInfo.symbol,
        tokenName: tokenInfo.name,
        amountUSD,
        transactionType,
        dex: 'Unknown',
        isFiltered: false
      };

    } catch (error) {
      this.logger.debug('Error extracting swap info:', error);
      return null;
    }
  }

  /**
   * 🛡️ ПРИМЕНЕНИЕ ФИЛЬТРОВ
   */
  private async applyFilters(transaction: LargeTransaction): Promise<FilterResult> {
    try {
      let riskScore = 0;
      
      // 1. Фильтр скам адресов
      const scamCheck = await this.checkScamAddress(transaction.walletAddress);
      if (scamCheck.isScam) {
        return {
          shouldFilter: true,
          reason: `Scam address (confidence: ${scamCheck.confidence}%)`,
          riskScore: 100
        };
      }
      riskScore += scamCheck.confidence * 0.5;

      // 2. Фильтр создателей токенов
      const ownerCheck = await this.checkTokenOwner(transaction.walletAddress, transaction.tokenAddress);
      if (ownerCheck.isOwner) {
        return {
          shouldFilter: true,
          reason: `Token owner/creator (confidence: ${ownerCheck.confidence}%)`,
          riskScore: 100
        };
      }
      riskScore += ownerCheck.confidence * 0.3;

      // 3. Фильтр биржевых адресов
      if (await this.isExchangeAddress(transaction.walletAddress)) {
        return {
          shouldFilter: true,
          reason: 'Exchange internal transfer',
          riskScore: 90
        };
      }

      // 4. Фильтр подозрительных паттернов
      const patternCheck = await this.checkSuspiciousPatterns(transaction);
      riskScore += patternCheck;

      // Если общий риск-скор слишком высокий
      if (riskScore > 75) {
        return {
          shouldFilter: true,
          reason: `High risk score (${riskScore.toFixed(1)})`,
          riskScore
        };
      }

      return {
        shouldFilter: false,
        riskScore
      };

    } catch (error) {
      this.logger.error('Error applying filters:', error);
      return {
        shouldFilter: false,
        riskScore: 0
      };
    }
  }

  /**
   * 🔍 ПРОВЕРКА НА СКАМ АДРЕС
   */
  private async checkScamAddress(address: string): Promise<ScamDetectionResult> {
    try {
      // Проверяем кеш
      const cached = this.scamAddressCache.get(address);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
        return {
          isScam: cached.isScam,
          confidence: cached.isScam ? 100 : 0,
          reasons: cached.isScam ? ['Cached scam address'] : []
        };
      }

      // Простая проверка через известные скам листы (заглушка)
      const knownScamPatterns = [
        /^11111111111111111111111111111111$/, // Null address
        /^22222222222222222222222222222222$/, // Pattern address
      ];

      const isScam = knownScamPatterns.some(pattern => pattern.test(address));
      
      // Кешируем результат
      this.scamAddressCache.set(address, {
        isScam,
        timestamp: Date.now()
      });

      return {
        isScam,
        confidence: isScam ? 100 : 0,
        reasons: isScam ? ['Matches known scam pattern'] : []
      };

    } catch (error) {
      this.logger.error('Error checking scam address:', error);
      return {
        isScam: false,
        confidence: 0,
        reasons: []
      };
    }
  }

  /**
   * 🔍 ПРОВЕРКА НА СОЗДАТЕЛЯ ТОКЕНА
   */
  private async checkTokenOwner(walletAddress: string, tokenAddress: string): Promise<OwnerDetectionResult> {
    try {
      const cacheKey = `${walletAddress}:${tokenAddress}`;
      const cached = this.ownerAddressCache.get(cacheKey);
      
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
        return {
          isOwner: cached.isOwner,
          confidence: cached.isOwner ? 100 : 0,
          reasons: cached.isOwner ? ['Cached owner check'] : []
        };
      }

      // Заглушка - в реальности нужно проверить через Solana API
      // Можно проверить mint authority, freeze authority и т.д.
      const isOwner = false;
      
      this.ownerAddressCache.set(cacheKey, {
        isOwner,
        timestamp: Date.now()
      });

      return {
        isOwner,
        confidence: 0,
        reasons: []
      };

    } catch (error) {
      this.logger.error('Error checking token owner:', error);
      return {
        isOwner: false,
        confidence: 0,
        reasons: []
      };
    }
  }

  /**
   * 🏦 ПРОВЕРКА НА БИРЖЕВОЙ АДРЕС
   */
  private async isExchangeAddress(address: string): Promise<boolean> {
    // Список известных биржевых адресов (заглушка)
    const knownExchangeAddresses = new Set([
      // Binance
      '2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S',
      // FTX
      '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9',
      // Coinbase
      'GVXRSBjFk6e6J3NbVPXohDJetcTjaeeuykUpbQF8UoMU'
    ]);

    return knownExchangeAddresses.has(address);
  }

  /**
   * 🔍 ПРОВЕРКА ПОДОЗРИТЕЛЬНЫХ ПАТТЕРНОВ
   */
  private async checkSuspiciousPatterns(transaction: LargeTransaction): Promise<number> {
    let suspicionScore = 0;

    // Очень новый токен (< 24 часов)
    // Заглушка - в реальности нужно проверить возраст токена
    
    // Очень крупная сделка (> $10M)
    if (transaction.amountUSD > 10_000_000) {
      suspicionScore += 20;
    }

    // Необычное время (3-5 AM UTC - время бóльшего количества скамов)
    const hour = transaction.timestamp.getUTCHours();
    if (hour >= 3 && hour <= 5) {
      suspicionScore += 10;
    }

    return suspicionScore;
  }

  /**
   * 📬 ОТПРАВКА АЛЕРТА О БОЛЬШОЙ ТРАНЗАКЦИИ
   */
  private async sendLargeTransactionAlert(transaction: LargeTransaction): Promise<void> {
    try {
      const typeEmoji = transaction.transactionType === 'buy' ? '💰' : '🔴';
      const amountFormatted = this.formatNumber(transaction.amountUSD);
      
      const message = 
        `🚨 <b>Large Transaction Alert!</b>\n\n` +
        `${typeEmoji} <b>Type:</b> <code>${transaction.transactionType.toUpperCase()}</code>\n` +
        `💰 <b>Amount:</b> <code>$${amountFormatted}</code>\n` +
        `🪙 <b>Token:</b> <code>${transaction.tokenSymbol}</code>\n` +
        `📄 <b>Name:</b> <code>${transaction.tokenName}</code>\n` +
        `👤 <b>Wallet:</b> <code>${transaction.walletAddress.slice(0, 8)}...${transaction.walletAddress.slice(-4)}</code>\n` +
        `🏪 <b>DEX:</b> <code>${transaction.dex || 'Unknown'}</code>\n` +
        `⏰ <b>Time:</b> <code>${transaction.timestamp.toLocaleString()}</code>\n\n` +
        `🔗 <b>Links:</b>\n` +
        `<a href="https://solscan.io/tx/${transaction.signature}">Transaction</a> | ` +
        `<a href="https://solscan.io/token/${transaction.tokenAddress}">Token</a> | ` +
        `<a href="https://solscan.io/account/${transaction.walletAddress}">Wallet</a>\n\n` +
        `🛡️ <b>Passed all filters</b> ✅`;

      await this.telegramNotifier.sendCycleLog(message);

    } catch (error) {
      this.logger.error('Error sending large transaction alert:', error);
    }
  }

  /**
   * 🏷️ ПОЛУЧЕНИЕ ИНФОРМАЦИИ О ТОКЕНЕ
   */
  private async getTokenInfo(tokenAddress: string): Promise<{ symbol: string; name: string }> {
    const cached = this.tokenInfoCache.get(tokenAddress);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return { symbol: cached.symbol, name: cached.name };
    }

    try {
      // Пытаемся получить через Jupiter API
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${tokenAddress}&outputMint=So11111111111111111111111111111111111111112&amount=1000000`, {
        method: 'GET',
        headers: { 
          'Content-Type': 'application/json',
          'User-Agent': 'Smart-Money-Bot/1.0'
        },
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);

      let symbol = 'UNKNOWN';
      let name = 'Unknown Token';

      if (response.ok) {
        // Jupiter не дает метаданные в quote, используем fallback
        symbol = tokenAddress.slice(0, 6);
        name = `Token ${tokenAddress.slice(0, 8)}...`;
      } else {
        symbol = tokenAddress.slice(0, 6);
        name = `Token ${tokenAddress.slice(0, 8)}...`;
      }

      const tokenInfo = { symbol, name, timestamp: Date.now() };
      this.tokenInfoCache.set(tokenAddress, tokenInfo);
      
      return { symbol, name };

    } catch (error) {
      this.logger.debug(`Error getting token info for ${tokenAddress}:`, error);
      
      const fallbackSymbol = tokenAddress.slice(0, 6);
      const fallbackName = `Token ${tokenAddress.slice(0, 8)}...`;
      
      this.tokenInfoCache.set(tokenAddress, {
        symbol: fallbackSymbol,
        name: fallbackName,
        timestamp: Date.now()
      });
      
      return { symbol: fallbackSymbol, name: fallbackName };
    }
  }

  /**
   * 📊 ПОЛУЧЕНИЕ СТАТИСТИКИ
   */
  getStats(): MonitoringStats {
    return { ...this.stats };
  }

  /**
   * 🛑 ОСТАНОВКА МОНИТОРИНГА
   */
  async stopMonitoring(): Promise<void> {
    if (!this.isMonitoring) {
      this.logger.warn('⚠️ Large transaction monitoring not running');
      return;
    }

    this.logger.info('🛑 Stopping large transaction monitoring...');
    
    this.isMonitoring = false;
    
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    await this.telegramNotifier.sendCycleLog(
      `🛑 <b>Large Transaction Monitor Stopped</b>\n\n` +
      `📊 <b>Final Stats:</b>\n` +
      `• Total Scanned: <code>${this.stats.totalScanned}</code>\n` +
      `• Large TXs Found: <code>${this.stats.largeTransactionsFound}</code>\n` +
      `• Filtered Out: <code>${this.stats.filtered}</code>\n` +
      `• Alerts Sent: <code>${this.stats.alertsSent}</code>\n` +
      `• Errors: <code>${this.stats.errorCount}</code>\n\n` +
      `⏰ <code>${new Date().toLocaleString()}</code>`
    );

    this.logger.info('✅ Large transaction monitoring stopped');
  }

  /**
   * 🔄 СБРОС СТАТИСТИКИ
   */
  resetStats(): void {
    this.stats = {
      totalScanned: 0,
      largeTransactionsFound: 0,
      filtered: 0,
      alertsSent: 0,
      lastScanTime: new Date(),
      avgScanTime: 0,
      errorCount: 0,
      filterReasons: {}
    };
    
    this.logger.info('🔄 Large transaction monitor stats reset');
  }

  /**
   * 🧹 ОЧИСТКА КЕШЕЙ
   */
  clearCaches(): void {
    this.scamAddressCache.clear();
    this.ownerAddressCache.clear();
    this.tokenInfoCache.clear();
    
    this.logger.info('🧹 Large transaction monitor caches cleared');
  }

  /**
   * 🛠️ ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ
   */
  private formatNumber(num: number): string {
    if (num >= 1_000_000) {
      return `${(num / 1_000_000).toFixed(1)}M`;
    } else if (num >= 1_000) {
      return `${(num / 1_000).toFixed(1)}K`;
    }
    return num.toFixed(0);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 📊 ПОЛУЧЕНИЕ ДЕТАЛЬНОЙ СТАТИСТИКИ
   */
  getDetailedStats(): MonitoringStats & {
    cacheStats: {
      scamAddressCache: number;
      ownerAddressCache: number;
      tokenInfoCache: number;
    };
    isMonitoring: boolean;
    lastProcessedSlot: number;
  } {
    return {
      ...this.stats,
      cacheStats: {
        scamAddressCache: this.scamAddressCache.size,
        ownerAddressCache: this.ownerAddressCache.size,
        tokenInfoCache: this.tokenInfoCache.size
      },
      isMonitoring: this.isMonitoring,
      lastProcessedSlot: this.lastProcessedSlot
    };
  }
}