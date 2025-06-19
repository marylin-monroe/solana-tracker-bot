// src/services/SmartMoneyDatabase.ts - DYNAMIC WALLET EVALUATION & PROFIT-FIRST OPTIMIZATION
import BetterSqlite3 from 'better-sqlite3';
import { Logger } from '../utils/Logger';
import { SmartMoneyWallet, TokenSwap } from '../types';
import path from 'path';
import fs from 'fs';

// 🆕 INTERFACES FOR DYNAMIC EVALUATION
interface WalletPerformanceUpdate {
  address: string;
  currentPnL: number;
  last30DaysPnL: number;
  last7DaysPnL: number;
  profitFactor: number;
  recentWinRate: number;
  realTimeScore: number;
  trendDirection: 'up' | 'down' | 'stable';
  lastUpdated: Date;
}

interface WalletRankingMetrics {
  address: string;
  category: 'sniper' | 'hunter' | 'trader';
  realTimeScore: number;
  profitFactor: number;
  recentPnL: number;
  consistencyScore: number;
  riskAdjustedReturn: number;
  rank: number;
  tier: 'elite' | 'premium' | 'good' | 'average' | 'underperforming';
}

interface ProfitFirstStats {
  totalWallets: number;
  eliteWallets: number;
  premiumWallets: number;
  avgRealTimeScore: number;
  avgProfitFactor: number;
  totalRecentPnL: number;
  topPerformers: WalletRankingMetrics[];
  underperformers: WalletRankingMetrics[];
}

export class SmartMoneyDatabase {
  private db: BetterSqlite3.Database;
  private logger: Logger;

  // 🆕 PERFORMANCE TRACKING
  private readonly PERFORMANCE_UPDATE_INTERVAL = 30 * 60 * 1000; // 30 минут
  private lastPerformanceUpdate = 0;

  // 🚀 PROFIT-FIRST THRESHOLDS
  private readonly PROFIT_THRESHOLDS = {
    elite: 90,        // 90+ score = elite
    premium: 80,      // 80+ score = premium  
    good: 70,         // 70+ score = good
    average: 60,      // 60+ score = average
    underperforming: 0 // <60 score = underperforming
  };

  constructor() {
    this.logger = Logger.getInstance();
    const dbPath = process.env.SM_DATABASE_PATH || './data/smart_money.db';

    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new BetterSqlite3(dbPath);
  }

  async init(): Promise<void> {
    try {
      // Создаем основные таблицы
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS smart_money_wallets (
          address TEXT PRIMARY KEY,
          category TEXT CHECK (category IN ('sniper', 'hunter', 'trader')) NOT NULL,
          win_rate REAL NOT NULL,
          total_pnl REAL NOT NULL,
          total_trades INTEGER NOT NULL,
          avg_trade_size REAL NOT NULL,
          max_trade_size REAL NOT NULL,
          min_trade_size REAL NOT NULL,
          performance_score REAL NOT NULL,
          sharpe_ratio REAL,
          max_drawdown REAL,
          last_active_at DATETIME NOT NULL,
          is_active BOOLEAN DEFAULT 1,
          is_family_member BOOLEAN DEFAULT 0,
          family_addresses TEXT,
          coordination_score REAL,
          stealth_level REAL,
          early_entry_rate REAL,
          avg_hold_time REAL,
          volume_score REAL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS smart_money_transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          transaction_id TEXT NOT NULL,
          wallet_address TEXT NOT NULL,
          token_address TEXT NOT NULL,
          token_symbol TEXT,
          token_name TEXT,
          amount REAL NOT NULL,
          amount_usd REAL NOT NULL,
          swap_type TEXT CHECK (swap_type IN ('buy', 'sell')) NOT NULL,
          timestamp DATETIME NOT NULL,
          dex TEXT,
          wallet_category TEXT,
          is_family_member BOOLEAN DEFAULT 0,
          family_id TEXT,
          wallet_pnl REAL,
          wallet_win_rate REAL,
          wallet_total_trades INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(transaction_id, wallet_address, token_address)
        );
      `);

      // 🆕 НОВАЯ ТАБЛИЦА: Wallet Performance Tracking
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS wallet_performance_metrics (
          address TEXT PRIMARY KEY,
          current_pnl REAL NOT NULL DEFAULT 0,
          last_30days_pnl REAL NOT NULL DEFAULT 0,
          last_7days_pnl REAL NOT NULL DEFAULT 0,
          profit_factor REAL NOT NULL DEFAULT 1,
          recent_win_rate REAL NOT NULL DEFAULT 0,
          real_time_score REAL NOT NULL DEFAULT 50,
          trend_direction TEXT CHECK (trend_direction IN ('up', 'down', 'stable')) DEFAULT 'stable',
          consistency_score REAL DEFAULT 50,
          risk_adjusted_return REAL DEFAULT 0,
          hot_streak INTEGER DEFAULT 0,
          recent_hit_rate REAL DEFAULT 0,
          max_drawdown_7d REAL DEFAULT 0,
          volume_weighted_score REAL DEFAULT 50,
          tier TEXT CHECK (tier IN ('elite', 'premium', 'good', 'average', 'underperforming')) DEFAULT 'average',
          rank_position INTEGER DEFAULT 0,
          last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (address) REFERENCES smart_money_wallets (address) ON DELETE CASCADE
        );
      `);

      // 🆕 НОВАЯ ТАБЛИЦА: Wallet Performance History (для trending)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS wallet_performance_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          address TEXT NOT NULL,
          date DATE NOT NULL,
          pnl_change REAL NOT NULL,
          score_change REAL NOT NULL,
          win_rate_change REAL NOT NULL,
          trade_count INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (address) REFERENCES smart_money_wallets (address) ON DELETE CASCADE,
          UNIQUE(address, date)
        );
      `);

      // Проверяем и добавляем недостающие колонки в основную таблицу
      await this.migrateExistingData();

      // Создаем индексы для performance
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_sm_wallets_category ON smart_money_wallets(category);
        CREATE INDEX IF NOT EXISTS idx_sm_wallets_active ON smart_money_wallets(is_active);
        CREATE INDEX IF NOT EXISTS idx_sm_wallets_performance ON smart_money_wallets(performance_score);
        CREATE INDEX IF NOT EXISTS idx_sm_wallets_last_active ON smart_money_wallets(last_active_at);
        
        CREATE INDEX IF NOT EXISTS idx_sm_transactions_wallet ON smart_money_transactions(wallet_address);
        CREATE INDEX IF NOT EXISTS idx_sm_transactions_timestamp ON smart_money_transactions(timestamp);
        CREATE INDEX IF NOT EXISTS idx_sm_transactions_token ON smart_money_transactions(token_address);
        
        CREATE INDEX IF NOT EXISTS idx_performance_score ON wallet_performance_metrics(real_time_score);
        CREATE INDEX IF NOT EXISTS idx_performance_tier ON wallet_performance_metrics(tier);
        CREATE INDEX IF NOT EXISTS idx_performance_rank ON wallet_performance_metrics(rank_position);
        CREATE INDEX IF NOT EXISTS idx_performance_updated ON wallet_performance_metrics(last_updated);
        
        CREATE INDEX IF NOT EXISTS idx_history_address_date ON wallet_performance_history(address, date);
        CREATE INDEX IF NOT EXISTS idx_history_date ON wallet_performance_history(date);
      `);

      // Создаем индексы на новые колонки только если они существуют
      const tableInfo = this.db.prepare("PRAGMA table_info(smart_money_wallets)").all() as any[];
      const columnNames = tableInfo.map((col: any) => col.name);

      if (columnNames.includes('enabled')) {
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sm_wallets_enabled ON smart_money_wallets(enabled);`);
      }

      if (columnNames.includes('priority')) {
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sm_wallets_priority ON smart_money_wallets(priority);`);
      }

      this.logger.info('✅ Smart Money Database initialized successfully (PROFIT-FIRST MODE with dynamic evaluation)');
    } catch (error) {
      this.logger.error('❌ Error initializing Smart Money database:', error);
      throw error;
    }
  }

  private async migrateExistingData(): Promise<void> {
    try {
      const tableInfo = this.db.prepare("PRAGMA table_info(smart_money_wallets)").all() as any[];
      const columnNames = tableInfo.map((col: any) => col.name);

      this.logger.info(`Current columns: ${columnNames.join(', ')}`);

      const newColumns = [
        { name: 'nickname', type: 'TEXT' },
        { name: 'description', type: 'TEXT' },
        { name: 'min_trade_alert', type: 'REAL DEFAULT 5000' },
        { name: 'priority', type: 'TEXT DEFAULT "medium"' },
        { name: 'enabled', type: 'BOOLEAN DEFAULT 1' },
        { name: 'verified', type: 'BOOLEAN DEFAULT 0' },
        { name: 'added_by', type: 'TEXT DEFAULT "discovery"' },
        { name: 'added_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
      ];

      for (const column of newColumns) {
        if (!columnNames.includes(column.name)) {
          try {
            this.db.exec(`ALTER TABLE smart_money_wallets ADD COLUMN ${column.name} ${column.type}`);
            this.logger.info(`✅ Added column: ${column.name}`);
          } catch (error) {
            this.logger.warn(`⚠️ Could not add column ${column.name}:`, error);
          }
        }
      }

    } catch (error) {
      this.logger.error('❌ Error during data migration:', error);
    }
  }

  // ========== ОСНОВНЫЕ МЕТОДЫ (сохранены все существующие) ==========

  async saveSmartWallet(wallet: SmartMoneyWallet, config?: {
    nickname?: string;
    description?: string;
    minTradeAlert?: number;
    priority?: 'high' | 'medium' | 'low';
    enabled?: boolean;
    verified?: boolean;
    addedBy?: 'manual' | 'discovery' | 'dragon';
  }): Promise<void> {

    const tableInfo = this.db.prepare("PRAGMA table_info(smart_money_wallets)").all() as any[];
    const columnNames = tableInfo.map((col: any) => col.name);

    if (columnNames.includes('nickname') && columnNames.includes('description')) {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO smart_money_wallets (
          address, category, nickname, description,
          win_rate, total_pnl, total_trades, avg_trade_size, max_trade_size, min_trade_size, performance_score,
          sharpe_ratio, max_drawdown, volume_score, early_entry_rate, avg_hold_time,
          min_trade_alert, priority, enabled,
          is_active, verified, last_active_at,
          is_family_member, family_addresses, coordination_score, stealth_level,
          added_by, added_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `);

      stmt.run(
        wallet.address,
        wallet.category,
        config?.nickname || `${wallet.category.charAt(0).toUpperCase() + wallet.category.slice(1)} ${wallet.address.slice(0, 8)}`,
        config?.description || `High-performance ${wallet.category} кошелек`,
        wallet.winRate,
        wallet.totalPnL,
        wallet.totalTrades,
        wallet.avgTradeSize,
        wallet.maxTradeSize,
        wallet.minTradeSize,
        wallet.performanceScore,
        wallet.sharpeRatio || null,
        wallet.maxDrawdown || null,
        wallet.volumeScore || null,
        wallet.earlyEntryRate || null,
        wallet.avgHoldTime || null,
        config?.minTradeAlert || (wallet.category === 'trader' ? 15000 : wallet.category === 'hunter' ? 5000 : 3000),
        config?.priority || (wallet.performanceScore > 85 ? 'high' : 'medium'),
        config?.enabled !== undefined ? (config.enabled ? 1 : 0) : 1,
        wallet.isActive ? 1 : 0,
        config?.verified !== undefined ? (config.verified ? 1 : 0) : 0,
        wallet.lastActiveAt.toISOString(),
        false, // is_family_member отключен
        null,  // family_addresses отключен
        0,     // coordination_score отключен
        wallet.stealthLevel || null,
        config?.addedBy || 'discovery',
        new Date().toISOString()
      );
    } else {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO smart_money_wallets (
          address, category, win_rate, total_pnl, total_trades, avg_trade_size, max_trade_size, min_trade_size,
          performance_score, sharpe_ratio, max_drawdown, last_active_at, is_active,
          is_family_member, family_addresses, coordination_score, stealth_level,
          early_entry_rate, avg_hold_time, volume_score, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `);

      stmt.run(
        wallet.address,
        wallet.category,
        wallet.winRate,
        wallet.totalPnL,
        wallet.totalTrades,
        wallet.avgTradeSize,
        wallet.maxTradeSize,
        wallet.minTradeSize,
        wallet.performanceScore,
        wallet.sharpeRatio || null,
        wallet.maxDrawdown || null,
        wallet.lastActiveAt.toISOString(),
        wallet.isActive ? 1 : 0,
        false, // is_family_member отключен
        null,  // family_addresses отключен  
        0,     // coordination_score отключен
        wallet.stealthLevel || null,
        wallet.earlyEntryRate || null,
        wallet.avgHoldTime || null,
        wallet.volumeScore || null
      );
    }

    // 🆕 АВТОМАТИЧЕСКИ создаем запись в performance_metrics
    await this.initializeWalletPerformanceMetrics(wallet.address, wallet.performanceScore);
  }

  async getSmartWallet(address: string): Promise<SmartMoneyWallet | null> {
    const row = this.db.prepare('SELECT * FROM smart_money_wallets WHERE address = ?').get(address) as any;
    if (!row) return null;
    return this.mapRowToWallet(row);
  }

  async getAllActiveSmartWallets(): Promise<SmartMoneyWallet[]> {
    const tableInfo = this.db.prepare("PRAGMA table_info(smart_money_wallets)").all() as any[];
    const hasEnabledColumn = tableInfo.some((col: any) => col.name === 'enabled');

    let query = 'SELECT * FROM smart_money_wallets WHERE is_active = 1';
    if (hasEnabledColumn) {
      query += ' AND enabled = 1';
    }
    query += ' ORDER BY performance_score DESC';

    const rows = this.db.prepare(query).all() as any[];
    return rows.map(row => this.mapRowToWallet(row));
  }

  async getWalletCount(): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM smart_money_wallets WHERE is_active = 1').get() as any;
    return row.count;
  }

  async updateWalletSettings(address: string, settings: {
    minTradeAlert?: number;
    priority?: 'high' | 'medium' | 'low';
    enabled?: boolean;
  }): Promise<void> {
    const tableInfo = this.db.prepare("PRAGMA table_info(smart_money_wallets)").all() as any[];
    const columnNames = tableInfo.map((col: any) => col.name);

    const updates: string[] = [];
    const params: any[] = [];

    if (settings.minTradeAlert !== undefined && columnNames.includes('min_trade_alert')) {
      updates.push('min_trade_alert = ?');
      params.push(settings.minTradeAlert);
    }

    if (settings.priority !== undefined && columnNames.includes('priority')) {
      updates.push('priority = ?');
      params.push(settings.priority);
    }

    if (settings.enabled !== undefined && columnNames.includes('enabled')) {
      updates.push('enabled = ?');
      params.push(settings.enabled ? 1 : 0);
    }

    if (updates.length > 0) {
      updates.push('updated_at = datetime(\'now\')');
      params.push(address);

      const query = `UPDATE smart_money_wallets SET ${updates.join(', ')} WHERE address = ?`;
      this.db.prepare(query).run(...params);
    }
  }

  async getWalletSettings(address: string): Promise<{
    minTradeAlert: number;
    priority: 'high' | 'medium' | 'low';
    enabled: boolean;
    nickname?: string;
    description?: string;
  } | null> {
    const tableInfo = this.db.prepare("PRAGMA table_info(smart_money_wallets)").all() as any[];
    const columnNames = tableInfo.map((col: any) => col.name);

    const selectColumns = ['address'];
    if (columnNames.includes('min_trade_alert')) selectColumns.push('min_trade_alert');
    if (columnNames.includes('priority')) selectColumns.push('priority');
    if (columnNames.includes('enabled')) selectColumns.push('enabled');
    if (columnNames.includes('nickname')) selectColumns.push('nickname');
    if (columnNames.includes('description')) selectColumns.push('description');

    const query = `SELECT ${selectColumns.join(', ')} FROM smart_money_wallets WHERE address = ?`;
    const row = this.db.prepare(query).get(address) as any;

    if (!row) return null;

    return {
      minTradeAlert: row.min_trade_alert || 5000,
      priority: row.priority || 'medium',
      enabled: row.enabled !== undefined ? !!row.enabled : true,
      nickname: row.nickname,
      description: row.description
    };
  }

  async deactivateWallet(address: string, reason: string): Promise<void> {
    this.db.prepare(`
      UPDATE smart_money_wallets 
      SET is_active = 0, updated_at = datetime('now')
      WHERE address = ?
    `).run(address);

    this.logger.info(`⚠️ Deactivated wallet ${address}: ${reason}`);
  }

  async getSmartWalletTransactions(walletAddress: string, afterDate: Date): Promise<TokenSwap[]> {
    const rows = this.db.prepare(`
      SELECT * FROM smart_money_transactions 
      WHERE wallet_address = ? AND timestamp > ?
      ORDER BY timestamp DESC
    `).all(walletAddress, afterDate.toISOString()) as any[];

    return rows.map(row => ({
      transactionId: row.transaction_id,
      walletAddress: row.wallet_address,
      tokenAddress: row.token_address,
      tokenSymbol: row.token_symbol,
      tokenName: row.token_name,
      amount: row.amount,
      amountUSD: row.amount_usd,
      timestamp: new Date(row.timestamp),
      dex: row.dex,
      isNewWallet: false,
      isReactivatedWallet: false,
      walletAge: 0,
      daysSinceLastActivity: 0,
      swapType: row.swap_type as 'buy' | 'sell'
    }));
  }

  async saveSmartMoneyTransaction(swapInfo: {
    transactionId: string;
    walletAddress: string;
    tokenAddress: string;
    tokenSymbol: string;
    tokenName: string;
    tokenAmount: number;
    amountUSD: number;
    swapType: 'buy' | 'sell';
    timestamp: Date;
    category: 'sniper' | 'hunter' | 'trader';
    winRate: number;
    pnl: number;
    totalTrades: number;
    dex?: string;
  }): Promise<void> {
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO smart_money_transactions (
          transaction_id, wallet_address, token_address, token_symbol, token_name,
          amount, amount_usd, swap_type, timestamp, dex,
          wallet_category, is_family_member, family_id,
          wallet_pnl, wallet_win_rate, wallet_total_trades
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        swapInfo.transactionId,
        swapInfo.walletAddress,
        swapInfo.tokenAddress,
        swapInfo.tokenSymbol,
        swapInfo.tokenName,
        swapInfo.tokenAmount,
        swapInfo.amountUSD,
        swapInfo.swapType,
        swapInfo.timestamp.toISOString(),
        swapInfo.dex || 'Smart-Money',
        swapInfo.category,
        0, // is_family_member = false (отключено)
        null, // family_id = null
        swapInfo.pnl,
        swapInfo.winRate,
        swapInfo.totalTrades
      );

      this.logger.debug(`💾 Saved SM transaction: ${swapInfo.tokenSymbol} - $${swapInfo.amountUSD.toFixed(0)} (${swapInfo.swapType})`);

      // 🆕 АВТОМАТИЧЕСКИ обновляем performance метрики при новой транзакции
      await this.updateWalletPerformanceOnTransaction(swapInfo.walletAddress, swapInfo);

    } catch (error) {
      this.logger.error('❌ Error saving Smart Money transaction:', error);
      throw error;
    }
  }

  async getWalletsByCategory(category: 'sniper' | 'hunter' | 'trader'): Promise<SmartMoneyWallet[]> {
    const tableInfo = this.db.prepare("PRAGMA table_info(smart_money_wallets)").all() as any[];
    const hasEnabledColumn = tableInfo.some((col: any) => col.name === 'enabled');

    let query = 'SELECT * FROM smart_money_wallets WHERE category = ? AND is_active = 1';
    if (hasEnabledColumn) {
      query += ' AND enabled = 1';
    }
    query += ' ORDER BY performance_score DESC';

    const rows = this.db.prepare(query).all(category) as any[];
    return rows.map(row => this.mapRowToWallet(row));
  }

  async updateWalletPerformance(address: string, metrics: {
    winRate: number;
    totalPnL: number;
    totalTrades: number;
    lastActiveAt: Date;
    performanceScore?: number;
  }): Promise<void> {
    this.db.prepare(`
      UPDATE smart_money_wallets 
      SET win_rate = ?, total_pnl = ?, total_trades = ?, last_active_at = ?, 
          performance_score = COALESCE(?, performance_score), updated_at = datetime('now')
      WHERE address = ?
    `).run(
      metrics.winRate,
      metrics.totalPnL,
      metrics.totalTrades,
      metrics.lastActiveAt.toISOString(),
      metrics.performanceScore || null,
      address
    );
  }

  // ========== 🆕 НОВЫЕ МЕТОДЫ ДЛЯ DYNAMIC WALLET EVALUATION ==========

  /**
   * 🚀 ИНИЦИАЛИЗАЦИЯ Performance Metrics для нового кошелька
   */
  private async initializeWalletPerformanceMetrics(address: string, initialScore: number = 50): Promise<void> {
    try {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO wallet_performance_metrics (
          address, real_time_score, tier, created_at, last_updated
        ) VALUES (?, ?, ?, datetime('now'), datetime('now'))
      `);

      const tier = this.calculateTierFromScore(initialScore);
      stmt.run(address, initialScore, tier);

      this.logger.debug(`🎯 Initialized performance metrics for wallet ${address.slice(0, 8)}...`);
    } catch (error) {
      this.logger.error(`❌ Error initializing performance metrics for ${address}:`, error);
    }
  }

  /**
   * 🔄 ОБНОВЛЕНИЕ Performance Metrics при новой транзакции
   */
  private async updateWalletPerformanceOnTransaction(
    address: string, 
    transaction: { amountUSD: number; swapType: 'buy' | 'sell'; timestamp: Date }
  ): Promise<void> {
    try {
      // Получаем текущие метрики
      const current = await this.getWalletPerformanceMetrics(address);
      if (!current) return;

      // Простое обновление на основе транзакции
      let scoreChange = 0;
      if (transaction.swapType === 'buy' && transaction.amountUSD > 10000) {
        scoreChange = 2; // Крупная покупка = +2 балла
      } else if (transaction.swapType === 'sell' && transaction.amountUSD > 50000) {
        scoreChange = 3; // Крупная продажа = +3 балла
      }

              const newScore = Math.min(100, Math.max(0, current.realTimeScore + scoreChange));
      const newTier = this.calculateTierFromScore(newScore);

      const stmt = this.db.prepare(`
        UPDATE wallet_performance_metrics 
        SET real_time_score = ?, tier = ?, last_updated = datetime('now')
        WHERE address = ?
      `);

      stmt.run(newScore, newTier, address);

    } catch (error) {
      this.logger.error(`❌ Error updating performance on transaction for ${address}:`, error);
    }
  }

  /**
   * 🎯 ПОЛУЧЕНИЕ Performance Metrics кошелька
   */
  async getWalletPerformanceMetrics(address: string): Promise<WalletPerformanceUpdate | null> {
    try {
      const row = this.db.prepare(`
        SELECT * FROM wallet_performance_metrics WHERE address = ?
      `).get(address) as any;

      if (!row) return null;

      return {
        address: row.address,
        currentPnL: row.current_pnl,
        last30DaysPnL: row.last_30days_pnl,
        last7DaysPnL: row.last_7days_pnl,
        profitFactor: row.profit_factor,
        recentWinRate: row.recent_win_rate,
        realTimeScore: row.real_time_score,
        trendDirection: row.trend_direction,
        lastUpdated: new Date(row.last_updated)
      };
    } catch (error) {
      this.logger.error(`❌ Error getting performance metrics for ${address}:`, error);
      return null;
    }
  }

  /**
   * 🚀 МАССОВОЕ ОБНОВЛЕНИЕ Performance Metrics
   */
  async updateWalletPerformanceMetrics(updates: WalletPerformanceUpdate[]): Promise<void> {
    const updateTransaction = this.db.transaction((updates: WalletPerformanceUpdate[]) => {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO wallet_performance_metrics (
          address, current_pnl, last_30days_pnl, last_7days_pnl, profit_factor,
          recent_win_rate, real_time_score, trend_direction, tier, last_updated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `);

      for (const update of updates) {
        const tier = this.calculateTierFromScore(update.realTimeScore);
        
        stmt.run(
          update.address,
          update.currentPnL,
          update.last30DaysPnL,
          update.last7DaysPnL,
          update.profitFactor,
          update.recentWinRate,
          update.realTimeScore,
          update.trendDirection,
          tier
        );
      }
    });

    updateTransaction(updates);
    this.logger.info(`✅ Updated performance metrics for ${updates.length} wallets`);
  }

  /**
   * 🏆 ПОЛУЧЕНИЕ RANKING всех кошельков
   */
  async getWalletRankings(): Promise<WalletRankingMetrics[]> {
    try {
      const rows = this.db.prepare(`
        SELECT 
          w.address,
          w.category,
          p.real_time_score,
          p.profit_factor,
          p.last_7days_pnl as recent_pnl,
          p.consistency_score,
          p.risk_adjusted_return,
          p.tier,
          ROW_NUMBER() OVER (ORDER BY p.real_time_score DESC) as rank
        FROM smart_money_wallets w
        INNER JOIN wallet_performance_metrics p ON w.address = p.address
        WHERE w.is_active = 1
        ORDER BY p.real_time_score DESC
      `).all() as any[];

      return rows.map(row => ({
        address: row.address,
        category: row.category,
        realTimeScore: row.real_time_score,
        profitFactor: row.profit_factor,
        recentPnL: row.recent_pnl,
        consistencyScore: row.consistency_score || 50,
        riskAdjustedReturn: row.risk_adjusted_return || 0,
        rank: row.rank,
        tier: row.tier as 'elite' | 'premium' | 'good' | 'average' | 'underperforming'
      }));

    } catch (error) {
      this.logger.error('❌ Error getting wallet rankings:', error);
      return [];
    }
  }

  /**
   * 📊 ПОЛУЧЕНИЕ PROFIT-FIRST СТАТИСТИКИ
   */
  async getProfitFirstStats(): Promise<ProfitFirstStats> {
    try {
      const rankings = await this.getWalletRankings();
      
      const eliteWallets = rankings.filter(w => w.tier === 'elite').length;
      const premiumWallets = rankings.filter(w => w.tier === 'premium').length;
      
      const avgRealTimeScore = rankings.length > 0 
        ? rankings.reduce((sum, w) => sum + w.realTimeScore, 0) / rankings.length 
        : 0;
        
      const avgProfitFactor = rankings.length > 0
        ? rankings.reduce((sum, w) => sum + w.profitFactor, 0) / rankings.length
        : 0;
        
      const totalRecentPnL = rankings.reduce((sum, w) => sum + w.recentPnL, 0);
      
      const topPerformers = rankings.slice(0, 10);
      const underperformers = rankings.filter(w => w.tier === 'underperforming').slice(0, 5);

      return {
        totalWallets: rankings.length,
        eliteWallets,
        premiumWallets,
        avgRealTimeScore,
        avgProfitFactor,
        totalRecentPnL,
        topPerformers,
        underperformers
      };

    } catch (error) {
      this.logger.error('❌ Error getting profit-first stats:', error);
      return {
        totalWallets: 0,
        eliteWallets: 0,
        premiumWallets: 0,
        avgRealTimeScore: 0,
        avgProfitFactor: 0,
        totalRecentPnL: 0,
        topPerformers: [],
        underperformers: []
      };
    }
  }

  /**
   * 🎯 ПОЛУЧЕНИЕ TOP PERFORMERS по категории
   */
  async getTopPerformersByCategory(category: 'sniper' | 'hunter' | 'trader', limit: number = 10): Promise<WalletRankingMetrics[]> {
    try {
      const rows = this.db.prepare(`
        SELECT 
          w.address,
          w.category,
          p.real_time_score,
          p.profit_factor,
          p.last_7days_pnl as recent_pnl,
          p.consistency_score,
          p.risk_adjusted_return,
          p.tier,
          ROW_NUMBER() OVER (ORDER BY p.real_time_score DESC) as rank
        FROM smart_money_wallets w
        INNER JOIN wallet_performance_metrics p ON w.address = p.address
        WHERE w.is_active = 1 AND w.category = ?
        ORDER BY p.real_time_score DESC
        LIMIT ?
      `).all(category, limit) as any[];

      return rows.map(row => ({
        address: row.address,
        category: row.category,
        realTimeScore: row.real_time_score,
        profitFactor: row.profit_factor,
        recentPnL: row.recent_pnl,
        consistencyScore: row.consistency_score || 50,
        riskAdjustedReturn: row.risk_adjusted_return || 0,
        rank: row.rank,
        tier: row.tier as 'elite' | 'premium' | 'good' | 'average' | 'underperforming'
      }));

    } catch (error) {
      this.logger.error(`❌ Error getting top performers for ${category}:`, error);
      return [];
    }
  }

  /**
   * 🔄 ДИНАМИЧЕСКОЕ ПЕРЕРАНЖИРОВАНИЕ всех кошельков
   */
  async reRankAllWallets(): Promise<void> {
    try {
      this.logger.info('🔄 Starting dynamic wallet re-ranking...');

      const transaction = this.db.transaction(() => {
        // Получаем все кошельки с их метриками и пересчитываем ранги
        const updateRankStmt = this.db.prepare(`
          UPDATE wallet_performance_metrics 
          SET rank_position = (
            SELECT COUNT(*) + 1 
            FROM wallet_performance_metrics pm2 
            INNER JOIN smart_money_wallets w2 ON pm2.address = w2.address
            WHERE w2.is_active = 1 AND pm2.real_time_score > wallet_performance_metrics.real_time_score
          )
          WHERE address IN (
            SELECT p.address 
            FROM wallet_performance_metrics p 
            INNER JOIN smart_money_wallets w ON p.address = w.address 
            WHERE w.is_active = 1
          )
        `);

        updateRankStmt.run();
      });

      transaction();
      this.logger.info('✅ Dynamic wallet re-ranking completed');

    } catch (error) {
      this.logger.error('❌ Error during wallet re-ranking:', error);
      throw error;
    }
  }

  /**
   * 🧹 ОЧИСТКА НЕАКТИВНЫХ Performance Records
   */
  async cleanupInactivePerformanceRecords(): Promise<number> {
    try {
      // Удаляем метрики для кошельков, которые неактивны более 30 дней
      const result = this.db.prepare(`
        DELETE FROM wallet_performance_metrics 
        WHERE address NOT IN (
          SELECT address FROM smart_money_wallets WHERE is_active = 1
        )
      `).run();

      this.logger.info(`🧹 Cleaned up ${result.changes} inactive performance records`);
      return result.changes;

    } catch (error) {
      this.logger.error('❌ Error cleaning up performance records:', error);
      return 0;
    }
  }

  // ========== СУЩЕСТВУЮЩИЕ МЕТОДЫ (сохранены все) ==========

  /**
   * ✅ ИСПРАВЛЕНО: getWalletStats для исправления ошибки компиляции
   */
  async getWalletStats(): Promise<{
    total: number;
    active: number;
    enabled: number;
    byCategory: { sniper: number; hunter: number; trader: number };
    byPriority: { high: number; medium: number; low: number };
    familyMembers: number;
  }> {
    try {
      const diagnostics = await this.getDiagnosticInfo();
      const activeWallets = await this.getAllActiveSmartWallets();
      
      // Группируем по категориям
      const byCategory = {
        sniper: activeWallets.filter(w => w.category === 'sniper').length,
        hunter: activeWallets.filter(w => w.category === 'hunter').length,
        trader: activeWallets.filter(w => w.category === 'trader').length
      };

      // Группируем по приоритету (используем performance score как базу)
      const byPriority = {
        high: activeWallets.filter(w => w.performanceScore > 85).length,
        medium: activeWallets.filter(w => w.performanceScore >= 70 && w.performanceScore <= 85).length,
        low: activeWallets.filter(w => w.performanceScore < 70).length
      };

      return {
        total: diagnostics.totalWallets,
        active: diagnostics.activeWallets,
        enabled: diagnostics.enabledWallets,
        byCategory,
        byPriority,
        familyMembers: 0 // Family detection отключена
      };

    } catch (error) {
      this.logger.error('❌ Error getting wallet stats:', error);
      return {
        total: 0,
        active: 0,
        enabled: 0,
        byCategory: { sniper: 0, hunter: 0, trader: 0 },
        byPriority: { high: 0, medium: 0, low: 0 },
        familyMembers: 0
      };
    }
  }

  /**
   * ✅ ИСПРАВЛЕНО: Очищает все кошельки из базы данных с правильным порядком удаления
   */
  async clearAllWallets(): Promise<number> {
    try {
      const countRow = this.db.prepare('SELECT COUNT(*) as count FROM smart_money_wallets').get() as any;
      const walletCount = countRow.count;

      // ✅ КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Правильный порядок удаления
      const transactionCountRow = this.db.prepare('SELECT COUNT(*) as count FROM smart_money_transactions').get() as any;
      const transactionCount = transactionCountRow.count;
      
      // Удаляем в правильном порядке
      this.db.prepare('DELETE FROM wallet_performance_history').run();
      this.db.prepare('DELETE FROM wallet_performance_metrics').run();
      this.db.prepare('DELETE FROM smart_money_transactions').run();
      this.db.prepare('DELETE FROM smart_money_wallets').run();

      this.logger.info(`🧹 Cleared ${walletCount} wallets, ${transactionCount} transactions, and all performance data`);
      return walletCount;
    } catch (error) {
      this.logger.error('❌ Error clearing all wallets:', error);
      throw error;
    }
  }

  /**
   * 🚀 НОВЫЙ МЕТОД: Безопасная замена всех кошельков с performance metrics
   */
  async safeReplaceAllWallets(newWallets: SmartMoneyWallet[], configs?: any[]): Promise<void> {
    const transaction = this.db.transaction(() => {
      try {
        // 1. Удаляем в правильном порядке
        this.db.prepare('DELETE FROM wallet_performance_history').run();
        this.db.prepare('DELETE FROM wallet_performance_metrics').run();
        this.db.prepare('DELETE FROM smart_money_transactions').run();
        const walletResult = this.db.prepare('DELETE FROM smart_money_wallets').run();
        this.logger.info(`🧹 Cleared ${walletResult.changes} existing wallets`);
        
        // 2. Добавляем новые кошельки с performance metrics
        for (let i = 0; i < newWallets.length; i++) {
          const wallet = newWallets[i];
          const config = configs?.[i];
          
          // Добавляем основной кошелек
          const stmt = this.db.prepare(`
            INSERT INTO smart_money_wallets (
              address, category, nickname, description,
              win_rate, total_pnl, total_trades, avg_trade_size, max_trade_size, min_trade_size, performance_score,
              sharpe_ratio, max_drawdown, volume_score, early_entry_rate, avg_hold_time,
              min_trade_alert, priority, enabled,
              is_active, verified, last_active_at,
              is_family_member, family_addresses, coordination_score, stealth_level,
              added_by, added_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          `);

          const normalizedAddedBy = config?.addedBy === 'placeholder' ? 'discovery' : (config?.addedBy || 'manual');
          const safeEnabled = config?.verified !== undefined ? (config.verified ? 1 : 0) : 0;

          stmt.run(
            wallet.address,
            wallet.category,
            config?.nickname || `${wallet.category.charAt(0).toUpperCase() + wallet.category.slice(1)} ${wallet.address.slice(0, 8)}`,
            config?.description || `Автоматически добавленный ${wallet.category} кошелек`,
            wallet.winRate,
            wallet.totalPnL,
            wallet.totalTrades,
            wallet.avgTradeSize,
            wallet.maxTradeSize,
            wallet.minTradeSize,
            wallet.performanceScore,
            wallet.sharpeRatio || null,
            wallet.maxDrawdown || null,
            wallet.volumeScore || null,
            wallet.earlyEntryRate || null,
            wallet.avgHoldTime || null,
            config?.minTradeAlert || (wallet.category === 'trader' ? 15000 : wallet.category === 'hunter' ? 5000 : 3000),
            config?.priority || (wallet.performanceScore > 85 ? 'high' : 'medium'),
            1, // enabled
            wallet.isActive ? 1 : 0,
            safeEnabled, // verified
            wallet.lastActiveAt.toISOString(),
            false, // is_family_member
            null,  // family_addresses
            0,     // coordination_score
            wallet.stealthLevel || null,
            normalizedAddedBy,
            new Date().toISOString()
          );

          // 🆕 Добавляем performance metrics
          const tier = this.calculateTierFromScore(wallet.performanceScore);
          const perfStmt = this.db.prepare(`
            INSERT INTO wallet_performance_metrics (
              address, real_time_score, tier, created_at, last_updated
            ) VALUES (?, ?, ?, datetime('now'), datetime('now'))
          `);
          
          perfStmt.run(wallet.address, wallet.performanceScore, tier);
        }
      } catch (error) {
        this.logger.error('❌ Error in wallet replacement transaction:', error);
        throw error;
      }
    });

    transaction();
    this.logger.info(`✅ Successfully replaced all wallets with performance tracking: ${newWallets.length} new wallets added`);
  }

  async walletExists(address: string): Promise<boolean> {
    try {
      const row = this.db.prepare('SELECT 1 FROM smart_money_wallets WHERE address = ? LIMIT 1').get(address);
      return !!row;
    } catch (error) {
      this.logger.error('❌ Error checking wallet existence:', error);
      throw error;
    }
  }

  async getDiagnosticInfo(): Promise<{
    totalWallets: number;
    activeWallets: number;
    enabledWallets: number;
    recentAddresses: string[];
    oldestAddresses: string[];
  }> {
    try {
      const totalRow = this.db.prepare('SELECT COUNT(*) as count FROM smart_money_wallets').get() as any;
      const activeRow = this.db.prepare('SELECT COUNT(*) as count FROM smart_money_wallets WHERE is_active = 1').get() as any;
      
      // Проверяем наличие колонки enabled
      const tableInfo = this.db.prepare("PRAGMA table_info(smart_money_wallets)").all() as any[];
      const hasEnabledColumn = tableInfo.some((col: any) => col.name === 'enabled');
      
      let enabledCount = 0;
      if (hasEnabledColumn) {
        const enabledRow = this.db.prepare('SELECT COUNT(*) as count FROM smart_money_wallets WHERE enabled = 1').get() as any;
        enabledCount = enabledRow.count;
      }

      // Получаем последние добавленные адреса
      const recentRows = this.db.prepare(`
        SELECT address FROM smart_money_wallets 
        ORDER BY created_at DESC, address DESC 
        LIMIT 5
      `).all() as any[];
      
      // Получаем самые старые адреса
      const oldestRows = this.db.prepare(`
        SELECT address FROM smart_money_wallets 
        ORDER BY created_at ASC, address ASC 
        LIMIT 5
      `).all() as any[];

      return {
        totalWallets: totalRow.count,
        activeWallets: activeRow.count,
        enabledWallets: enabledCount,
        recentAddresses: recentRows.map(row => row.address),
        oldestAddresses: oldestRows.map(row => row.address)
      };
    } catch (error) {
      this.logger.error('❌ Error getting diagnostic info:', error);
      throw error;
    }
  }

  private mapRowToWallet(row: any): SmartMoneyWallet {
    return {
      address: row.address,
      category: row.category,
      winRate: row.win_rate,
      totalPnL: row.total_pnl,
      totalTrades: row.total_trades,
      avgTradeSize: row.avg_trade_size,
      maxTradeSize: row.max_trade_size,
      minTradeSize: row.min_trade_size,
      sharpeRatio: row.sharpe_ratio,
      maxDrawdown: row.max_drawdown,
      lastActiveAt: new Date(row.last_active_at),
      performanceScore: row.performance_score,
      volumeScore: row.volume_score,
      isActive: !!row.is_active,
      
      // Family поля ОТКЛЮЧЕНЫ
      isFamilyMember: false,
      familyAddresses: undefined,
      coordinationScore: 0,
      stealthLevel: row.stealth_level,
      
      // Категория-специфичные метрики
      earlyEntryRate: row.early_entry_rate,
      avgHoldTime: row.avg_hold_time,
      
      createdAt: row.created_at ? new Date(row.created_at) : undefined,
      updatedAt: row.updated_at ? new Date(row.updated_at) : undefined
    };
  }

  // ========== ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ==========

  /**
   * 🎯 РАСЧЕТ TIER на основе score
   */
  private calculateTierFromScore(score: number): 'elite' | 'premium' | 'good' | 'average' | 'underperforming' {
    if (score >= this.PROFIT_THRESHOLDS.elite) return 'elite';
    if (score >= this.PROFIT_THRESHOLDS.premium) return 'premium';
    if (score >= this.PROFIT_THRESHOLDS.good) return 'good';
    if (score >= this.PROFIT_THRESHOLDS.average) return 'average';
    return 'underperforming';
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.logger.info('📊 Smart Money Database connection closed');
    }
  }
}