// src/services/Database.ts - 🔥 ИСПРАВЛЕНО ПОД УПРОЩЕННЫЙ TokenSwap
import BetterSqlite3 from 'better-sqlite3';
import { TokenSwap, WalletInfo, PositionAggregation } from '../types';
import { Logger } from '../utils/Logger';
import path from 'path';
import fs from 'fs';

export class Database {
  deduplicateTransactions() {
    throw new Error('Method not implemented.');
  }
  private db: BetterSqlite3.Database;
  private logger: Logger;
  
  // 🚀 PERFORMANCE OPTIMIZATIONS
  private queryCache: Map<string, { result: any; timestamp: number; ttl: number }> = new Map();
  private preparedStatements: Map<string, BetterSqlite3.Statement> = new Map();
  private batchOperations: Map<string, any[]> = new Map();
  private maintenanceInterval: NodeJS.Timeout | null = null;
  
  // Cache TTL values (в миллисекундах)
  private readonly CACHE_TTL = {
    SHORT: 30000,    // 30 seconds
    MEDIUM: 300000,  // 5 minutes  
    LONG: 1800000    // 30 minutes
  };

  constructor() {
    this.logger = Logger.getInstance();
    const dbPath = process.env.DATABASE_PATH || './data/tracker.db';

    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new BetterSqlite3(dbPath);
    this.optimizeDatabase();
    this.startMaintenanceScheduler();
  }

  // 🚀 DATABASE OPTIMIZATION
  private optimizeDatabase(): void {
    try {
      // Enable WAL mode for better performance
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('cache_size = 1000');
      this.db.pragma('temp_store = MEMORY');
      this.db.pragma('mmap_size = 67108864'); // 64MB
      
      this.logger.info('✅ Database optimizations applied');
    } catch (error) {
      this.logger.warn('⚠️ Some database optimizations failed:', error);
    }
  }

  // 🔧 MAINTENANCE SCHEDULER
  private startMaintenanceScheduler(): void {
    // Запускаем maintenance каждые 2 часа
    this.maintenanceInterval = setInterval(async () => {
      await this.performMaintenance();
    }, 2 * 60 * 60 * 1000);

    this.logger.info('🔧 Database maintenance scheduler started');
  }

  // 🧹 MAINTENANCE
  private async performMaintenance(): Promise<void> {
    try {
      // Очистка кеша
      this.clearExpiredCache();
      
      // Оптимизация базы данных
      this.db.pragma('optimize');
      
      this.logger.debug('🧹 Database maintenance completed');
    } catch (error) {
      this.logger.error('❌ Database maintenance failed:', error);
    }
  }

  // 🔄 CACHE MANAGEMENT
  private getCached<T>(key: string): T | null {
    const cached = this.queryCache.get(key);
    if (!cached) return null;
    
    if (Date.now() - cached.timestamp > cached.ttl) {
      this.queryCache.delete(key);
      return null;
    }
    
    return cached.result as T;
  }

  private setCache(key: string, result: any, ttl: number): void {
    this.queryCache.set(key, {
      result,
      timestamp: Date.now(),
      ttl
    });
  }

  private clearExpiredCache(): void {
    const now = Date.now();
    for (const [key, cached] of this.queryCache.entries()) {
      if (now - cached.timestamp > cached.ttl) {
        this.queryCache.delete(key);
      }
    }
  }

  // 📝 PREPARED STATEMENTS
  private getPreparedStatement(id: string, sql: string): BetterSqlite3.Statement {
    if (!this.preparedStatements.has(id)) {
      this.preparedStatements.set(id, this.db.prepare(sql));
    }
    return this.preparedStatements.get(id)!;
  }

  // 🚀 BATCH OPERATIONS
  async executeBatch<T>(operationType: string, items: T[], processor: (item: T) => void): Promise<void> {
    if (items.length === 0) return;

    const transaction = this.db.transaction(() => {
      for (const item of items) {
        processor(item);
      }
    });

    try {
      transaction();
      this.logger.debug(`✅ Batch ${operationType}: processed ${items.length} items`);
    } catch (error) {
      this.logger.error(`❌ Batch ${operationType} failed:`, error);
      throw error;
    }
  }

  async init(): Promise<void> {
    try {
      // 🔧 СОЗДАЕМ ВСЕ ТАБЛИЦЫ С УПРОЩЕННОЙ СХЕМОЙ token_swaps
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS token_swaps (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          transaction_id TEXT UNIQUE NOT NULL,
          wallet_address TEXT NOT NULL,
          token_address TEXT NOT NULL,
          token_symbol TEXT NOT NULL,
          token_name TEXT NOT NULL,
          amount REAL NOT NULL,
          amount_usd REAL NOT NULL,
          timestamp DATETIME NOT NULL,
          dex TEXT NOT NULL,
          is_new_wallet BOOLEAN NOT NULL,
          is_reactivated_wallet BOOLEAN NOT NULL,
          days_since_last_activity INTEGER NOT NULL,
          price REAL,
          swap_type TEXT CHECK (swap_type IN ('buy', 'sell')),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          is_aggregated BOOLEAN DEFAULT 0,
          aggregation_id INTEGER,
          suspicion_score INTEGER DEFAULT 0,
          aggregation_group TEXT
        );

        CREATE TABLE IF NOT EXISTS wallets (
          address TEXT PRIMARY KEY,
          created_at DATETIME NOT NULL,
          last_activity_at DATETIME NOT NULL,
          is_new BOOLEAN NOT NULL,
          is_reactivated BOOLEAN NOT NULL,
          related_wallets TEXT,
          suspicion_score REAL DEFAULT 0,
          insider_flags TEXT,
          total_trades INTEGER DEFAULT 0,
          win_rate REAL DEFAULT 0,
          avg_buy_size REAL DEFAULT 0,
          max_buy_size REAL DEFAULT 0,
          min_buy_size REAL DEFAULT 0,
          panic_sells INTEGER DEFAULT 0,
          fomo_buys INTEGER DEFAULT 0,
          fake_losses INTEGER DEFAULT 0,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS position_aggregations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          wallet_address TEXT NOT NULL,
          token_address TEXT NOT NULL,
          token_symbol TEXT NOT NULL,
          token_name TEXT NOT NULL,
          total_usd REAL NOT NULL,
          purchase_count INTEGER NOT NULL,
          avg_purchase_size REAL NOT NULL,
          time_window_minutes REAL NOT NULL,
          suspicion_score INTEGER NOT NULL,
          size_tolerance REAL NOT NULL,
          first_buy_time DATETIME NOT NULL,
          last_buy_time DATETIME NOT NULL,
          purchase_details TEXT NOT NULL,
          detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          aggregation_id TEXT UNIQUE,
          confidence_level REAL DEFAULT 0,
          has_similar_sizes BOOLEAN DEFAULT 0,
          max_purchase_size REAL DEFAULT 0,
          min_purchase_size REAL DEFAULT 0,
          size_std_deviation REAL DEFAULT 0,
          size_coefficient REAL DEFAULT 0,
          similar_size_count INTEGER DEFAULT 0,
          wallet_age_days INTEGER DEFAULT 0,
          is_processed BOOLEAN DEFAULT 0,
          alert_sent BOOLEAN DEFAULT 0,
          processed_at DATETIME,
          risk_level TEXT DEFAULT 'MEDIUM',
          UNIQUE(wallet_address, token_address, first_buy_time)
        );

        CREATE TABLE IF NOT EXISTS insider_alerts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          wallet_address TEXT NOT NULL,
          detection_method TEXT NOT NULL,
          confidence_score INTEGER NOT NULL,
          evidence_data TEXT NOT NULL,
          alert_type TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          processed BOOLEAN DEFAULT 0,
          reported BOOLEAN DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS provider_stats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider_name TEXT NOT NULL,
          provider_type TEXT NOT NULL,
          request_count INTEGER DEFAULT 0,
          error_count INTEGER DEFAULT 0,
          avg_response_time REAL DEFAULT 0,
          last_used DATETIME DEFAULT CURRENT_TIMESTAMP,
          status TEXT DEFAULT 'healthy',
          priority INTEGER DEFAULT 3,
          daily_requests INTEGER DEFAULT 0,
          daily_errors INTEGER DEFAULT 0,
          daily_reset DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS whale_transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          transaction_id TEXT UNIQUE NOT NULL,
          wallet_address TEXT NOT NULL,
          token_address TEXT NOT NULL,
          token_symbol TEXT NOT NULL,
          amount_usd REAL NOT NULL,
          swap_type TEXT NOT NULL,
          source TEXT NOT NULL,
          timestamp DATETIME NOT NULL,
          processed BOOLEAN DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS token_name_patterns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pattern TEXT NOT NULL,
          first_seen DATETIME NOT NULL,
          token_count INTEGER DEFAULT 1,
          max_holders_token TEXT,
          max_holders_count INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // 🚀 СОЗДАЕМ ИНДЕКСЫ ДЛЯ ПРОИЗВОДИТЕЛЬНОСТИ
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_token_swaps_wallet ON token_swaps(wallet_address);
        CREATE INDEX IF NOT EXISTS idx_token_swaps_token ON token_swaps(token_address);
        CREATE INDEX IF NOT EXISTS idx_token_swaps_timestamp ON token_swaps(timestamp);
        CREATE INDEX IF NOT EXISTS idx_token_swaps_amount_usd ON token_swaps(amount_usd);
        CREATE INDEX IF NOT EXISTS idx_token_swaps_dex ON token_swaps(dex);
        CREATE INDEX IF NOT EXISTS idx_token_swaps_aggregated ON token_swaps(is_aggregated);
        
        CREATE INDEX IF NOT EXISTS idx_wallets_created ON wallets(created_at);
        CREATE INDEX IF NOT EXISTS idx_wallets_last_activity ON wallets(last_activity_at);
        CREATE INDEX IF NOT EXISTS idx_wallets_suspicion ON wallets(suspicion_score);
        
        CREATE INDEX IF NOT EXISTS idx_position_aggregations_wallet ON position_aggregations(wallet_address);
        CREATE INDEX IF NOT EXISTS idx_position_aggregations_token ON position_aggregations(token_address);
        CREATE INDEX IF NOT EXISTS idx_position_aggregations_processed ON position_aggregations(is_processed);
        CREATE INDEX IF NOT EXISTS idx_position_aggregations_alert ON position_aggregations(alert_sent);
        CREATE INDEX IF NOT EXISTS idx_position_aggregations_risk ON position_aggregations(risk_level);
        CREATE INDEX IF NOT EXISTS idx_position_aggregations_detected ON position_aggregations(detected_at);
        
        CREATE INDEX IF NOT EXISTS idx_insider_alerts_processed ON insider_alerts(processed);
        CREATE INDEX IF NOT EXISTS idx_insider_alerts_wallet ON insider_alerts(wallet_address);
        CREATE INDEX IF NOT EXISTS idx_insider_alerts_created ON insider_alerts(created_at);
        
        CREATE INDEX IF NOT EXISTS idx_provider_stats_name ON provider_stats(provider_name);
        CREATE INDEX IF NOT EXISTS idx_provider_stats_type ON provider_stats(provider_type);
        
        CREATE INDEX IF NOT EXISTS idx_whale_transactions_timestamp ON whale_transactions(timestamp);
        CREATE INDEX IF NOT EXISTS idx_whale_transactions_usd ON whale_transactions(amount_usd);
        CREATE INDEX IF NOT EXISTS idx_whale_transactions_processed ON whale_transactions(processed);
      `);

      this.logger.info('✅ Database initialized successfully with optimizations (SIMPLIFIED TokenSwap schema)');
    } catch (error) {
      this.logger.error('❌ Error initializing database:', error);
      throw error;
    }
  }

  // 🔍 TRANSACTION METHODS
  async isTransactionProcessed(transactionId: string): Promise<boolean> {
    const cacheKey = `tx_processed_${transactionId}`;
    const cached = this.getCached<boolean>(cacheKey);
    if (cached !== null) return cached;

    const stmt = this.getPreparedStatement('tx_exists', 
      'SELECT 1 FROM token_swaps WHERE transaction_id = ?'
    );
    
    const result = !!stmt.get(transactionId);
    this.setCache(cacheKey, result, this.CACHE_TTL.SHORT);
    return result;
  }

  // 🔥 ИСПРАВЛЕНО: Убрали поля pnl, multiplier, winrate, time_to_target, wallet_age
  async saveTransaction(swap: TokenSwap): Promise<void> {
    const stmt = this.getPreparedStatement('save_transaction', `
      INSERT OR REPLACE INTO token_swaps (
        transaction_id, wallet_address, token_address, token_symbol, token_name,
        amount, amount_usd, timestamp, dex, is_new_wallet, is_reactivated_wallet,
        days_since_last_activity, price, swap_type,
        is_aggregated, aggregation_id, suspicion_score, aggregation_group
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      stmt.run(
        swap.transactionId,
        swap.walletAddress,
        swap.tokenAddress,
        swap.tokenSymbol,
        swap.tokenName,
        swap.amount,
        swap.amountUSD,
        swap.timestamp.toISOString(),
        swap.dex,
        swap.isNewWallet ? 1 : 0,
        swap.isReactivatedWallet ? 1 : 0,
        swap.daysSinceLastActivity,
        swap.price || null,
        swap.swapType || null,
        swap.isAggregated ? 1 : 0,
        swap.aggregationId || null,
        swap.suspicionScore || 0,
        null // aggregation_group
      );

      // Очистка связанного кеша
      this.queryCache.delete(`tx_processed_${swap.transactionId}`);
      
    } catch (error) {
      this.logger.error('Error saving transaction:', error);
      throw error;
    }
  }

  // 🔍 WALLET METHODS
  async saveWallet(walletInfo: WalletInfo): Promise<void> {
    const stmt = this.getPreparedStatement('save_wallet', `
      INSERT OR REPLACE INTO wallets (
        address, created_at, last_activity_at, is_new, is_reactivated,
        related_wallets, suspicion_score, insider_flags, total_trades,
        win_rate, avg_buy_size, max_buy_size, min_buy_size,
        panic_sells, fomo_buys, fake_losses, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    stmt.run(
      walletInfo.address,
      walletInfo.createdAt.toISOString(),
      walletInfo.lastActivityAt.toISOString(),
      walletInfo.isNew ? 1 : 0,
      walletInfo.isReactivated ? 1 : 0,
      walletInfo.relatedWallets ? JSON.stringify(walletInfo.relatedWallets) : null,
      walletInfo.suspicionScore || 0,
      walletInfo.insiderFlags ? JSON.stringify(walletInfo.insiderFlags) : null,
      walletInfo.tradingHistory?.totalTrades || 0,
      walletInfo.tradingHistory?.winRate || 0,
      walletInfo.tradingHistory?.avgBuySize || 0,
      walletInfo.tradingHistory?.maxBuySize || 0,
      walletInfo.tradingHistory?.minBuySize || 0,
      walletInfo.tradingHistory?.panicSells || 0,
      walletInfo.tradingHistory?.fomoeBuys || 0,
      walletInfo.tradingHistory?.fakeLosses || 0
    );
  }

  async getWallet(address: string): Promise<WalletInfo | null> {
    const cacheKey = `wallet_${address}`;
    const cached = this.getCached<WalletInfo>(cacheKey);
    if (cached) return cached;

    const stmt = this.getPreparedStatement('get_wallet',
      'SELECT * FROM wallets WHERE address = ?'
    );
    
    const row = stmt.get(address) as any;
    if (!row) return null;

    const wallet: WalletInfo = {
      address: row.address,
      createdAt: new Date(row.created_at),
      lastActivityAt: new Date(row.last_activity_at),
      isNew: !!row.is_new,
      isReactivated: !!row.is_reactivated,
      relatedWallets: row.related_wallets ? JSON.parse(row.related_wallets) : undefined,
      suspicionScore: row.suspicion_score,
      insiderFlags: row.insider_flags ? JSON.parse(row.insider_flags) : undefined,
      tradingHistory: {
        totalTrades: row.total_trades,
        winRate: row.win_rate,
        avgBuySize: row.avg_buy_size,
        maxBuySize: row.max_buy_size,
        minBuySize: row.min_buy_size,
        sizeProgression: [],
        timeProgression: [],
        panicSells: row.panic_sells,
        fomoeBuys: row.fomo_buys,
        fakeLosses: row.fake_losses
      }
    };

    this.setCache(cacheKey, wallet, this.CACHE_TTL.LONG);
    return wallet;
  }

  // 🔍 QUERY METHODS с кешированием
  async getTransactionsByWallet(walletAddress: string, limit: number = 100): Promise<TokenSwap[]> {
    const cacheKey = `wallet_txs_${walletAddress}_${limit}`;
    const cached = this.getCached<TokenSwap[]>(cacheKey);
    if (cached) return cached;

    const stmt = this.getPreparedStatement('get_wallet_transactions', `
      SELECT * FROM token_swaps 
      WHERE wallet_address = ? 
      ORDER BY timestamp DESC 
      LIMIT ?
    `);

    const rows = stmt.all(walletAddress, limit) as any[];
    const transactions = rows.map(row => this.mapRowToTransaction(row));
    
    this.setCache(cacheKey, transactions, this.CACHE_TTL.SHORT);
    return transactions;
  }

  async getTransactionsByToken(tokenAddress: string, limit: number = 100): Promise<TokenSwap[]> {
    const cacheKey = `token_txs_${tokenAddress}_${limit}`;
    const cached = this.getCached<TokenSwap[]>(cacheKey);
    if (cached) return cached;

    const stmt = this.getPreparedStatement('get_token_transactions', `
      SELECT * FROM token_swaps 
      WHERE token_address = ? 
      ORDER BY timestamp DESC 
      LIMIT ?
    `);

    const rows = stmt.all(tokenAddress, limit) as any[];
    const transactions = rows.map(row => this.mapRowToTransaction(row));
    
    this.setCache(cacheKey, transactions, this.CACHE_TTL.SHORT);
    return transactions;
  }

  // НЕДОСТАЮЩИЕ МЕТОДЫ для совместимости
  async getTransactionsByTokenAddress(tokenAddress: string, limit: number = 100): Promise<TokenSwap[]> {
    // Alias для getTransactionsByToken
    return this.getTransactionsByToken(tokenAddress, limit);
  }

  async getWalletTransactionsAfter(walletAddress: string, afterDate: Date): Promise<TokenSwap[]> {
    const cacheKey = `wallet_txs_after_${walletAddress}_${afterDate.getTime()}`;
    const cached = this.getCached<TokenSwap[]>(cacheKey);
    if (cached) return cached;

    const stmt = this.getPreparedStatement('get_wallet_transactions_after', `
      SELECT * FROM token_swaps 
      WHERE wallet_address = ? AND timestamp > ?
      ORDER BY timestamp DESC
    `);

    const rows = stmt.all(walletAddress, afterDate.toISOString()) as any[];
    const transactions = rows.map(row => this.mapRowToTransaction(row));
    
    this.setCache(cacheKey, transactions, this.CACHE_TTL.SHORT);
    return transactions;
  }

  async getRecentTransactions(hours: number = 24): Promise<TokenSwap[]> {
    const cacheKey = `recent_txs_${hours}`;
    const cached = this.getCached<TokenSwap[]>(cacheKey);
    if (cached) return cached;

    const hoursAgo = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    
    const stmt = this.getPreparedStatement('get_recent_transactions', `
      SELECT * FROM token_swaps 
      WHERE timestamp > ?
      ORDER BY timestamp DESC
    `);

    const rows = stmt.all(hoursAgo) as any[];
    const transactions = rows.map(row => this.mapRowToTransaction(row));
    
    this.setCache(cacheKey, transactions, this.CACHE_TTL.SHORT);
    return transactions;
  }

  // 📈 POSITION AGGREGATION METHODS
  async savePositionAggregation(aggregation: any): Promise<number> {
    const stmt = this.getPreparedStatement('save_aggregation', `
      INSERT INTO position_aggregations (
        wallet_address, token_address, token_symbol, token_name,
        total_usd, purchase_count, avg_purchase_size, time_window_minutes,
        suspicion_score, size_tolerance, first_buy_time, last_buy_time,
        purchase_details, aggregation_id, confidence_level, has_similar_sizes,
        max_purchase_size, min_purchase_size, size_std_deviation,
        size_coefficient, similar_size_count, wallet_age_days, risk_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      aggregation.walletAddress,
      aggregation.tokenAddress,
      aggregation.tokenSymbol,
      aggregation.tokenName,
      aggregation.totalUSD,
      aggregation.purchaseCount,
      aggregation.avgPurchaseSize,
      aggregation.timeWindowMinutes,
      aggregation.suspicionScore,
      aggregation.sizeTolerance,
      aggregation.firstBuyTime.toISOString(),
      aggregation.lastBuyTime.toISOString(),
      JSON.stringify(aggregation.purchases),
      aggregation.aggregationId,
      aggregation.confidenceLevel || 0,
      aggregation.hasSimilarSizes ? 1 : 0,
      aggregation.maxPurchaseSize || 0,
      aggregation.minPurchaseSize || 0,
      aggregation.sizeStdDeviation || 0,
      aggregation.sizeCoefficient || 0,
      aggregation.similarSizeCount || 0,
      aggregation.walletAgeDays || 0,
      aggregation.riskLevel || 'MEDIUM'
    );

    return result.lastInsertRowid as number;
  }

  // 🔍 TOKEN NAME PATTERN METHODS
  private normalizeTokenName(name: string): string {
    return name.toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .substring(0, 20);
  }

  async checkTokenNamePattern(tokenName: string, tokenAddress: string, holders: number): Promise<{
    shouldAlert: boolean;
    tokenAddress?: string;
    holders?: number;
    similarCount?: number;
  }> {
    const normalizedName = this.normalizeTokenName(tokenName);
    
    const existingPattern = this.getPreparedStatement('get_token_pattern', `
      SELECT * FROM token_name_patterns 
      WHERE pattern = ? 
      AND created_at > datetime('now', '-24 hours')
    `).get(normalizedName) as any;

    if (existingPattern) {
      if (holders > existingPattern.max_holders_count) {
        this.getPreparedStatement('update_token_pattern_max', `
          UPDATE token_name_patterns 
          SET token_count = token_count + 1,
              max_holders_token = ?,
              max_holders_count = ?
          WHERE id = ?
        `).run(tokenAddress, holders, existingPattern.id);
      } else {
        this.getPreparedStatement('update_token_pattern_count', `
          UPDATE token_name_patterns 
          SET token_count = token_count + 1
          WHERE id = ?
        `).run(existingPattern.id);
      }

      const shouldAlert = existingPattern.token_count + 1 >= 5 && 
                         Math.max(holders, existingPattern.max_holders_count) >= 70;
      
      if (shouldAlert) {
        return {
          shouldAlert: true,
          tokenAddress: holders > existingPattern.max_holders_count ? tokenAddress : existingPattern.max_holders_token,
          holders: Math.max(holders, existingPattern.max_holders_count),
          similarCount: existingPattern.token_count + 1
        };
      }
      
      return { shouldAlert: false };
    } else {
      this.getPreparedStatement('insert_token_pattern', `
        INSERT INTO token_name_patterns 
        (pattern, first_seen, token_count, max_holders_token, max_holders_count)
        VALUES (?, datetime('now'), 1, ?, ?)
      `).run(normalizedName, tokenAddress, holders);

      return { shouldAlert: false };
    }
  }

  // 🚨 INSIDER ALERTS
  async saveInsiderAlert(alert: {
    walletAddress: string;
    detectionMethod: string;
    confidenceScore: number;
    evidenceData: any;
    alertType: string;
  }): Promise<void> {
    const stmt = this.getPreparedStatement('save_insider_alert', `
      INSERT INTO insider_alerts (
        wallet_address, detection_method, confidence_score,
        evidence_data, alert_type
      ) VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(
      alert.walletAddress,
      alert.detectionMethod,
      alert.confidenceScore,
      JSON.stringify(alert.evidenceData),
      alert.alertType
    );
  }

  // 📊 PROVIDER STATS
  async updateProviderStats(providerName: string, stats: {
    requestCount: number;
    errorCount: number;
    avgResponseTime: number;
    status: string;
    priority: number;
  }): Promise<void> {
    const stmt = this.getPreparedStatement('update_provider_stats', `
      INSERT OR REPLACE INTO provider_stats (
        provider_name, provider_type, request_count, error_count,
        avg_response_time, status, priority, last_used
      ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    stmt.run(
      providerName,
      providerName.toLowerCase().includes('alchemy') ? 'alchemy' : 'quicknode',
      stats.requestCount,
      stats.errorCount,
      stats.avgResponseTime,
      stats.status,
      stats.priority
    );
  }

  // 🐋 WHALE TRANSACTIONS
  async saveWhaleTransaction(transaction: {
    transactionId: string;
    walletAddress: string;
    tokenAddress: string;
    tokenSymbol: string;
    amountUSD: number;
    swapType: string;
    source: string;
    timestamp: Date;
  }): Promise<void> {
    const stmt = this.getPreparedStatement('save_whale_transaction', `
      INSERT OR IGNORE INTO whale_transactions (
        transaction_id, wallet_address, token_address, token_symbol,
        amount_usd, swap_type, source, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      transaction.transactionId,
      transaction.walletAddress,
      transaction.tokenAddress,
      transaction.tokenSymbol,
      transaction.amountUSD,
      transaction.swapType,
      transaction.source,
      transaction.timestamp.toISOString()
    );
  }

  // Псевдонимы для совместимости с SolanaMonitor.ts
  async saveWalletInfo(walletInfo: WalletInfo): Promise<void> {
    return this.saveWallet(walletInfo);
  }

  async getWalletInfo(address: string): Promise<WalletInfo | null> {
    return this.getWallet(address);
  }

  async getWalletTransactions(walletAddress: string, limit: number = 100): Promise<TokenSwap[]> {
    return this.getTransactionsByWallet(walletAddress, limit);
  }

  // Методы для агрегации позиций
  async getUnprocessedPositionAggregations(limit: number = 50): Promise<PositionAggregation[]> {
    const cacheKey = `unprocessed_aggregations_${limit}`;
    const cached = this.getCached<PositionAggregation[]>(cacheKey);
    if (cached) return cached;

    const stmt = this.getPreparedStatement('get_unprocessed_aggregations', `
      SELECT 
        id, wallet_address, token_address, token_symbol, token_name,
        total_usd, purchase_count, avg_purchase_size, time_window_minutes,
        suspicion_score, size_tolerance, first_buy_time, last_buy_time,
        detected_at, purchase_details, max_purchase_size, min_purchase_size,
        size_std_deviation, size_coefficient, similar_size_count, 
        wallet_age_days, risk_level
      FROM position_aggregations 
      WHERE is_processed = 0 
      ORDER BY suspicion_score DESC, detected_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(limit) as any[];
    const aggregations = rows.map(row => ({
      id: row.id,
      walletAddress: row.wallet_address,
      tokenAddress: row.token_address,
      tokenSymbol: row.token_symbol,
      tokenName: row.token_name,
      totalUSD: row.total_usd,
      purchaseCount: row.purchase_count,
      avgPurchaseSize: row.avg_purchase_size,
      timeWindowMinutes: row.time_window_minutes,
      suspicionScore: row.suspicion_score,
      sizeTolerance: row.size_tolerance,
      firstBuyTime: new Date(row.first_buy_time),
      lastBuyTime: new Date(row.last_buy_time),
      detectedAt: new Date(row.detected_at),
      purchases: row.purchase_details ? JSON.parse(row.purchase_details) : [],
      maxPurchaseSize: row.max_purchase_size || 0,
      minPurchaseSize: row.min_purchase_size || 0,
      sizeStdDeviation: row.size_std_deviation || 0,
      sizeCoefficient: row.size_coefficient || 0,
      similarSizeCount: row.similar_size_count || 0,
      walletAgeDays: row.wallet_age_days || 0,
      riskLevel: (row.risk_level || 'MEDIUM') as 'LOW' | 'MEDIUM' | 'HIGH',
      isProcessed: false,
      alertSent: false
    }));

    this.setCache(cacheKey, aggregations, 30000); // 30 секунд
    return aggregations;
  }

  async markPositionAggregationAsProcessed(id: number, alertSent: boolean = false): Promise<void> {
    const stmt = this.getPreparedStatement('mark_aggregation_processed', `
      UPDATE position_aggregations 
      SET is_processed = 1, alert_sent = ?, processed_at = datetime('now')
      WHERE id = ?
    `);

    stmt.run(alertSent ? 1 : 0, id);
    
    // Очищаем связанный кеш
    this.queryCache.delete('unprocessed_aggregations_50');
    this.queryCache.delete('unprocessed_aggregations_20');
    this.queryCache.delete('position_aggregation_stats');
  }

  async getPositionAggregationStats(): Promise<{
    totalPositions: number;
    highSuspicionPositions: number;
    unprocessedPositions: number;
    avgSuspicionScore: number;
    last24hPositions: number;
  }> {
    const cacheKey = 'position_aggregation_stats';
    const cached = this.getCached<any>(cacheKey);
    if (cached) return cached;

    try {
      const totalPositions = this.getPreparedStatement('count_total_positions',
        'SELECT COUNT(*) as count FROM position_aggregations'
      ).get() as any;

      const highSuspicionPositions = this.getPreparedStatement('count_high_suspicion_positions',
        'SELECT COUNT(*) as count FROM position_aggregations WHERE suspicion_score >= 70'
      ).get() as any;

      const unprocessedPositions = this.getPreparedStatement('count_unprocessed_positions',
        'SELECT COUNT(*) as count FROM position_aggregations WHERE is_processed = 0'
      ).get() as any;

      const avgSuspicionScore = this.getPreparedStatement('avg_suspicion_score',
        'SELECT AVG(suspicion_score) as avg FROM position_aggregations WHERE suspicion_score > 0'
      ).get() as any;

      const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const last24hPositions = this.getPreparedStatement('count_24h_positions',
        'SELECT COUNT(*) as count FROM position_aggregations WHERE detected_at > ?'
      ).get(last24h) as any;

      const result = {
        totalPositions: totalPositions.count,
        highSuspicionPositions: highSuspicionPositions.count,
        unprocessedPositions: unprocessedPositions.count,
        avgSuspicionScore: avgSuspicionScore.avg || 0,
        last24hPositions: last24hPositions.count
      };

      this.setCache(cacheKey, result, this.CACHE_TTL.MEDIUM);
      return result;

    } catch (error) {
      this.logger.error('Error getting position aggregation stats:', error);
      return {
        totalPositions: 0,
        highSuspicionPositions: 0,
        unprocessedPositions: 0,
        avgSuspicionScore: 0,
        last24hPositions: 0
      };
    }
  }

  // 📊 DATABASE STATS
  async getDatabaseStats(): Promise<{
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
  }> {
    const cacheKey = 'db_stats';
    const cached = this.getCached<any>(cacheKey);
    if (cached) return cached;

    try {
      const totalTransactions = this.getPreparedStatement('count_transactions', 
        'SELECT COUNT(*) as count FROM token_swaps'
      ).get() as any;

      const totalWallets = this.getPreparedStatement('count_wallets',
        'SELECT COUNT(*) as count FROM wallets'
      ).get() as any;
      
      const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const last24hTransactions = this.getPreparedStatement('count_24h_transactions',
        'SELECT COUNT(*) as count FROM token_swaps WHERE timestamp > ?'
      ).get(last24h) as any;

      const avgTransactionSize = this.getPreparedStatement('avg_transaction_size',
        'SELECT AVG(amount_usd) as avg FROM token_swaps WHERE amount_usd > 0'
      ).get() as any;

      const positionAggregations = this.getPreparedStatement('count_position_aggregations',
        'SELECT COUNT(*) as count FROM position_aggregations'
      ).get() as any;

      const highSuspicionPositions = this.getPreparedStatement('count_high_suspicion',
        'SELECT COUNT(*) as count FROM position_aggregations WHERE suspicion_score >= 75'
      ).get() as any;

      const aggregatedTransactions = this.getPreparedStatement('count_aggregated_transactions',
        'SELECT COUNT(*) as count FROM token_swaps WHERE is_aggregated = 1'
      ).get() as any;

      const insiderAlerts = this.getPreparedStatement('count_insider_alerts',
        'SELECT COUNT(*) as count FROM insider_alerts'
      ).get() as any;

      const unprocessedAlerts = this.getPreparedStatement('count_unprocessed_insider_alerts',
        'SELECT COUNT(*) as count FROM insider_alerts WHERE processed = 0'
      ).get() as any;

      const providerStatsRows = this.getPreparedStatement('get_provider_stats',
        'SELECT provider_name, request_count, error_count FROM provider_stats'
      ).all() as any[];

      const providerStats = providerStatsRows.map(row => ({
        name: row.provider_name,
        requests: row.request_count,
        errors: row.error_count,
        successRate: row.request_count > 0 ? 
          ((row.request_count - row.error_count) / row.request_count * 100) : 100
      }));

      const result = {
        totalTransactions: totalTransactions.count,
        totalWallets: totalWallets.count,
        last24hTransactions: last24hTransactions.count,
        avgTransactionSize: avgTransactionSize.avg || 0,
        positionAggregations: positionAggregations.count,
        highSuspicionPositions: highSuspicionPositions.count,
        aggregatedTransactions: aggregatedTransactions.count,
        insiderAlerts: insiderAlerts.count,
        unprocessedAlerts: unprocessedAlerts.count,
        providerStats
      };

      this.setCache(cacheKey, result, this.CACHE_TTL.MEDIUM);
      return result;

    } catch (error) {
      this.logger.error('Error getting database stats:', error);
      throw error;
    }
  }

  // 🗃️ HELPER METHODS
  // 🔥 ИСПРАВЛЕНО: Убрали поля pnl, multiplier, winrate, time_to_target
  private mapRowToTransaction(row: any): TokenSwap {
    return {
      transactionId: row.transaction_id,
      walletAddress: row.wallet_address,
      tokenAddress: row.token_address,
      tokenSymbol: row.token_symbol,
      tokenName: row.token_name,
      amount: row.amount,
      amountUSD: row.amount_usd,
      timestamp: new Date(row.timestamp),
      dex: row.dex,
      isNewWallet: !!row.is_new_wallet,
      isReactivatedWallet: !!row.is_reactivated_wallet,
      daysSinceLastActivity: row.days_since_last_activity,
      price: row.price,
      swapType: row.swap_type as 'buy' | 'sell',
      isAggregated: !!row.is_aggregated,
      aggregationId: row.aggregation_id,
      suspicionScore: row.suspicion_score
    };
  }

  // 🔚 CLEANUP
  close(): void {
    if (this.maintenanceInterval) {
      clearInterval(this.maintenanceInterval);
    }
    
    // Закрываем prepared statements
    for (const stmt of this.preparedStatements.values()) {
      try {
        // Проверяем, есть ли метод finalize (в старых версиях BetterSQLite3)
        if ('finalize' in stmt && typeof (stmt as any).finalize === 'function') {
          (stmt as any).finalize();
        }
      } catch (error) {
        // Игнорируем ошибки при закрытии statements
      }
    }
    
    this.db.close();
    this.logger.info('🔚 Database connection closed');
  }
}