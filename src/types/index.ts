// src/types/index.ts - 🔥 ПРОТОКОЛ "ЖЕЛЕЗНЫЙ ДОЛЛАР": Модернизация "Паспортов Сделки"

// ===== ОСНОВНЫЕ ТИПЫ ТРАНЗАКЦИЙ =====

export interface TokenSwap {
  transactionId: string;
  walletAddress: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  amount: number;
  amountUSD: number;
  timestamp: Date;
  dex: string;
  isNewWallet: boolean;
  isReactivatedWallet: boolean;
  daysSinceLastActivity: number;
  price?: number;
  swapType?: 'buy' | 'sell';
  // 🆕 ПОЛЯ ДЛЯ POSITION AGGREGATION
  isAggregated?: boolean;
  aggregationId?: number;
  suspicionScore?: number;
  // 🔥 КРИТИЧЕСКИЕ ДОБАВЛЕНИЯ для отладки USD расчетов
  decimals?: number;
  rawTokenAmount?: number;
  actualTokenAmount?: number;
  // 🔥🔥🔥 ПРОТОКОЛ "ЖЕЛЕЗНЫЙ ДОЛЛАР" - НОВЫЕ ПОЛЯ ДЛЯ TokenSwap 🔥🔥🔥
  paymentTokenSymbol?: string;    // Символ платежного токена (SOL, USDC)
  paymentTokenAmount?: number;    // ТОЧНОЕ количество платежного токена
  paymentTokenPrice?: number;     // ТОЧНАЯ цена платежного токена
}

export interface WalletInfo {
  address: string;
  createdAt: Date;
  lastActivityAt: Date;
  isNew: boolean;
  isReactivated: boolean;
  relatedWallets?: string[];
  tradingHistory?: TradingHistory;
  suspicionScore?: number;
  insiderFlags?: string[];
}

export interface TradingHistory {
  totalTrades: number;
  winRate: number;
  avgBuySize: number;
  maxBuySize: number;
  minBuySize: number;
  sizeProgression: number[];
  timeProgression: Date[];
  panicSells: number;
  fomoeBuys: number;
  fakeLosses: number;
}

export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number; // 🔥 КРИТИЧЕСКИ ВАЖНО для правильного расчета USD
  createdAt?: Date;
  isNew?: boolean;
  launchPrice?: number;
  currentPrice?: number;
}

export interface TokenAggregation {
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  totalVolumeUSD: number;
  uniqueWallets: Set<string>;
  transactions: TokenSwap[];
  isNewToken: boolean;
  biggestPurchase?: TokenSwap;
  firstPurchaseTime: Date;
  lastPurchaseTime: Date;
  avgWalletAge: number;
  suspiciousWallets: number;
}

export interface SmartMoneyReport {
  period: string;
  tokenAggregations: TokenAggregation[];
  totalVolumeUSD: number;
  uniqueTokensCount: number;
  bigOrders: TokenSwap[];
  insiderAlerts: InsiderAlert[];
}

export interface InsiderAlert {
  walletAddress: string;
  tokenSwap?: TokenSwap;
  tokenAddress?: string;
  tokenSymbol?: string;
  amountUSD?: number;
  price?: number;
  signalStrength?: number;
  timestamp?: Date;
  suspicionScore: number;
  detectionReasons: string[];
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  confidence: number;
  tradingHistory: TradingHistory;
}

export interface SolanaTransaction {
  signature: string;
  timestamp: number;
  slot: number;
  blockTime: number;
  fee: number;
  feePayer: string;
  instructions: any[];
  events?: any[];
  nativeTransfers?: any[];
  tokenTransfers?: any[];
  accountData?: any[];
  transactionError?: any;
}

// ===== SMART MONEY ТИПЫ - 🔥 CLEAN SLATE VERSION =====

export interface SmartMoneyWallet {
  address: string;
  category: 'sniper' | 'hunter' | 'trader';
  nickname?: string;
  
  // 🔥 ТОЛЬКО РЕАЛЬНЫЕ ПОЛЯ ИЗ CSV BULK WALLET CHECKER
  usdProfit7d: number;           // Прибыль за 7 дней - КЛЮЧЕВОЕ ПОЛЕ
  usdProfit30d: number;          // Прибыль за 30 дней  
  winrate7d: number;             // Винрейт за 7 дней - КЛЮЧЕВОЕ ПОЛЕ  
  buy7d: number;                 // Покупки за 7 дней - показатель активности
  avgHoldingMins: number;        // Среднее время держания в минутах
  totalProfitPercent: number;    // Общий процент прибыли
  solBalance: number;            // Баланс SOL
  
  // Системные поля
  performanceScore: number;
  lastActiveAt: Date;
  isActive: boolean;
  
  // Остальные поля остаются как есть
  sharpeRatio?: number;
  maxDrawdown?: number;
  volumeScore?: number;
  
  // Family поля ОТКЛЮЧЕНЫ - всегда false/undefined
  isFamilyMember?: false; // всегда false
  familyAddresses?: undefined; // всегда undefined
  coordinationScore?: 0; // всегда 0
  stealthLevel?: number;
  
  // Категория-специфичные метрики
  earlyEntryRate?: number;
  
  createdAt?: Date;
  updatedAt?: Date;
}

export interface SmartMoneyFlow {
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  period: '1h' | '24h';
  totalInflowUSD: number;
  totalOutflowUSD: number;
  netFlowUSD: number;
  uniqueWallets: number;
  avgTradeSize: number;
  topWallets: Array<{
    address: string;
    amountUSD: number;
    category: string;
  }>;
}

export interface HotNewToken {
  address: string;
  symbol: string;
  name: string;
  fdv: number;
  smStakeUSD: number;
  ageHours: number;
  buyVolumeUSD: number;
  sellVolumeUSD: number;
  buyCount: number;
  sellCount: number;
  uniqueSmWallets: number;
  topBuyers: Array<{
    address: string;
    amountUSD: number;
    category: string;
  }>;
}

export interface SmartMoneySwap {
  transactionId: string;
  walletAddress: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  tokenAmount: number;
  amountUSD: number;
  swapType: 'buy' | 'sell';
  timestamp: Date;
  
  // 🔥 ТОЛЬКО CSV МЕТРИКИ - Smart Money кошелек
  category: 'sniper' | 'hunter' | 'trader';
  usdProfit7d: number;           // CSV поле
  winrate7d: number;             // CSV поле
  buy7d: number;                 // CSV поле
  tokenPrice?: number;
  
  // Family поля ОТКЛЮЧЕНЫ - всегда false/0/undefined
  isFamilyMember: false; // всегда false
  familySize?: 0; // всегда 0
  familyId?: undefined; // всегда undefined
  
  // 🔥🔥🔥 ПРОТОКОЛ "ЖЕЛЕЗНЫЙ ДОЛЛАР" - КЛЮЧЕВЫЕ ПОЛЯ 🔥🔥🔥
  paymentTokenSymbol?: string;    // Символ платежного токена (SOL, USDC)
  paymentTokenAmount?: number;    // ТОЧНОЕ количество платежного токена
  paymentTokenPrice?: number;     // ТОЧНАЯ цена платежного токена
  
  // 🔥 КРИТИЧЕСКИЕ ДОБАВЛЕНИЯ для отладки USD расчетов
  decimals?: number;
  rawTokenAmount?: number;
  actualTokenAmount?: number;
  isCexListed?: boolean;
}

// ===== ТИПЫ ДЛЯ АГРЕГАЦИИ ПОЗИЦИЙ =====

export interface PositionPurchase {
  transactionId: string;
  amountUSD: number;
  tokenAmount: number;
  price: number;
  timestamp: Date;
}

export interface AggregatedPosition {
  walletAddress: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  
  // Покупки
  purchases: PositionPurchase[];
  totalUSD: number;
  totalTokens: number;
  avgPrice: number;
  purchaseCount: number;
  
  // Временные рамки
  firstBuyTime: Date;
  lastBuyTime: Date;
  timeWindowMinutes: number;
  
  // Метрики разбивки
  avgPurchaseSize: number;
  maxPurchaseSize: number;
  minPurchaseSize: number;
  sizeStandardDeviation: number;
  sizeCoefficient: number; // Коэффициент вариации
  
  // Детекция паттерна
  hasSimilarSizes: boolean;
  sizeTolerance: number; // В процентах
  suspicionScore: number; // 0-100
}

export interface PositionAggregation {
  id: number;
  walletAddress: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  totalUSD: number;
  purchaseCount: number;
  avgPurchaseSize: number;
  timeWindowMinutes: number;
  suspicionScore: number; // 0-100
  sizeTolerance: number;
  firstBuyTime: Date;
  lastBuyTime: Date;
  detectedAt: Date;
  purchases: Array<{
    transactionId: string;
    amountUSD: number;
    timestamp: Date;
  }>;
  // Дополнительные поля для анализа
  maxPurchaseSize: number;
  minPurchaseSize: number;
  sizeStdDeviation: number;
  sizeCoefficient: number;
  similarSizeCount: number;
  walletAgeDays: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  isProcessed: boolean;
  alertSent: boolean;
}

export interface PositionSplittingAlert {
  walletAddress: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  totalUSD: number;
  purchaseCount: number;
  avgPurchaseSize: number;
  timeWindowMinutes: number;
  suspicionScore: number;
  sizeTolerance: number;
  firstBuyTime: Date;
  lastBuyTime: Date;
  purchases: Array<{
    amountUSD: number;
    timestamp: Date;
    transactionId: string;
  }>;
}

export interface SavedPositionAggregation {
  id: number;
  walletAddress: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  totalUSD: number;
  purchaseCount: number;
  avgPurchaseSize: number;
  timeWindowMinutes: number;
  suspicionScore: number;
  sizeTolerance: number;
  firstBuyTime: Date;
  lastBuyTime: Date;
  detectedAt: Date;
  purchases: Array<{
    transactionId: string;
    amountUSD: number;
    timestamp: Date;
  }>;
}

export interface PositionAggregationStats {
  totalPositions: number;
  highSuspicionPositions: number; // score >= 75
  totalValueUSD: number;
  avgSuspicionScore: number;
  topWalletsByPositions: Array<{
    walletAddress: string;
    positionCount: number;
    totalValueUSD: number;
  }>;
  unprocessedPositions: number;
  alertsSent: number;
  riskDistribution: {
    high: number;
    medium: number;
    low: number;
  };
}

export interface SimilarPurchaseGroup {
  count: number;
  avgAmount: number;
  tolerance: number;
  amounts: number[];
}

export interface PositionDetectionConfig {
  timeWindowMinutes: number;        // 90 минут по умолчанию
  minPurchaseCount: number;         // Минимум 3 покупки
  minTotalUSD: number;              // Минимум $10K общая сумма
  maxIndividualUSD: number;         // Максимум $8K за одну покупку
  similarSizeTolerance: number;     // 2% отклонение считается "одинаковой суммой"
  minSimilarPurchases: number;      // Минимум 3 похожие покупки
  positionTimeoutMinutes: number;   // 180 минут таймаут для закрытия позиции
  minSuspicionScore: number;        // Минимальный score для алерта
  minWalletAge: number;            // Минимум 7 дней возраст кошелька
  maxWalletActivity: number;       // Максимум 100 транзакций за день (анти-бот)
}

export interface WalletFilterResult {
  passed: boolean;
  reason?: string;
  timestamp: Date;
  consecutiveFailures: number;
  lastSuccessTime?: Date;
}

// ===== ТИПЫ ДЛЯ MULTIPROVIDER SERVICE =====

export interface ProviderConfig {
  name: string;
  type: 'quicknode' | 'alchemy' | 'genesysgo' | 'triton';
  baseUrl: string;
  apiKey: string;
  
  // Лимиты
  requestsPerMinute: number;
  requestsPerDay: number;
  requestsPerMonth: number;
  
  // Приоритет и надежность
  priority: number; // 1-5, где 5 = высший приоритет
  reliability: number; // 0-100, статистическая надежность
  
  // Специализация
  specialties: string[]; // ['rpc', 'enhanced', 'analytics', 'webhooks']
  
  // Временные ограничения
  timeout: number; // миллисекунды
  retryAttempts: number;
  retryDelay: number;
}

export interface APIResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  provider: string;
  responseTime: number;
  retryCount: number;
  fromCache?: boolean;
  rateLimitRemaining?: number;
  rateLimitReset?: number;
}

export interface ProviderStats {
  name: string;
  type: string;
  requestCount: number;
  errorCount: number;
  successRate: number;
  avgResponseTime: number;
  isHealthy: boolean;
  priority: number;
  
  // Лимиты
  currentMinuteRequests: number;
  currentDayRequests: number;
  currentMonthRequests: number;
  minuteUsage: number; // процент
  dayUsage: number; // процент
  monthUsage: number; // процент
  
  // Ошибки
  lastError?: string;
  lastErrorTime?: Date;
  consecutiveErrors: number;
  
  // Производительность
  minResponseTime: number;
  maxResponseTime: number;
  responseTimeHistory: number[]; // последние 100 запросов
  
  // Совместимость со старым интерфейсом
  dailyUsage: number;
  hourlyUsage: number;
  totalUsage: number;
  lastReset: Date;
  isAvailable: boolean;
}

export interface LoadBalancingResult {
  provider: ProviderConfig;
  fallbackUsed: boolean;
  totalProviders: number;
  healthyProviders: number;
  responseTime: number;
  retries: number;
}

export interface RetryConfig {
  maxAttempts: number;
  baseDelay: number; // миллисекунды
  maxDelay: number; // миллисекунды
  backoffMultiplier: number; // экспоненциальная задержка
  retryOnErrors: string[]; // коды ошибок для retry
  retryOnTimeout: boolean;
  retryOnRateLimit: boolean;
}

export interface HealthCheckResult {
  provider: string;
  isHealthy: boolean;
  responseTime: number;
  error?: string;
  timestamp: Date;
  consecutiveFailures: number;
  lastSuccessTime?: Date;
}

export interface MultiProviderMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  avgResponseTime: number;
  
  // Провайдеры
  totalProviders: number;
  healthyProviders: number;
  primaryProvider: string;
  
  // Кеш
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;
  cacheSize: number;
  
  // Failover
  failovers: number;
  lastFailoverTime?: Date;
  
  // Распределение нагрузки
  providerDistribution: Record<string, number>;
}

// ===== ТИПЫ ДЛЯ КЕШИРОВАНИЯ =====

export interface CacheEntry<T = any> {
  data: T;
  timestamp: number;
  expiresAt: number;
  provider: string;
  hitCount: number;
}

export interface CacheConfig {
  enabled: boolean;
  defaultTTL: number; // секунды
  maxSize: number; // максимальное количество записей
  cleanupInterval: number; // секунды
  
  // TTL для разных типов запросов
  methodTTL: Record<string, number>;
}

// ===== СТАТИСТИКА И МОНИТОРИНГ =====

export interface DatabaseStats {
  totalTransactions: number;
  totalWallets: number;
  last24hTransactions: number;
  avgTransactionSize: number;
  positionAggregations: number;
  highSuspicionPositions: number;
  aggregatedTransactions: number;
  insiderAlerts: number;
  unprocessedAlerts: number;
  providerStats: Array<{
    name: string;
    requests: number;
    errors: number;
    successRate: number;
  }>;
}

export interface ProcessingStats {
  totalTransactionsProcessed: number;
  smartMoneyTransactions: number;
  regularTransactions: number;
  positionAggregations: number;
  suspiciousPositions: number;
  alertsSent: number;
  filteredTransactions: number;
  errorCount: number;
  avgProcessingTime: number;
  lastProcessedTime: Date;
  
  // Детальная статистика по типам
  transactionTypes: {
    swaps: number;
    transfers: number;
    other: number;
  };
  
  // Уровни риска
  riskLevels: {
    high: number;
    medium: number;
    low: number;
  };
}

// ===== ТИПЫ ДЛЯ ВНЕШНЕГО ПОИСКА КОШЕЛЬКОВ =====

export interface WalletPerformanceMetrics {
  // 🔥 ТОЛЬКО CSV ПОЛЯ
  usdProfit7d: number;
  usdProfit30d: number;
  winrate7d: number;
  buy7d: number;
  avgHoldingMins: number;
  totalProfitPercent: number;
  solBalance: number;
  performanceScore?: number; // общий скор 0-100 (опционально для обратной совместимости)
  recentActivity: Date;
  volumeScore?: number;
}

export interface WalletAnalysisResult {
  address: string;
  isSmartMoney: boolean;
  category?: 'sniper' | 'hunter' | 'trader';
  metrics: WalletPerformanceMetrics;
  disqualificationReasons: string[];
  analysis?: {
    totalTransactions: number;
    analyzedPeriod: string;
    confidenceScore: number;
  };
  // Family поля БЛОКИРОВАНЫ - всегда пустой массив
  familyConnections: []; // всегда пустой массив
}

export interface ExternalTokenCandidate {
  address: string;
  source: 'dexscreener' | 'jupiter';
  volume24h?: number;
  liquidity?: number;
  marketCap?: number;
  age?: number; // days since creation
  score?: number;
}

export interface ExternalWalletCandidate {
  address: string;
  score: number;
  reasons: string[];
  lastActivity: Date;
  estimatedVolume: number;
  tokenCount: number;
  source: 'token_holders' | 'recent_traders' | 'high_volume';
}

export interface ApiCreditUsage {
  provider: 'quicknode' | 'alchemy';
  operation: string;
  credits: number;
  timestamp: Date;
  success: boolean;
}

export interface CreditManagerStats {
  currentProvider: string;
  providers: Record<string, ProviderStats>;
  totalCreditsToday: number;
  remainingCreditsToday: number;
  hourlyRate: number;
  projectedDailyUsage: number;
}

export interface DiscoveryStats {
  isRunning: boolean;
  externalSearchEnabled: boolean;
  lastRun?: Date;
  totalAnalyzed: number;
  smartMoneyFound: number;
  newWalletsAdded: number;
  discoveryRate: number;
  creditStats?: CreditManagerStats;
  externalSources?: {
    dexscreener: { requests: number; tokens: number };
    jupiter: { requests: number; tokens: number };
  };
}

export interface ProviderHealth {
  name: string;
  isHealthy: boolean;
  lastCheck: Date;
  responseTime: number;
  errorRate: number;
  consecutiveFailures: number;
  lastSuccessTime?: Date;
}

export interface ProviderStatsExtended {
  quicknode: ProviderStats;
  alchemy: ProviderStats;
  [key: string]: ProviderStats;
}

export interface AdvancedPositionAnalysis {
  walletAddress: string;
  analysisType: 'position_splitting' | 'coordinated_buying' | 'wash_trading';
  confidence: number; // 0-100
  riskScore: number; // 0-100
  
  patterns: Array<{
    type: string;
    description: string;
    evidence: any[];
    severity: 'low' | 'medium' | 'high' | 'critical';
  }>;
  
  recommendations: string[];
  shouldAlert: boolean;
  shouldBlock: boolean;
}

export interface PositionMonitoringConfig {
  enabled: boolean;
  
  // Thresholds
  minPositionSize: number; // USD
  maxPositionSplits: number;
  timeWindowHours: number;
  
  // Detection sensitivity
  sizeSimilarityThreshold: number; // percentage
  timingThreshold: number; // minutes
  suspicionThreshold: number; // 0-100
  
  // Actions
  autoAlert: boolean;
  autoBlock: boolean;
  telegramNotifications: boolean;
  
  // Advanced features
  mlDetection: boolean;
  behaviorAnalysis: boolean;
  networkAnalysis: boolean;
}

export interface WalletRiskProfile {
  address: string;
  overallRisk: number; // 0-100
  lastUpdated: Date;
  
  riskFactors: {
    newWallet: boolean;
    highActivity: boolean;
    suspiciousPatterns: boolean;
    relatedToKnownActors: boolean;
    positionSplitting: boolean;
    washTrading: boolean;
    frontRunning: boolean;
  };
  
  behaviorMetrics: {
    avgTransactionSize: number;
    transactionFrequency: number;
    tradingHours: number[];
    preferredTokens: string[];
    gasUsagePattern: string;
  };
  
  networkConnections: {
    directConnections: string[];
    clusterMembership: string[];
    suspiciousConnections: number;
  };
}

export interface SmartMoneyDetectionResult {
  isSmartMoney: boolean;
  confidence: number;
  category: 'sniper' | 'hunter' | 'trader' | 'unknown';
  
  indicators: {
    earlyEntry: boolean;
    highWinRate: boolean;
    largeTrades: boolean;
    consistentProfits: boolean;
    timeConsistency: boolean;
  };
  
  metrics: {
    // 🔥 ТОЛЬКО CSV ПОЛЯ
    usdProfit7d: number;
    usdProfit30d: number;
    winrate7d: number;
    buy7d: number;
    avgHoldingMins: number;
    totalProfitPercent: number;
    solBalance: number;
  };
  
  redFlags: string[];
  recommendation: 'monitor' | 'add_to_smart_money' | 'investigate' | 'ignore';
}