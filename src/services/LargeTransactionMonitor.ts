// src/services/LargeTransactionMonitor.ts - ФАЗА 1: КРИТИЧЕСКИЕ УЛУЧШЕНИЯ с Enhanced Honeypot Detection
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

// 🆕 ФАЗА 1: Enhanced Mint Info with Token-2022 support
interface EnhancedMintInfo {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  decimals: number;
  supply: number;
  isInitialized: boolean;
  
  // 🆕 Token-2022 Extensions
  hasTransferFeeConfig: boolean;
  hasTransferHook: boolean;
  hasPermanentDelegate: boolean;
  hasNonTransferable: boolean;
  extensionTypes: string[];
  
  // 🆕 Program Information
  tokenProgram: string;
  isToken2022: boolean;
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

// 🆕 ФАЗА 1: Token Creator Analysis Result
interface TokenCreatorAnalysis {
  isDeployer: boolean;
  isMintAuthority: boolean;
  isFreezeAuthority: boolean;
  deployerConfidence: number;
  firstTransactionRole: 'creator' | 'early_buyer' | 'liquidity_provider' | 'unknown';
  creationTimeDistance: number; // minutes since token creation
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
  private mintInfoCache = new Map<string, { mintInfo: EnhancedMintInfo; timestamp: number }>();
  
  // 🆕 ФАЗА 1: Новые кеши для улучшенного анализа
  private tokenCreatorCache = new Map<string, { analysis: TokenCreatorAnalysis; timestamp: number }>();
  private tokenAgeCache = new Map<string, { ageHours: number; timestamp: number }>();
  private walletHistoryCache = new Map<string, { ageHours: number; txCount: number; timestamp: number }>();
  
  // Время жизни кешей
  private readonly CACHE_TTL = 60 * 60 * 1000; // 1 час
  private readonly TOKEN_CACHE_TTL = 10 * 60 * 1000; // 10 минут для токенов
  private readonly CREATOR_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 часа для creator analysis
  
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
  
  // 🆕 ФАЗА 1: Token Program IDs
  private readonly TOKEN_PROGRAMS = {
    TOKEN_PROGRAM: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    TOKEN_2022_PROGRAM: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    ASSOCIATED_TOKEN_PROGRAM: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
  };
  
  // 🆕 ФАЗА 1: Enhanced Filter Thresholds
  private readonly FILTER_THRESHOLDS = {
    SCAM_AUTO_BLOCK: 100,        // Мгновенная блокировка без уведомлений
    HIGH_RISK_BLOCK: 70,         // Блокировать с уведомлением  
    SUSPICIOUS_WARNING: 30,       // Отправить с предупреждением
    LEGITIMATE_THRESHOLD: 0       // Отправить как обычно
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
    this.logger.info('🚨 LargeTransactionMonitor initialized with ФАЗА 1 ENHANCED FILTERING (Token-2022 + Advanced Creator Detection)');
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
        `🚨 <b>Large Transaction Monitor Started (ФАЗА 1 ENHANCED)</b>\n\n` +
        `💰 <b>Threshold:</b> <code>$${this.TRANSACTION_THRESHOLD_USD.toLocaleString()}</code>\n` +
        `⏰ <b>Scan Interval:</b> <code>${this.SCAN_INTERVAL_MS / 1000}s</code>\n` +
        `📡 <b>Data Source:</b> <code>MultiProvider (QuickNode + Alchemy)</code>\n` +
        `🏷️ <b>Token Metadata:</b> <code>TokenMetadataService (Jupiter + Birdeye)</code>\n` +
        `🛡️ <b>ФАЗА 1 Filtering:</b>\n` +
        `  • Enhanced Honeypot Detection (Token-2022)\n` +
        `  • Advanced Creator Analysis\n` +
        `  • Jupiter Sell Simulation\n` +
        `  • Smart Money Genius Check (-100 score)\n` +
        `  • Exchange Internal Transfer Detection\n\n` +
        `🎯 <b>Starting Slot:</b> <code>${this.lastProcessedSlot}</code>\n` +
        `⏰ <code>${new Date().toLocaleString()}</code>`
      );

      this.logger.info('✅ Large transaction monitoring started successfully with ФАЗА 1 enhancements');

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
      `🔬 <b>ФАЗА 1 Filter Performance:</b>\n` +
      Object.entries(this.stats.filterReasons).map(([reason, count]) => 
        `• ${reason}: <code>${count}</code>`
      ).join('\n') +
      `\n\n⏰ <code>${new Date().toLocaleString()}</code>`
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

      // 🛡️ ПРИМЕНЯЕМ ФАЗА 1 МЕГА-ФИЛЬТРЫ
      const filterResult = await this.applyPhase1MegaFilters(swapInfo);
      
      if (filterResult.shouldFilter) {
        this.stats.filtered++;
        this.stats.filterReasons[filterResult.reason || 'unknown'] = (this.stats.filterReasons[filterResult.reason || 'unknown'] || 0) + 1;
        
        // Логируем только если это не автоблокировка скама
        if (filterResult.reason !== 'SCAM_AUTO_BLOCKED') {
          this.logger.info(`🚫 Filtered large transaction: ${filterResult.reason} (score: ${filterResult.riskScore})`);
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
      const tokenInfo = await this.tokenMetadataService.getTokenMetadata(tokenAddress);
      
      let enrichedInfo: TokenMetadata;
      
      if (tokenInfo) {
        const price = await this.tokenMetadataService.getTokenPrice(tokenAddress);
        enrichedInfo = {
          symbol: tokenInfo.symbol || this.generateFallbackSymbol(tokenAddress),
          name: tokenInfo.name || this.generateFallbackName(tokenAddress),
          price: price || this.getTokenFallbackPrice(tokenAddress)
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
   * 🛡️ ФАЗА 1: МЕГА-ФИЛЬТРАЦИЯ С УЛУЧШЕНИЯМИ
   */
  private async applyPhase1MegaFilters(transaction: LargeTransaction): Promise<FilterResult> {
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
      
      // 2.1 ФАЗА 1: Enhanced Honeypot Detection
      const honeypotScore = await this.calculateEnhancedHoneypotScore(transaction);
      riskScore += honeypotScore;
      if (honeypotScore > 0) reasons.push(`Honeypot(${honeypotScore})`);
      
      // 2.2 ФАЗА 1: Advanced Token Creator Detection  
      const creatorScore = await this.calculateAdvancedCreatorScore(transaction);
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
      this.logger.error('Error applying ФАЗА 1 mega filters:', error);
      return { shouldFilter: false, riskScore: 0 };
    }
  }

  /**
   * 🍯 ФАЗА 1: ENHANCED HONEYPOT SCORE CALCULATION
   */
  private async calculateEnhancedHoneypotScore(transaction: LargeTransaction): Promise<number> {
    let score = 0;
    
    try {
      // Получаем enhanced mint info с Token-2022 поддержкой
      const mintInfo = await this.getEnhancedMintInfo(transaction.tokenAddress);
      
      // ✅ ФАЗА 1: Активный freeze authority
      if (mintInfo.freezeAuthority !== null) {
        score += 40;
        this.logger.debug(`🔒 Token has freeze authority: ${mintInfo.freezeAuthority}`);
      }
      
      // ✅ ФАЗА 1: Активный mint authority
      if (mintInfo.mintAuthority !== null) {
        score += 35;
        this.logger.debug(`🏭 Token has mint authority: ${mintInfo.mintAuthority}`);
      }
      
      // ✅ ФАЗА 1: Token-2022 Extensions (НОВОЕ!)
      if (mintInfo.isToken2022) {
        if (mintInfo.hasTransferFeeConfig) {
          score += 25; // Transfer fees могут блокировать продажи
          this.logger.debug(`💸 Token-2022 has transfer fee config`);
        }
        
        if (mintInfo.hasTransferHook) {
          score += 30; // Transfer hooks могут блокировать транзакции
          this.logger.debug(`🪝 Token-2022 has transfer hook`);
        }
        
        if (mintInfo.hasNonTransferable) {
          score += 100; // Нетрансферабельные токены = мгновенная блокировка
          this.logger.debug(`🚫 Token-2022 is non-transferable`);
        }
        
        if (mintInfo.hasPermanentDelegate) {
          score += 20; // Permanent delegate может контролировать токены
          this.logger.debug(`👤 Token-2022 has permanent delegate`);
        }
        
        // Дополнительная проверка неизвестных расширений
        if (mintInfo.extensionTypes.length > 2) {
          score += 15; // Много расширений подозрительно
          this.logger.debug(`⚠️ Token-2022 has many extensions: ${mintInfo.extensionTypes.join(', ')}`);
        }
      }
      
      // ✅ ФАЗА 1: Симуляция продажи через Jupiter
      const canSell = await this.simulateJupiterSell(transaction.tokenAddress, 1000);
      if (!canSell.success) {
        score += 30;
        this.logger.debug(`💔 Jupiter sell simulation failed: ${canSell.reason}`);
      }
      
      // ✅ ФАЗА 1: Проверка кастомной программы токена (НОВОЕ!)
      const isCustomProgram = await this.checkCustomTokenProgram(transaction.tokenAddress);
      if (isCustomProgram) {
        score += 25;
        this.logger.debug(`🛠️ Token uses custom program`);
      }
      
    } catch (error) {
      this.logger.debug('Error calculating enhanced honeypot score:', error);
    }
    
    return Math.min(score, 100); // Максимум 100
  }

  /**
   * 👨‍💻 ФАЗА 1: ADVANCED TOKEN CREATOR SCORE CALCULATION
   */
  private async calculateAdvancedCreatorScore(transaction: LargeTransaction): Promise<number> {
    let score = 0;
    
    try {
      // Получаем enhanced creator analysis
      const creatorAnalysis = await this.analyzeTokenCreator(transaction.walletAddress, transaction.tokenAddress);
      
      // ✅ ФАЗА 1: Кошелек = mint authority
      if (creatorAnalysis.isMintAuthority) {
        score += 40;
        this.logger.debug(`🏭 Wallet is mint authority`);
      }
      
      // ✅ ФАЗА 1: Кошелек = freeze authority
      if (creatorAnalysis.isFreezeAuthority) {
        score += 35;
        this.logger.debug(`🔒 Wallet is freeze authority`);
      }
      
      // ✅ ФАЗА 1: Detailed deployer analysis (НОВОЕ!)
      if (creatorAnalysis.isDeployer) {
        score += Math.min(creatorAnalysis.deployerConfidence, 30);
        this.logger.debug(`🚀 Wallet is token deployer (confidence: ${creatorAnalysis.deployerConfidence}%)`);
      }
      
      // ✅ ФАЗА 1: Роль в первых транзакциях (НОВОЕ!)
      switch (creatorAnalysis.firstTransactionRole) {
        case 'creator':
          score += 25;
          this.logger.debug(`👨‍💻 Wallet is token creator`);
          break;
        case 'liquidity_provider':
          score += 15; // Добавление ликвидности сразу после создания подозрительно
          this.logger.debug(`💧 Wallet added initial liquidity`);
          break;
        case 'early_buyer':
          // Раннее покупатели не всегда плохо, но очень близко к созданию подозрительно
          if (creatorAnalysis.creationTimeDistance < 5) { // Менее 5 минут
            score += 20;
            this.logger.debug(`⚡ Wallet bought within ${creatorAnalysis.creationTimeDistance} minutes of creation`);
          }
          break;
      }
      
      // ✅ ФАЗА 1: Временная близость к созданию токена (НОВОЕ!)
      if (creatorAnalysis.creationTimeDistance < 60) { // Менее часа
        const proximityScore = Math.max(0, 20 - (creatorAnalysis.creationTimeDistance / 3));
        score += proximityScore;
        this.logger.debug(`⏱️ Transaction within ${creatorAnalysis.creationTimeDistance} minutes of token creation`);
      }
      
    } catch (error) {
      this.logger.debug('Error calculating advanced creator score:', error);
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

  // ========== ФАЗА 1: НОВЫЕ ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ==========

  /**
   * 📊 ФАЗА 1: ENHANCED MINT INFO with Token-2022 Support
   */
  private async getEnhancedMintInfo(tokenAddress: string): Promise<EnhancedMintInfo> {
    try {
      // Проверяем кеш
      const cached = this.mintInfoCache.get(tokenAddress);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
        return cached.mintInfo;
      }

      // Получаем raw account info через RPC
      const response = await this.multiProvider.getAccountInfo(tokenAddress);
      
      if (!response.success || !response.data) {
        throw new Error('Failed to get mint info');
      }

      const accountData = response.data;
      let mintInfo: EnhancedMintInfo;

      // Определяем тип программы токена
      const tokenProgram = accountData.owner || '';
      const isToken2022 = tokenProgram === this.TOKEN_PROGRAMS.TOKEN_2022_PROGRAM;

      if (isToken2022) {
        // ✅ ФАЗА 1: Парсим Token-2022 с расширениями
        mintInfo = await this.parseToken2022MintInfo(accountData);
      } else {
        // Обычный токен программы
        mintInfo = await this.parseStandardMintInfo(accountData);
      }

      // Кешируем
      this.mintInfoCache.set(tokenAddress, {
        mintInfo,
        timestamp: Date.now()
      });

      this.logger.debug(`📊 Parsed mint info for ${tokenAddress}: Token-2022=${isToken2022}, Extensions=${mintInfo.extensionTypes.length}`);
      return mintInfo;

    } catch (error) {
      this.logger.debug('Error getting enhanced mint info:', error);
      // Fallback
      return {
        mintAuthority: null,
        freezeAuthority: null,
        decimals: 9,
        supply: 0,
        isInitialized: false,
        hasTransferFeeConfig: false,
        hasTransferHook: false,
        hasPermanentDelegate: false,
        hasNonTransferable: false,
        extensionTypes: [],
        tokenProgram: this.TOKEN_PROGRAMS.TOKEN_PROGRAM,
        isToken2022: false
      };
    }
  }

  /**
   * 🆕 ФАЗА 1: Parse Token-2022 Mint Info (SAFE PARSING)
   */
  private async parseToken2022MintInfo(accountData: any): Promise<EnhancedMintInfo> {
    try {
      // ✅ БЕЗОПАСНЫЙ парсинг с fallback значениями
      const parsed = accountData?.parsed?.info || {};
      const extensions = parsed?.extensions || [];
      
      let mintInfo: EnhancedMintInfo = {
        mintAuthority: this.safeGetStringValue(parsed.mintAuthority),
        freezeAuthority: this.safeGetStringValue(parsed.freezeAuthority),
        decimals: this.safeGetNumberValue(parsed.decimals, 9),
        supply: this.safeGetNumberValue(parsed.supply, 0),
        isInitialized: parsed.isInitialized === true,
        hasTransferFeeConfig: false,
        hasTransferHook: false,
        hasPermanentDelegate: false,
        hasNonTransferable: false,
        extensionTypes: [],
        tokenProgram: this.TOKEN_PROGRAMS.TOKEN_2022_PROGRAM,
        isToken2022: true
      };

      // ✅ ФАЗА 1: БЕЗОПАСНЫЙ парсинг Token-2022 расширений
      if (Array.isArray(extensions)) {
        for (const extension of extensions) {
          try {
            const extensionType = extension?.extension || extension?.type || 'unknown';
            if (typeof extensionType === 'string') {
              mintInfo.extensionTypes.push(extensionType);
              
              switch (extensionType.toLowerCase()) {
                case 'transferfeeconfig':
                case 'transfer_fee_config':
                  mintInfo.hasTransferFeeConfig = true;
                  this.logger.debug(`💸 Found transfer fee config in Token-2022`);
                  break;
                case 'transferhook':
                case 'transfer_hook':
                  mintInfo.hasTransferHook = true;
                  this.logger.debug(`🪝 Found transfer hook in Token-2022`);
                  break;
                case 'permanentdelegate':
                case 'permanent_delegate':
                  mintInfo.hasPermanentDelegate = true;
                  this.logger.debug(`👤 Found permanent delegate in Token-2022`);
                  break;
                case 'nontransferable':
                case 'non_transferable':
                  mintInfo.hasNonTransferable = true;
                  this.logger.debug(`🚫 Found non-transferable extension in Token-2022`);
                  break;
                default:
                  this.logger.debug(`❓ Unknown Token-2022 extension: ${extensionType}`);
              }
            }
          } catch (extError) {
            this.logger.debug('Error parsing individual extension:', extError);
            continue; // Пропускаем проблемные расширения
          }
        }
      }

      return mintInfo;

    } catch (error) {
      this.logger.debug('Error parsing Token-2022 mint info:', error);
      // Возвращаем базовую структуру даже при ошибке
      return {
        mintAuthority: null,
        freezeAuthority: null,
        decimals: 9,
        supply: 0,
        isInitialized: false,
        hasTransferFeeConfig: false,
        hasTransferHook: false,
        hasPermanentDelegate: false,
        hasNonTransferable: false,
        extensionTypes: [],
        tokenProgram: this.TOKEN_PROGRAMS.TOKEN_2022_PROGRAM,
        isToken2022: true
      };
    }
  }

  /**
   * 🆕 ФАЗА 1: Parse Standard Token Mint Info (SAFE PARSING)
   */
  private async parseStandardMintInfo(accountData: any): Promise<EnhancedMintInfo> {
    try {
      const parsed = accountData?.parsed?.info || {};
      
      return {
        mintAuthority: this.safeGetStringValue(parsed.mintAuthority),
        freezeAuthority: this.safeGetStringValue(parsed.freezeAuthority),
        decimals: this.safeGetNumberValue(parsed.decimals, 9),
        supply: this.safeGetNumberValue(parsed.supply, 0),
        isInitialized: parsed.isInitialized === true,
        hasTransferFeeConfig: false,
        hasTransferHook: false,
        hasPermanentDelegate: false,
        hasNonTransferable: false,
        extensionTypes: [],
        tokenProgram: this.TOKEN_PROGRAMS.TOKEN_PROGRAM,
        isToken2022: false
      };
    } catch (error) {
      this.logger.debug('Error parsing standard mint info:', error);
      // Безопасный fallback
      return {
        mintAuthority: null,
        freezeAuthority: null,
        decimals: 9,
        supply: 0,
        isInitialized: false,
        hasTransferFeeConfig: false,
        hasTransferHook: false,
        hasPermanentDelegate: false,
        hasNonTransferable: false,
        extensionTypes: [],
        tokenProgram: this.TOKEN_PROGRAMS.TOKEN_PROGRAM,
        isToken2022: false
      };
    }
  }

  // ========== БЕЗОПАСНЫЕ ПАРСИНГ МЕТОДЫ ==========

  private safeGetStringValue(value: any): string | null {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
    return null;
  }

  private safeGetNumberValue(value: any, defaultValue: number = 0): number {
    if (typeof value === 'number' && !isNaN(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = parseInt(value);
      if (!isNaN(parsed)) {
        return parsed;
      }
    }
    return defaultValue;
  }

  /**
   * 🆕 ФАЗА 1: Advanced Token Creator Analysis (API OPTIMIZED)
   */
  private async analyzeTokenCreator(walletAddress: string, tokenAddress: string): Promise<TokenCreatorAnalysis> {
    try {
      // Проверяем кеш
      const cacheKey = `${walletAddress}_${tokenAddress}`;
      const cached = this.tokenCreatorCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.CREATOR_CACHE_TTL) {
        return cached.analysis;
      }

      // ✅ ОПТИМИЗАЦИЯ: Сначала проверяем mint info (быстро)
      const mintInfo = await this.getEnhancedMintInfo(tokenAddress);
      const isMintAuthority = mintInfo.mintAuthority === walletAddress;
      const isFreezeAuthority = mintInfo.freezeAuthority === walletAddress;
      
      // ✅ КОНСЕРВАТИВНЫЙ подход: если уже есть прямые доказательства - не делаем дорогой анализ
      if (isMintAuthority || isFreezeAuthority) {
        const analysis: TokenCreatorAnalysis = {
          isDeployer: true,
          isMintAuthority,
          isFreezeAuthority,
          deployerConfidence: isMintAuthority ? 70 : 50, // Консервативные значения
          firstTransactionRole: 'creator',
          creationTimeDistance: 0
        };
        
        // Кешируем результат
        this.tokenCreatorCache.set(cacheKey, {
          analysis,
          timestamp: Date.now()
        });
        
        this.logger.debug(`🔍 Creator analysis (FAST): deployer=true, mint=${isMintAuthority}, freeze=${isFreezeAuthority}`);
        return analysis;
      }
      
      // ✅ УСЛОВНЫЙ дорогой анализ: только если нет прямых доказательств
      // ✅ ИСПРАВЛЕНО: Явная типизация для firstTxAnalysis
      let firstTxAnalysis: { 
        role: 'creator' | 'early_buyer' | 'liquidity_provider' | 'unknown'; 
        timeDistance: number; 
      } = { role: 'unknown', timeDistance: 9999 };
      
      // Только для подозрительных случаев делаем дорогой анализ транзакций
      try {
        // ✅ ИСПРАВЛЕНО: Результат analyzeFirstTokenTransactions теперь совместим по типу
        const analysisResult = await this.analyzeFirstTokenTransactions(walletAddress, tokenAddress);
        firstTxAnalysis = analysisResult; 
      } catch (error) {
        this.logger.debug('Failed first tx analysis, using conservative fallback:', error);
        // firstTxAnalysis останется { role: 'unknown', timeDistance: 9999 }
      }
      
      // ✅ КОНСЕРВАТИВНЫЙ расчет confidence score
      let deployerConfidence = 0;
      if (isMintAuthority) deployerConfidence += 40; // Предполагается, что isMintAuthority определена ранее
      if (isFreezeAuthority) deployerConfidence += 30; // Предполагается, что isFreezeAuthority определена ранее
      
      // ✅ Теперь это сравнение корректно
      if (firstTxAnalysis.role === 'creator') deployerConfidence += 20; 
      
      const analysis: TokenCreatorAnalysis = {
        isDeployer: deployerConfidence >= 40, // Повысили порог с 50 до 40
        isMintAuthority,
        isFreezeAuthority,
        deployerConfidence,
        firstTransactionRole: firstTxAnalysis.role,
        creationTimeDistance: firstTxAnalysis.timeDistance
      };

      // Кешируем результат
      this.tokenCreatorCache.set(cacheKey, {
        analysis,
        timestamp: Date.now()
      });

      this.logger.debug(`🔍 Creator analysis for ${walletAddress}: deployer=${analysis.isDeployer} (${deployerConfidence}%), role=${analysis.firstTransactionRole}`);
      return analysis;

    } catch (error) {
      this.logger.debug('Error analyzing token creator:', error);
      // ✅ БЕЗОПАСНЫЙ fallback
      return {
        isDeployer: false,
        isMintAuthority: false,
        isFreezeAuthority: false,
        deployerConfidence: 0,
        firstTransactionRole: 'unknown',
        creationTimeDistance: 9999
      };
    }
  }

  /**
   * 🆕 ФАЗА 1: Analyze First Token Transactions (API OPTIMIZED)
   */
  private async analyzeFirstTokenTransactions(walletAddress: string, tokenAddress: string): Promise<{
    role: 'creator' | 'early_buyer' | 'liquidity_provider' | 'unknown';
    timeDistance: number;
  }> {
    try {
      // ✅ ОПТИМИЗАЦИЯ: Получаем только 5 первых транзакций вместо 10
      const signaturesResponse = await this.multiProvider.getSignaturesForAddress(tokenAddress, { 
        limit: 5  // Уменьшили лимит для экономии API credits
      });
      
      if (!signaturesResponse.success || !signaturesResponse.data || signaturesResponse.data.length === 0) {
        return { role: 'unknown', timeDistance: 9999 };
      }

      const signatures = signaturesResponse.data;
      const tokenCreationTime = signatures[signatures.length - 1].blockTime * 1000; // Самая старая транзакция
      
      // ✅ ОПТИМИЗАЦИЯ: Анализируем максимум 3 транзакции вместо всех
      const maxTransactionsToAnalyze = Math.min(signatures.length, 3);
      
      // Ищем первые транзакции с участием нашего кошелька
      for (let i = signatures.length - 1; i >= signatures.length - maxTransactionsToAnalyze; i--) {
        const sig = signatures[i];
        
        try {
          const txResponse = await this.multiProvider.getTransaction(sig.signature);
          if (!txResponse.success || !txResponse.data) continue;
          
          const transaction = txResponse.data;
          const accountKeys = transaction.transaction?.message?.accountKeys || [];
          
          // Проверяем участие кошелька в транзакции
          const walletInvolved = accountKeys.some((key: any) => 
            (typeof key === 'string' ? key : key.pubkey) === walletAddress
          );
          
          if (walletInvolved) {
            const txTime = sig.blockTime * 1000;
            const timeDistance = Math.floor((txTime - tokenCreationTime) / (60 * 1000)); // В минутах
            
            // ✅ КОНСЕРВАТИВНЫЙ анализ типа транзакции (меньше false positives)
            const instructions = transaction.transaction?.message?.instructions || [];
            const role = this.determineTransactionRoleConservative(instructions, walletAddress);
            
            this.logger.debug(`🕒 Found wallet ${walletAddress} in token ${tokenAddress} transaction: role=${role}, distance=${timeDistance}min`);
            return { role, timeDistance: Math.max(0, timeDistance) };
          }
        } catch (error) {
          this.logger.debug(`Error analyzing transaction ${sig.signature}:`, error);
          continue;
        }
        
        // ✅ Небольшая пауза между getTransaction вызовами
        await this.sleep(50);
      }
      
      return { role: 'unknown', timeDistance: 9999 };

    } catch (error) {
      this.logger.debug('Error analyzing first token transactions:', error);
      return { role: 'unknown', timeDistance: 9999 };
    }
  }

  /**
   * 🆕 ФАЗА 1: Determine Transaction Role (CONSERVATIVE VERSION)
   */
  private determineTransactionRoleConservative(instructions: any[], walletAddress: string): 'creator' | 'early_buyer' | 'liquidity_provider' | 'unknown' {
    try {
      let hasTokenCreation = false;
      let hasLiquidityAction = false;
      let hasTransfer = false;
      
      for (const instruction of instructions) {
        try {
          const programId = instruction?.programId;
          if (!programId) continue;
          
          // ✅ КОНСЕРВАТИВНАЯ проверка создания токена/mint
          if (programId === this.TOKEN_PROGRAMS.TOKEN_PROGRAM || 
              programId === this.TOKEN_PROGRAMS.TOKEN_2022_PROGRAM) {
            
            const instructionType = instruction?.parsed?.type;
            if (instructionType === 'initializeMint' || 
                instructionType === 'createAccount' ||
                instructionType === 'initializeAccount') {
              hasTokenCreation = true;
            }
          }
          
          // ✅ КОНСЕРВАТИВНАЯ проверка добавления ликвидности (только известные программы)
          if (programId === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8' || // Raydium AMM
              programId === '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM') {   // Raydium V4
            
            const accounts = instruction?.accounts || [];
            if (Array.isArray(accounts) && accounts.includes(walletAddress)) {
              hasLiquidityAction = true;
            }
          }
          
          // ✅ КОНСЕРВАТИВНАЯ проверка переводов токенов
          if (instruction?.parsed?.type === 'transfer' || 
              instruction?.parsed?.type === 'transferChecked') {
            hasTransfer = true;
          }
        } catch (instructionError) {
          // Пропускаем проблемные инструкции
          continue;
        }
      }
      
      // ✅ КОНСЕРВАТИВНАЯ логика определения роли
      if (hasTokenCreation) {
        return 'creator';
      }
      
      if (hasLiquidityAction) {
        return 'liquidity_provider';
      }
      
      if (hasTransfer) {
        return 'early_buyer';
      }
      
      return 'unknown';

    } catch (error) {
      this.logger.debug('Error determining transaction role:', error);
      return 'unknown';
    }
  }

  /**
   * 🆕 ФАЗА 1: Check Custom Token Program (CONSERVATIVE)
   */
  private async checkCustomTokenProgram(tokenAddress: string): Promise<boolean> {
    try {
      const response = await this.multiProvider.getAccountInfo(tokenAddress);
      
      if (!response.success || !response.data) {
        return false; // Консервативно возвращаем false при ошибке
      }

      const owner = response.data?.owner;
      if (!owner || typeof owner !== 'string') {
        return false;
      }
      
      // ✅ КОНСЕРВАТИВНАЯ проверка: только явно НЕ стандартные программы
      const isStandardProgram = owner === this.TOKEN_PROGRAMS.TOKEN_PROGRAM || 
                               owner === this.TOKEN_PROGRAMS.TOKEN_2022_PROGRAM ||
                               owner === this.TOKEN_PROGRAMS.ASSOCIATED_TOKEN_PROGRAM;
      
      if (!isStandardProgram) {
        this.logger.debug(`🛠️ Token ${tokenAddress} uses custom program: ${owner}`);
        return true;
      }
      
      return false;

    } catch (error) {
      this.logger.debug('Error checking custom token program:', error);
      return false; // Консервативно возвращаем false при ошибке
    }
  }

  /**
   * 🔄 СИМУЛЯЦИЯ ПРОДАЖИ ЧЕРЕЗ JUPITER
   */
  private async simulateJupiterSell(tokenAddress: string, testAmountUSD: number): Promise<{success: boolean, reason?: string}> {
    try {
      const testAmount = Math.floor(testAmountUSD * 1000000); // Примерное количество токенов
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const quoteResponse = await fetch(
        `https://quote-api.jup.ag/v6/quote?inputMint=${tokenAddress}&outputMint=So11111111111111111111111111111111111111112&amount=${testAmount}&slippageBps=300`,
        { signal: controller.signal }
      );
      
      clearTimeout(timeoutId);
      
      if (!quoteResponse.ok) {
        return { success: false, reason: 'No sell route available' };
      }
      
      const quoteData: any = await quoteResponse.json();
      
      // Проверяем, есть ли разумный выход
      if (!quoteData.outAmount || parseInt(quoteData.outAmount || '0') === 0) {
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
      // Проверяем кеш
      const cached = this.tokenAgeCache.get(tokenAddress);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
        return cached.ageHours;
      }

      // Получаем первые транзакции
      const signaturesResponse = await this.multiProvider.getSignaturesForAddress(tokenAddress, { limit: 1 });
      
      if (!signaturesResponse.success || !signaturesResponse.data || signaturesResponse.data.length === 0) {
        return 0;
      }
      
      const firstSignature = signaturesResponse.data[0];
      const firstTime = firstSignature.blockTime * 1000;
      const ageMs = Date.now() - firstTime;
      const ageHours = ageMs / (1000 * 60 * 60);
      
      // Кешируем
      this.tokenAgeCache.set(tokenAddress, {
        ageHours,
        timestamp: Date.now()
      });
      
      return ageHours;
      
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
      // Проверяем кеш
      const cached = this.walletHistoryCache.get(walletAddress);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
        return cached.ageHours;
      }

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
      const ageHours = ageMs / (1000 * 60 * 60);
      
      // Кешируем
      this.walletHistoryCache.set(walletAddress, {
        ageHours,
        txCount: signaturesResponse.data.length,
        timestamp: Date.now()
      });
      
      return ageHours;
      
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

    return `🚨 <b>Large Transaction Alert! (ФАЗА 1 FILTERED)</b>\n\n` +
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
      this.cleanExpiredCache(this.tokenCreatorCache, this.CREATOR_CACHE_TTL);
      this.cleanExpiredCache(this.tokenAgeCache, this.CACHE_TTL);
      this.cleanExpiredCache(this.walletHistoryCache, this.CACHE_TTL);
      
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
    this.tokenCreatorCache.clear();
    this.tokenAgeCache.clear();
    this.walletHistoryCache.clear();
    
    this.logger.info('✅ LargeTransactionMonitor shutdown completed (ФАЗА 1 ENHANCED)');
  }
}