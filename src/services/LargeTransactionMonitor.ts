// src/services/LargeTransactionMonitor.ts - ПОЛНЫЙ ИСПРАВЛЕННЫЙ ФАЙЛ с мега-фильтрацией
import { TelegramNotifier } from './TelegramNotifier';
import { MultiProviderService } from './MultiProviderService';
import { TokenMetadataService } from './TokenMetadataService';
import { SmartMoneyDatabase } from './SmartMoneyDatabase';
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
  tokenPrice?: number;
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

interface MintInfo {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  decimals: number;
  supply: number;
}

interface TokenMetadata {
  symbol: string;
  name: string;
  price: number | null;
  marketCap?: number;
  volume24h?: number;
  liquidity?: number;
}

interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  platformFee: null | any;
  priceImpactPct: string;
  routePlan: any[];
}

export class LargeTransactionMonitor {
  private telegramNotifier: TelegramNotifier;
  private multiProvider: MultiProviderService;
  private tokenMetadataService: TokenMetadataService;
  private smDatabase: SmartMoneyDatabase;
  private logger: Logger;
  
  // Мониторинг
  private isMonitoring: boolean = false;
  private monitoringInterval: NodeJS.Timeout | null = null;
  private lastProcessedSlot: number = 0;
  
  // 🔥 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Дедупликация транзакций
  private processedSignatures = new Map<string, number>(); // signature -> timestamp
  private readonly DUPLICATE_WINDOW = 30 * 60 * 1000; // 30 минут
  
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
  private enrichedTokenCache = new Map<string, { 
    symbol: string; 
    name: string; 
    price: number | null;
    timestamp: number; 
  }>();
  private mintInfoCache = new Map<string, { mintInfo: MintInfo; timestamp: number }>();
  
  // Время жизни кешей
  private readonly CACHE_TTL = 60 * 60 * 1000; // 1 час
  private readonly TOKEN_CACHE_TTL = 10 * 60 * 1000; // 10 минут для токенов
  
  // 🛡️ КОНСТАНТЫ ДЛЯ ФИЛЬТРАЦИИ
  private readonly MAJOR_TOKENS = new Set([
    'So11111111111111111111111111111111111111112', // SOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
    'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', // WIF
    'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // JitoSOL
    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL
  ]);
  
  private readonly KNOWN_EXCHANGES = new Set([
    // Binance
    '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9',
    'AnH4zG6TBB8irVZLJ3ASoRhWLNBvFLekKqnH7fWfnrsY',
    'AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2',
    
    // Coinbase
    'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE',
    'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS',
    
    // OKX
    'AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2',
    
    // Raydium программы
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  ]);
  
  private readonly FILTER_THRESHOLDS = {
    SCAM_AUTO_BLOCK: 100,    // Мгновенная блокировка без уведомлений
    HIGH_RISK_BLOCK: 70,     // Блокировать с уведомлением  
    SUSPICIOUS_WARNING: 30,   // Отправить с предупреждением
    LEGITIMATE_THRESHOLD: 0   // Отправить как обычно
  };

  constructor(
    telegramNotifier: TelegramNotifier,
    multiProvider: MultiProviderService,
    tokenMetadataService: TokenMetadataService,
    smDatabase: SmartMoneyDatabase
  ) {
    this.telegramNotifier = telegramNotifier;
    this.multiProvider = multiProvider;
    this.tokenMetadataService = tokenMetadataService;
    this.smDatabase = smDatabase;
    this.logger = Logger.getInstance();
    
    this.startCacheCleanup();
    this.logger.info('🚨 LargeTransactionMonitor initialized with MEGA FILTERING system');
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
        `📡 <b>Data Source:</b> <code>MultiProvider (QuickNode + Alchemy)</code>\n` +
        `🏷️ <b>Token Metadata:</b> <code>TokenMetadataService (Jupiter + Birdeye)</code>\n` +
        `🛡️ <b>Filtering:</b> <code>MEGA SCAM DETECTION + Exchange + Genius Check</code>\n\n` +
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
   * 🛑 ОСТАНОВКА МОНИТОРИНГА
   */
  async stopMonitoring(): Promise<void> {
    if (!this.isMonitoring) {
      this.logger.warn('⚠️ Large transaction monitoring is not running');
      return;
    }

    this.isMonitoring = false;
    
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    await this.telegramNotifier.sendCycleLog(
      `🚨 <b>Large Transaction Monitor Stopped</b>\n\n` +
      `📊 <b>Final Stats:</b>\n` +
      `• Total Scanned: <code>${this.stats.totalScanned}</code>\n` +
      `• Large TXs Found: <code>${this.stats.largeTransactionsFound}</code>\n` +
      `• Filtered Out: <code>${this.stats.filtered}</code>\n` +
      `• Alerts Sent: <code>${this.stats.alertsSent}</code>\n\n` +
      `⏰ <code>${new Date().toLocaleString()}</code>`
    );

    this.logger.info('✅ Large transaction monitoring stopped');
  }

  /**
   * 📊 ПОЛУЧЕНИЕ СТАТИСТИКИ
   */
  getStats(): MonitoringStats {
    return { ...this.stats };
  }

  /**
   * 🔍 ОСНОВНОЕ СКАНИРОВАНИЕ ТРАНЗАКЦИЙ
   */
  private async scanForLargeTransactions(): Promise<void> {
    if (!this.isMonitoring) return;

    const startTime = Date.now();
    
    try {
      // Получаем текущий слот
      const currentSlotResponse = await this.multiProvider.getSlot();
      if (!currentSlotResponse.success || !currentSlotResponse.data) {
        this.logger.warn('⚠️ Failed to get current slot, skipping scan');
        return;
      }

      const currentSlot = currentSlotResponse.data;
      const startSlot = this.lastProcessedSlot + 1;
      const endSlot = Math.min(currentSlot, startSlot + this.MAX_SLOTS_PER_SCAN - 1);

      if (startSlot > endSlot) {
        return; // Нет новых слотов для обработки
      }

      this.logger.debug(`🔍 Scanning slots ${startSlot} to ${endSlot}`);

      // Получаем блоки
      const blocks = await this.getBlocksInRange(startSlot, endSlot);
      
      // Обрабатываем блоки
      for (const block of blocks) {
        if (!this.isMonitoring) break;
        await this.processBlock(block);
      }

      // Обновляем последний обработанный слот
      this.lastProcessedSlot = endSlot;
      
      // Обновляем статистику
      const scanTime = Date.now() - startTime;
      this.stats.avgScanTime = (this.stats.avgScanTime + scanTime) / 2;
      this.stats.lastScanTime = new Date();

    } catch (error) {
      this.logger.error('Error scanning for large transactions:', error);
      this.stats.errorCount++;
    }
  }

  /**
   * 📦 ПОЛУЧЕНИЕ БЛОКОВ В ДИАПАЗОНЕ
   */
  private async getBlocksInRange(startSlot: number, endSlot: number): Promise<any[]> {
    const blocks: any[] = [];
    
    try {
      // Обрабатываем блоки пакетами по 20
      for (let slot = startSlot; slot <= endSlot; slot += 20) {
        if (!this.isMonitoring) break;
        
        const batchEnd = Math.min(slot + 19, endSlot);
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
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0
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
        if (!this.isMonitoring) break;
        await this.processTransaction(transaction);
        this.stats.totalScanned++;
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

      // 🔥 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Проверка дубликатов ПЕРВЫМ ДЕЛОМ
      if (this.isAlreadyProcessed(signature)) {
        return;
      }

      // Помечаем как обработанную
      this.markAsProcessed(signature);

      // Анализируем инструкции для поиска свапов
      const swapInfo = await this.extractSwapInfoWithEnrichment(transaction);
      if (!swapInfo) {
        return;
      }

      // Проверяем, превышает ли сумма наш порог
      if (swapInfo.amountUSD < this.TRANSACTION_THRESHOLD_USD) {
        return;
      }

      this.stats.largeTransactionsFound++;
      this.logger.info(`💰 Found large transaction: $${swapInfo.amountUSD.toLocaleString()} - ${swapInfo.tokenSymbol} ${swapInfo.tokenPrice ? `@ $${swapInfo.tokenPrice}` : ''}`);

      // 🛡️ ПРИМЕНЯЕМ МЕГА-ФИЛЬТРЫ
      const filterResult = await this.applyMegaFilters(swapInfo);
      
      if (filterResult.shouldFilter) {
        this.stats.filtered++;
        this.stats.filterReasons[filterResult.reason || 'unknown'] = (this.stats.filterReasons[filterResult.reason || 'unknown'] || 0) + 1;
        
        // Логируем только если это не автоблокировка скама
        if (filterResult.reason !== 'SCAM_AUTO_BLOCKED') {
          this.logger.info(`🚫 Filtered large transaction: ${filterResult.reason}`);
        }
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
   * 🔥 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Проверка дубликатов
   */
  private isAlreadyProcessed(signature: string): boolean {
    const now = Date.now();
    const processedTime = this.processedSignatures.get(signature);
    
    if (processedTime && (now - processedTime) < this.DUPLICATE_WINDOW) {
      return true;
    }
    
    return false;
  }

  /**
   * 🔥 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Отметка как обработанной
   */
  private markAsProcessed(signature: string): void {
    this.processedSignatures.set(signature, Date.now());
  }

  /**
   * 🔍 ИЗВЛЕЧЕНИЕ ИНФОРМАЦИИ О СВАПЕ С ОБОГАЩЕНИЕМ
   */
  private async extractSwapInfoWithEnrichment(transaction: any): Promise<LargeTransaction | null> {
    try {
      // Извлекаем базовую информацию
      const signature = transaction.transaction?.signatures?.[0];
      
      // 🔥 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Правильная обработка timestamp
      let timestamp: Date;
      if (transaction.blockTime) {
        timestamp = new Date(transaction.blockTime * 1000);
        
        // Проверяем валидность даты
        if (isNaN(timestamp.getTime())) {
          timestamp = new Date(); // Fallback to current time
        }
      } else {
        timestamp = new Date();
      }
      
      // Анализируем инструкции для поиска токен трансферов
      const instructions = transaction.transaction?.message?.instructions || [];
      const accountKeys = transaction.transaction?.message?.accountKeys || [];
      
      let tokenAddress = '';
      let tokenAmount = 0;
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
          tokenAmount = Math.abs(balanceChange);
          walletAddress = accountKeys[postBalance.accountIndex]?.pubkey || '';
          transactionType = balanceChange > 0 ? 'buy' : 'sell';
          break;
        }
      }

      if (!tokenAddress || !walletAddress || tokenAmount === 0) {
        return null;
      }

      // 🆕 ОБОГАЩЕНИЕ ЧЕРЕЗ TokenMetadataService
      const enrichedInfo = await this.getEnrichedTokenInfo(tokenAddress);
      
      // Рассчитываем USD сумму
      if (enrichedInfo.price) {
        amountUSD = tokenAmount * enrichedInfo.price;
      } else {
        // Fallback расчет для неизвестных токенов
        amountUSD = tokenAmount * 0.001; // Очень низкая цена
      }

      const dex = this.detectDexFromTransaction(transaction);

      return {
        signature,
        timestamp,
        walletAddress,
        tokenAddress,
        tokenSymbol: enrichedInfo.symbol,
        tokenName: enrichedInfo.name,
        amountUSD,
        transactionType,
        dex,
        isFiltered: false,
        tokenPrice: enrichedInfo.price
      };

    } catch (error) {
      this.logger.error('Error extracting swap info:', error);
      return null;
    }
  }

  /**
   * 🔍 ПОЛУЧЕНИЕ ОБОГАЩЕННОЙ ИНФОРМАЦИИ О ТОКЕНЕ
   */
  private async getEnrichedTokenInfo(tokenAddress: string): Promise<TokenMetadata> {
    try {
      // Проверяем кеш
      const cached = this.enrichedTokenCache.get(tokenAddress);
      if (cached && Date.now() - cached.timestamp < this.TOKEN_CACHE_TTL) {
        return {
          symbol: cached.symbol,
          name: cached.name,
          price: cached.price
        };
      }

      // Получаем через TokenMetadataService
      const tokenInfo = await this.tokenMetadataService.getTokenInfo(tokenAddress);
      
      let enrichedInfo: TokenMetadata;
      
      if (tokenInfo) {
        enrichedInfo = {
          symbol: tokenInfo.symbol || this.generateFallbackSymbol(tokenAddress),
          name: tokenInfo.name || this.generateFallbackName(tokenAddress),
          price: tokenInfo.price || this.getTokenFallbackPrice(tokenAddress),
          marketCap: tokenInfo.marketCap,
          volume24h: tokenInfo.volume24h,
          liquidity: tokenInfo.liquidity
        };
      } else {
        // Fallback
        enrichedInfo = {
          symbol: this.generateFallbackSymbol(tokenAddress),
          name: this.generateFallbackName(tokenAddress),
          price: this.getTokenFallbackPrice(tokenAddress)
        };
      }

      // Кешируем результат
      this.enrichedTokenCache.set(tokenAddress, {
        symbol: enrichedInfo.symbol,
        name: enrichedInfo.name,
        price: enrichedInfo.price,
        timestamp: Date.now()
      });

      return enrichedInfo;

    } catch (error) {
      this.logger.error('Error getting enriched token info:', error);
      return {
        symbol: this.generateFallbackSymbol(tokenAddress),
        name: this.generateFallbackName(tokenAddress),
        price: this.getTokenFallbackPrice(tokenAddress)
      };
    }
  }

  /**
   * 🛡️ МЕГА-ФИЛЬТРАЦИЯ С ПОЭТАПНЫМ ВНЕДРЕНИЕМ
   */
  private async applyMegaFilters(transaction: LargeTransaction): Promise<FilterResult> {
    let riskScore = 0;
    const reasons: string[] = [];
    
    try {
      // 1. 🔥 ПЕРВАЯ ПРОВЕРКА: НАШ ГЕНИЙ ИЗ БАЗЫ
      const ourGenius = await this.smDatabase.getSmartWallet(transaction.walletAddress);
      if (ourGenius && ourGenius.isActive) {
        transaction.filterReason = `✅ VERIFIED GENIUS (${ourGenius.category.toUpperCase()}, PnL: $${ourGenius.totalPnL.toLocaleString()})`;
        return { shouldFilter: false, riskScore: -100 }; // Наш гений всегда проходит
      }
      
      // 2. 🔥 УРОВЕНЬ 1: КРИТИЧЕСКИЕ ПРОВЕРКИ (мгновенная блокировка при 100 баллов)
      
      // 2.1 Honeypot Detection
      const honeypotScore = await this.calculateHoneypotScore(transaction);
      riskScore += honeypotScore;
      if (honeypotScore > 0) reasons.push(`Honeypot(${honeypotScore})`);
      
      // 2.2 Token Creator Detection  
      const creatorScore = await this.calculateCreatorScore(transaction);
      riskScore += creatorScore;
      if (creatorScore > 0) reasons.push(`Creator(${creatorScore})`);
      
      // 2.3 Exchange Detection
      const exchangeScore = await this.calculateExchangeScore(transaction);
      riskScore += exchangeScore;
      if (exchangeScore > 0) reasons.push(`Exchange(${exchangeScore})`);
      
      // Если уже набрали 100+ баллов - мгновенная блокировка
      if (riskScore >= this.FILTER_THRESHOLDS.SCAM_AUTO_BLOCK) {
        return { shouldFilter: true, reason: 'SCAM_AUTO_BLOCKED', riskScore };
      }
      
      // 3. 🔥 УРОВЕНЬ 2: ПОДОЗРИТЕЛЬНЫЕ ПАТТЕРНЫ
      
      // 3.1 Rug Pull Indicators  
      const rugPullScore = await this.calculateRugPullScore(transaction);
      riskScore += rugPullScore;
      if (rugPullScore > 0) reasons.push(`RugPull(${rugPullScore})`);
      
      // 3.2 Bot Detection
      const botScore = await this.calculateBotScore(transaction);
      riskScore += botScore;
      if (botScore > 0) reasons.push(`Bot(${botScore})`);
      
      // 4. 🔥 УРОВЕНЬ 3: ПОЗИТИВНЫЕ ИНДИКАТОРЫ (снижение баллов)
      
      // 4.1 Legitimate Whale Indicators
      const whaleBonus = await this.calculateWhalePositives(transaction);
      riskScore += whaleBonus; // Может быть отрицательным
      if (whaleBonus < 0) reasons.push(`Whale(${Math.abs(whaleBonus)})`);
      
      // 4.2 Smart Money Traits
      const smartMoneyBonus = await this.calculateSmartMoneyTraits(transaction);
      riskScore += smartMoneyBonus; // Может быть отрицательным
      if (smartMoneyBonus < 0) reasons.push(`Smart(${Math.abs(smartMoneyBonus)})`);
      
      // 5. 🎯 ФИНАЛЬНОЕ РЕШЕНИЕ
      if (riskScore >= this.FILTER_THRESHOLDS.HIGH_RISK_BLOCK) {
        return { 
          shouldFilter: true, 
          reason: `High risk (${riskScore}/100): ${reasons.join(', ')}`, 
          riskScore 
        };
      } else if (riskScore >= this.FILTER_THRESHOLDS.SUSPICIOUS_WARNING) {
        transaction.filterReason = `⚠️ SUSPICIOUS (${riskScore}/100): ${reasons.join(', ')}`;
        return { shouldFilter: false, riskScore };
      } else {
        // Хороший кит
        if (riskScore < 0) {
          transaction.filterReason = `🐳 POTENTIAL WHALE (confidence: ${Math.abs(riskScore)})`;
        }
        return { shouldFilter: false, riskScore };
      }
      
    } catch (error) {
      this.logger.error('Error applying mega filters:', error);
      return { shouldFilter: false, riskScore: 0 };
    }
  }

  /**
   * 🍯 HONEYPOT SCORE CALCULATION
   */
  private async calculateHoneypotScore(transaction: LargeTransaction): Promise<number> {
    let score = 0;
    
    try {
      // Получаем mint info
      const mintInfo = await this.getMintInfo(transaction.tokenAddress);
      
      // Активный freeze authority
      if (mintInfo.freezeAuthority !== null) {
        score += 40;
      }
      
      // Активный mint authority
      if (mintInfo.mintAuthority !== null) {
        score += 35;
      }
      
      // Симуляция продажи через Jupiter
      const canSell = await this.simulateJupiterSell(transaction.tokenAddress, 1000);
      if (!canSell.success) {
        score += 30;
      }
      
      // Проверка кастомной программы токена (базовая проверка)
      // const isCustomProgram = await this.checkCustomTokenProgram(transaction.tokenAddress);
      // if (isCustomProgram) score += 25;
      
    } catch (error) {
      this.logger.debug('Error calculating honeypot score:', error);
    }
    
    return Math.min(score, 100); // Максимум 100
  }

  /**
   * 👨‍💻 TOKEN CREATOR SCORE CALCULATION
   */
  private async calculateCreatorScore(transaction: LargeTransaction): Promise<number> {
    let score = 0;
    
    try {
      const mintInfo = await this.getMintInfo(transaction.tokenAddress);
      
      // Кошелек = mint authority
      if (mintInfo.mintAuthority === transaction.walletAddress) {
        score += 40;
      }
      
      // Кошелек = freeze authority
      if (mintInfo.freezeAuthority === transaction.walletAddress) {
        score += 35;
      }
      
      // Проверка первых транзакций токена (упрощенная)
      const isDeployer = await this.checkIfTokenDeployer(transaction.walletAddress, transaction.tokenAddress);
      if (isDeployer) {
        score += 30;
      }
      
    } catch (error) {
      this.logger.debug('Error calculating creator score:', error);
    }
    
    return Math.min(score, 100);
  }

  /**
   * 🏪 EXCHANGE SCORE CALCULATION
   */
  private async calculateExchangeScore(transaction: LargeTransaction): Promise<number> {
    let score = 0;
    
    try {
      // Известный адрес биржи
      if (this.KNOWN_EXCHANGES.has(transaction.walletAddress)) {
        score += 100; // Мгновенная блокировка
      }
      
      // Паттерны биржевых переводов
      if (this.isRoundAmount(transaction.amountUSD)) {
        score += 30;
      }
      
      // Высокочастотная торговля (упрощенная проверка)
      const isHighFrequency = await this.checkHighFrequency(transaction.walletAddress);
      if (isHighFrequency) {
        score += 40;
      }
      
    } catch (error) {
      this.logger.debug('Error calculating exchange score:', error);
    }
    
    return Math.min(score, 100);
  }

  /**
   * 📈 RUG PULL SCORE CALCULATION
   */
  private async calculateRugPullScore(transaction: LargeTransaction): Promise<number> {
    let score = 0;
    
    try {
      // Возраст токена vs размер сделки
      const tokenAgeHours = await this.getTokenAgeHours(transaction.tokenAddress);
      
      if (tokenAgeHours < 1 && transaction.amountUSD > 5_000_000) {
        score += 25;
      } else if (tokenAgeHours < 6 && transaction.amountUSD > 10_000_000) {
        score += 20;
      } else if (tokenAgeHours < 24 && transaction.amountUSD > 20_000_000) {
        score += 15;
      }
      
      // Ликвидность vs размер сделки (если есть данные)
      const enrichedInfo = await this.getEnrichedTokenInfo(transaction.tokenAddress);
      if (enrichedInfo.liquidity && transaction.amountUSD > enrichedInfo.liquidity * 0.5) {
        score += 20;
      }
      
    } catch (error) {
      this.logger.debug('Error calculating rug pull score:', error);
    }
    
    return Math.min(score, 40);
  }

  /**
   * 🤖 BOT SCORE CALCULATION
   */
  private async calculateBotScore(transaction: LargeTransaction): Promise<number> {
    let score = 0;
    
    try {
      // Возраст кошелька (упрощенная проверка)
      const walletAgeHours = await this.getWalletAgeHours(transaction.walletAddress);
      
      if (walletAgeHours < 1) {
        score += 35;
      } else if (walletAgeHours < 24) {
        score += 20;
      } else if (walletAgeHours < 168) { // 1 неделя
        score += 10;
      }
      
      // Проверка на "идеальные" суммы
      if (this.hasRepeatingAmounts(transaction.amountUSD)) {
        score += 20;
      }
      
    } catch (error) {
      this.logger.debug('Error calculating bot score:', error);
    }
    
    return Math.min(score, 40);
  }

  /**
   * 🐳 WHALE POSITIVES CALCULATION (снижение баллов)
   */
  private async calculateWhalePositives(transaction: LargeTransaction): Promise<number> {
    let bonus = 0;
    
    try {
      // Торговля major токенами
      if (this.MAJOR_TOKENS.has(transaction.tokenAddress)) {
        bonus -= 25;
      }
      
      // Возраст токена
      const tokenAgeHours = await this.getTokenAgeHours(transaction.tokenAddress);
      if (tokenAgeHours > 72) { // 3 дня
        bonus -= 15;
      }
      
      // Пропорциональность сделки (упрощенная)
      const walletBalance = await this.getWalletTotalBalance(transaction.walletAddress);
      if (walletBalance > 0 && transaction.amountUSD < walletBalance * 0.3) {
        bonus -= 15;
      }
      
    } catch (error) {
      this.logger.debug('Error calculating whale positives:', error);
    }
    
    return Math.max(bonus, -50); // Максимальное снижение -50
  }

  /**
   * 🧠 SMART MONEY TRAITS CALCULATION (снижение баллов)  
   */
  private async calculateSmartMoneyTraits(transaction: LargeTransaction): Promise<number> {
    let bonus = 0;
    
    try {
      // Возраст кошелька
      const walletAgeHours = await this.getWalletAgeHours(transaction.walletAddress);
      
      if (walletAgeHours > 8760) { // 1 год
        bonus -= 30;
      } else if (walletAgeHours > 4380) { // 6 месяцев
        bonus -= 20;
      } else if (walletAgeHours > 720) { // 1 месяц
        bonus -= 10;
      }
      
      // Разнообразие торговли (упрощенная проверка)
      const hasDiverseActivity = await this.checkDiverseActivity(transaction.walletAddress);
      if (hasDiverseActivity) {
        bonus -= 20;
      }
      
    } catch (error) {
      this.logger.debug('Error calculating smart money traits:', error);
    }
    
    return Math.max(bonus, -50);
  }

  // ========== ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ==========

  /**
   * 📊 ПОЛУЧЕНИЕ MINT INFO
   */
  private async getMintInfo(tokenAddress: string): Promise<MintInfo> {
    try {
      // Проверяем кеш
      const cached = this.mintInfoCache.get(tokenAddress);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
        return cached.mintInfo;
      }

      // Получаем через RPC
      const response = await this.multiProvider.getAccountInfo(tokenAddress);
      
      if (!response.success || !response.data) {
        throw new Error('Failed to get mint info');
      }

      const mintInfo: MintInfo = {
        mintAuthority: response.data.mintAuthority || null,
        freezeAuthority: response.data.freezeAuthority || null,
        decimals: response.data.decimals || 9,
        supply: response.data.supply || 0
      };

      // Кешируем
      this.mintInfoCache.set(tokenAddress, {
        mintInfo,
        timestamp: Date.now()
      });

      return mintInfo;

    } catch (error) {
      this.logger.debug('Error getting mint info:', error);
      // Fallback
      return {
        mintAuthority: null,
        freezeAuthority: null,
        decimals: 9,
        supply: 0
      };
    }
  }

  /**
   * 🔄 СИМУЛЯЦИЯ ПРОДАЖИ ЧЕРЕЗ JUPITER
   */
  private async simulateJupiterSell(tokenAddress: string, testAmountUSD: number): Promise<{success: boolean, reason?: string}> {
    try {
      const testAmount = Math.floor(testAmountUSD * 1000000); // Примерное количество токенов
      
      const quoteResponse = await fetch(
        `https://quote-api.jup.ag/v6/quote?inputMint=${tokenAddress}&outputMint=So11111111111111111111111111111111111111112&amount=${testAmount}&slippageBps=300`,
        { timeout: 5000 } as any
      );
      
      if (!quoteResponse.ok) {
        return { success: false, reason: 'No sell route available' };
      }
      
      const quote: JupiterQuoteResponse = await quoteResponse.json();
      
      // Проверяем, есть ли разумный выход
      if (!quote.outAmount || parseInt(quote.outAmount) === 0) {
        return { success: false, reason: 'Zero output amount' };
      }
      
      return { success: true };
      
    } catch (error) {
      return { success: false, reason: 'Jupiter quote failed' };
    }
  }

  /**
   * ⏰ ПОЛУЧЕНИЕ ВОЗРАСТА ТОКЕНА В ЧАСАХ
   */
  private async getTokenAgeHours(tokenAddress: string): Promise<number> {
    try {
      // Упрощенная реализация - получаем первые транзакции
      const signaturesResponse = await this.multiProvider.getSignaturesForAddress(tokenAddress, { limit: 1 });
      
      if (!signaturesResponse.success || !signaturesResponse.data || signaturesResponse.data.length === 0) {
        return 0;
      }
      
      const firstSignature = signaturesResponse.data[0];
      const firstTime = firstSignature.blockTime * 1000;
      const ageMs = Date.now() - firstTime;
      
      return ageMs / (1000 * 60 * 60); // Часы
      
    } catch (error) {
      this.logger.debug('Error getting token age:', error);
      return 24; // Fallback - считаем "старым"
    }
  }

  /**
   * 👤 ПОЛУЧЕНИЕ ВОЗРАСТА КОШЕЛЬКА В ЧАСАХ
   */
  private async getWalletAgeHours(walletAddress: string): Promise<number> {
    try {
      // Получаем самые старые транзакции кошелька
      const signaturesResponse = await this.multiProvider.getSignaturesForAddress(walletAddress, { 
        limit: 1000 // Больше лимит для получения старых транзакций
      });
      
      if (!signaturesResponse.success || !signaturesResponse.data || signaturesResponse.data.length === 0) {
        return 0;
      }
      
      // Берем самую старую транзакцию
      const oldestSignature = signaturesResponse.data[signaturesResponse.data.length - 1];
      const firstTime = oldestSignature.blockTime * 1000;
      const ageMs = Date.now() - firstTime;
      
      return ageMs / (1000 * 60 * 60); // Часы
      
    } catch (error) {
      this.logger.debug('Error getting wallet age:', error);
      return 168; // Fallback - считаем "старым" (неделя)
    }
  }

  /**
   * 💰 ПОЛУЧЕНИЕ ОБЩЕГО БАЛАНСА КОШЕЛЬКА
   */
  private async getWalletTotalBalance(walletAddress: string): Promise<number> {
    try {
      const balanceResponse = await this.multiProvider.getBalance(walletAddress);
      
      if (balanceResponse.success && balanceResponse.data) {
        return balanceResponse.data.value / 1000000000; // Конвертируем в SOL
      }
      
      return 0;
      
    } catch (error) {
      this.logger.debug('Error getting wallet balance:', error);
      return 0;
    }
  }

  // ========== ПРОСТЫЕ ПРОВЕРКИ ==========

  private async checkIfTokenDeployer(walletAddress: string, tokenAddress: string): Promise<boolean> {
    // Упрощенная проверка - можно расширить
    try {
      const signatures = await this.multiProvider.getSignaturesForAddress(tokenAddress, { limit: 5 });
      if (signatures.success && signatures.data && signatures.data.length > 0) {
        // Проверяем первые транзакции
        return signatures.data.some((sig: any) => sig.memo?.includes(walletAddress));
      }
    } catch (error) {
      this.logger.debug('Error checking token deployer:', error);
    }
    return false;
  }

  private isRoundAmount(amount: number): boolean {
    const roundAmounts = [1000000, 2000000, 5000000, 10000000, 20000000, 50000000, 100000000];
    return roundAmounts.some(round => Math.abs(amount - round) < round * 0.01);
  }

  private async checkHighFrequency(walletAddress: string): Promise<boolean> {
    try {
      const signatures = await this.multiProvider.getSignaturesForAddress(walletAddress, { limit: 100 });
      if (signatures.success && signatures.data) {
        // Если больше 50 транзакций в последних 100 - высокочастотная торговля
        return signatures.data.length > 50;
      }
    } catch (error) {
      this.logger.debug('Error checking high frequency:', error);
    }
    return false;
  }

  private hasRepeatingAmounts(amount: number): boolean {
    // Проверяем на повторяющиеся цифры или "идеальные" суммы
    const amountStr = amount.toString();
    return /(\d)\1{2,}/.test(amountStr) || amount % 1000000 === 0;
  }

  private async checkDiverseActivity(walletAddress: string): Promise<boolean> {
    // Упрощенная проверка разнообразия активности
    try {
      const signatures = await this.multiProvider.getSignaturesForAddress(walletAddress, { limit: 50 });
      return signatures.success && signatures.data && signatures.data.length > 20;
    } catch (error) {
      return false;
    }
  }

  // ========== FALLBACK МЕТОДЫ ==========

  private generateFallbackSymbol(tokenAddress: string): string {
    return `TOKEN_${tokenAddress.slice(0, 6)}`;
  }

  private generateFallbackName(tokenAddress: string): string {
    return `Token ${tokenAddress.slice(0, 8)}...${tokenAddress.slice(-4)}`;
  }

  private getTokenFallbackPrice(tokenAddress: string): number {
    // Известные токены
    const knownTokenPrices: Record<string, number> = {
      'So11111111111111111111111111111111111111112': 140, // SOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 1, // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 1, // USDT
    };

    return knownTokenPrices[tokenAddress] || 0.001; // Очень низкая цена для неизвестных токенов
  }

  private detectDexFromTransaction(transaction: any): string {
    // Простая детекция DEX по program ID
    const instructions = transaction.transaction?.message?.instructions || [];
    
    for (const instruction of instructions) {
      const programId = instruction.programId;
      
      if (programId === '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM') {
        return 'Raydium';
      } else if (programId === 'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB') {
        return 'Jupiter';
      } else if (programId === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8') {
        return 'Raydium AMM';
      }
    }
    
    return 'Unknown DEX';
  }

  /**
   * 📢 ОТПРАВКА АЛЕРТА О КРУПНОЙ ТРАНЗАКЦИИ
   */
  private async sendLargeTransactionAlert(transaction: LargeTransaction): Promise<void> {
    try {
      const alertMessage = this.formatLargeTransactionMessage(transaction);
      await this.telegramNotifier.sendCycleLog(alertMessage);
      
      this.logger.info(`📢 Sent large transaction alert: ${transaction.tokenSymbol} - $${transaction.amountUSD.toLocaleString()}`);
      
    } catch (error) {
      this.logger.error('Error sending large transaction alert:', error);
    }
  }

  /**
   * 📝 ФОРМАТИРОВАНИЕ СООБЩЕНИЯ О КРУПНОЙ ТРАНЗАКЦИИ
   */
  private formatLargeTransactionMessage(transaction: LargeTransaction): string {
    const emoji = transaction.transactionType === 'buy' ? '🟢' : '🔴';
    const action = transaction.transactionType === 'buy' ? 'BOUGHT' : 'SOLD';
    
    let statusLine = '';
    if (transaction.filterReason) {
      if (transaction.filterReason.includes('GENIUS')) {
        statusLine = `\n${transaction.filterReason}`;
      } else if (transaction.filterReason.includes('WHALE')) {
        statusLine = `\n${transaction.filterReason}`;
      } else if (transaction.filterReason.includes('SUSPICIOUS')) {
        statusLine = `\n${transaction.filterReason}`;
      }
    } else {
      statusLine = '\n🚨 UNKNOWN LARGE TRADER';
    }

    return `🚨 <b>Large Transaction Alert!</b>\n\n` +
           `${emoji} <b>${action}:</b> <code>$${transaction.amountUSD.toLocaleString()}</code>\n\n` +
           `🪙 <b>Token:</b> <code>${transaction.tokenSymbol}</code> (${transaction.tokenName})\n` +
           `💰 <b>Price:</b> <code>$${transaction.tokenPrice ? transaction.tokenPrice.toFixed(6) : 'Unknown'}</code>\n` +
           `🏪 <b>DEX:</b> <code>${transaction.dex || 'Unknown'}</code>\n` +
           `👤 <b>Wallet:</b> <code>${transaction.walletAddress.slice(0, 8)}...${transaction.walletAddress.slice(-4)}</code>\n` +
           `⏰ <b>Time:</b> <code>${transaction.timestamp.toLocaleString()}</code>\n` +
           statusLine + '\n\n' +
           `<a href="https://solscan.io/tx/${transaction.signature}">📊 View Transaction</a> | ` +
           `<a href="https://solscan.io/account/${transaction.walletAddress}">👤 View Wallet</a> | ` +
           `<a href="https://solscan.io/token/${transaction.tokenAddress}">🪙 View Token</a>`;
  }

  /**
   * 🧹 ОЧИСТКА КЕШЕЙ
   */
  private startCacheCleanup(): void {
    setInterval(() => {
      const now = Date.now();
      
      // Очистка processed signatures
      let cleanedSignatures = 0;
      for (const [signature, timestamp] of this.processedSignatures) {
        if (now - timestamp > this.DUPLICATE_WINDOW) {
          this.processedSignatures.delete(signature);
          cleanedSignatures++;
        }
      }
      
      // Очистка других кешей
      this.cleanExpiredCache(this.scamAddressCache, this.CACHE_TTL);
      this.cleanExpiredCache(this.ownerAddressCache, this.CACHE_TTL);
      this.cleanExpiredCache(this.enrichedTokenCache, this.TOKEN_CACHE_TTL);
      this.cleanExpiredCache(this.mintInfoCache, this.CACHE_TTL);
      
      if (cleanedSignatures > 0) {
        this.logger.debug(`🧹 Cache cleanup: ${cleanedSignatures} signatures removed`);
      }
      
    }, 5 * 60 * 1000); // Каждые 5 минут
  }

  private cleanExpiredCache(cache: Map<string, any>, ttl: number): void {
    const now = Date.now();
    for (const [key, value] of cache) {
      if (value.timestamp && now - value.timestamp > ttl) {
        cache.delete(key);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 🛑 ЗАВЕРШЕНИЕ РАБОТЫ
   */
  async shutdown(): Promise<void> {
    this.logger.info('🔴 Shutting down LargeTransactionMonitor...');
    
    await this.stopMonitoring();
    
    // Очищаем кеши
    this.processedSignatures.clear();
    this.scamAddressCache.clear();
    this.ownerAddressCache.clear();
    this.enrichedTokenCache.clear();
    this.mintInfoCache.clear();
    
    this.logger.info('✅ LargeTransactionMonitor shutdown completed');
  }
}