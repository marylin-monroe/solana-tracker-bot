// src/services/SmartMoneyDatabase.ts - DRAGON БД СИСТЕМА ПОЛНОЙ ЗАМЕНЫ + SQLITE BOOLEAN FIX
import BetterSqlite3 from 'better-sqlite3';
import { Logger } from '../utils/Logger';
import { SmartMoneyWallet, TokenSwap } from '../types';
import path from 'path';
import fs from 'fs';

interface WalletPerformanceUpdate {
  address: string; currentPnL: number; last30DaysPnL: number; last7DaysPnL: number;
  profitFactor: number; recentWinRate: number; realTimeScore: number;
  trendDirection: 'up' | 'down' | 'stable'; lastUpdated: Date;
}

interface WalletRankingMetrics {
  address: string; category: 'sniper' | 'hunter' | 'trader'; realTimeScore: number;
  profitFactor: number; recentPnL: number; consistencyScore: number;
  riskAdjustedReturn: number; rank: number;
  tier: 'elite' | 'premium' | 'good' | 'average' | 'underperforming';
}

interface ProfitFirstStats {
  totalWallets: number; eliteWallets: number; premiumWallets: number;
  avgRealTimeScore: number; avgProfitFactor: number; totalRecentPnL: number;
  topPerformers: WalletRankingMetrics[]; underperformers: WalletRankingMetrics[];
}

export class SmartMoneyDatabase {
  private db: BetterSqlite3.Database;
  private logger: Logger;
  private readonly PERFORMANCE_UPDATE_INTERVAL = 30 * 60 * 1000;
  private lastPerformanceUpdate = 0;
  
  private readonly PROFIT_THRESHOLDS = {
    elite: 90, premium: 80, good: 70, average: 60, underperforming: 0
  }

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

      await this.migrateExistingData();

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_sm_wallets_category ON smart_money_wallets(category);
        CREATE INDEX IF NOT EXISTS idx_sm_wallets_active ON smart_money_wallets(is_active);
        CREATE INDEX IF NOT EXISTS idx_sm_wallets_performance ON smart_money_wallets(performance_score);
        CREATE INDEX IF NOT EXISTS idx_sm_transactions_wallet ON smart_money_transactions(wallet_address);
        CREATE INDEX IF NOT EXISTS idx_performance_score ON wallet_performance_metrics(real_time_score);
        CREATE INDEX IF NOT EXISTS idx_performance_tier ON wallet_performance_metrics(tier);
      `);

      const tableInfo = this.db.prepare("PRAGMA table_info(smart_money_wallets)").all() as any[];
      const columnNames = tableInfo.map((col: any) => col.name);

      if (columnNames.includes('enabled')) {
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sm_wallets_enabled ON smart_money_wallets(enabled);`);
      }
      if (columnNames.includes('priority')) {
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sm_wallets_priority ON smart_money_wallets(priority);`);
      }

      this.logger.info('✅ Smart Money Database initialized with Dragon replacement system');
    } catch (error) {
      this.logger.error('❌ Error initializing Smart Money database:', error);
      throw error;
    }
  }

  private async migrateExistingData(): Promise<void> {
    try {
      const tableInfo = this.db.prepare("PRAGMA table_info(smart_money_wallets)").all() as any[];
      const columnNames = tableInfo.map((col: any) => col.name);

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

  // ========== 🐲 DRAGON МЕТОДЫ ==========

  async clearAllDragonWallets(): Promise<number> {
    try {
      this.logger.info('🗑️ Clearing all Dragon wallets from database...');
      
      const transaction = this.db.transaction(() => {
        const deleteHistoryStmt = this.db.prepare(`
          DELETE FROM wallet_performance_history 
          WHERE address IN (SELECT address FROM smart_money_wallets WHERE added_by = 'dragon')
        `);
        
        const deletePerformanceStmt = this.db.prepare(`
          DELETE FROM wallet_performance_metrics 
          WHERE address IN (SELECT address FROM smart_money_wallets WHERE added_by = 'dragon')
        `);
        
        const deleteWalletsStmt = this.db.prepare(`DELETE FROM smart_money_wallets WHERE added_by = 'dragon'`);

        const historyResult = deleteHistoryStmt.run();
        const performanceResult = deletePerformanceStmt.run();
        const walletsResult = deleteWalletsStmt.run();
        
        return walletsResult.changes;
      });

      const deletedCount = transaction();
      this.logger.info(`✅ Cleared ${deletedCount} Dragon wallets from database`);
      return deletedCount;
      
    } catch (error) {
      this.logger.error('❌ Error clearing Dragon wallets:', error);
      throw error;
    }
  }

  async replaceDragonWallets(newWallets: SmartMoneyWallet[]): Promise<{
    cleared: number; added: number; errors: string[];
  }> {
    try {
      this.logger.info(`🔄 Replacing Dragon wallets: ${newWallets.length} new wallets`);
      
      const clearedCount = await this.clearAllDragonWallets();
      
      let addedCount = 0;
      const errors: string[] = [];
      
      for (const wallet of newWallets) {
        try {
          await this.saveSmartWallet(wallet, {
            nickname: `Dragon-${wallet.address.slice(0, 8)}`,
            addedBy: 'dragon',
            verified: true,
            enabled: true,
            priority: this.determinePriority(wallet)
          });
          addedCount++;
        } catch (error) {
          const errorMsg = `Failed to add ${wallet.address}: ${error}`;
          errors.push(errorMsg);
          this.logger.warn(`⚠️ ${errorMsg}`);
        }
      }
      
      this.logger.info(`✅ Dragon replacement completed: cleared ${clearedCount}, added ${addedCount}`);
      return { cleared: clearedCount, added: addedCount, errors };
      
    } catch (error) {
      this.logger.error('❌ Error in Dragon wallet replacement:', error);
      throw error;
    }
  }

  private determinePriority(wallet: SmartMoneyWallet): 'high' | 'medium' | 'low' {
    if (wallet.totalPnL >= 1000000) return 'high';
    if (wallet.totalPnL >= 500000) return 'high';
    if (wallet.winRate >= 60) return 'high';
    return 'medium';
  }

  async getWalletSource(address: string): Promise<string | null> {
    try {
      const tableInfo = this.db.prepare("PRAGMA table_info(smart_money_wallets)").all() as any[];
      const hasAddedByColumn = tableInfo.some((col: any) => col.name === 'added_by');
      
      if (!hasAddedByColumn) {
        return null;
      }
      
      const row = this.db.prepare('SELECT added_by FROM smart_money_wallets WHERE address = ?').get(address) as any;
      return row?.added_by || null;
    } catch (error) {
      this.logger.error(`❌ Error getting wallet source for ${address}:`, error);
      return null;
    }
  }

  async findSuspiciousDragonWallets(): Promise<Array<{
    address: string; last_active_at: string; created_at: string;
  }>> {
    try {
      const tableInfo = this.db.prepare("PRAGMA table_info(smart_money_wallets)").all() as any[];
      const hasAddedByColumn = tableInfo.some((col: any) => col.name === 'added_by');
      
      if (!hasAddedByColumn) {
        this.logger.warn('⚠️ added_by column does not exist, cannot find Dragon wallets');
        return [];
      }

      const query = `
        SELECT address, last_active_at, created_at
        FROM smart_money_wallets 
        WHERE added_by = 'dragon' 
          AND is_active = 1 
          AND enabled = 1
          AND ABS(strftime('%s', last_active_at) - strftime('%s', created_at)) < 300
        ORDER BY total_pnl DESC
      `;

      const rows = this.db.prepare(query).all() as Array<{
        address: string; last_active_at: string; created_at: string;
      }>;

      return rows;
    } catch (error) {
      this.logger.error('❌ Error finding suspicious Dragon wallets:', error);
      return [];
    }
  }

  async getWalletsBySource(): Promise<{
    manual: number; dragon: number; discovery: number; other: number; total: number;
  }> {
    try {
      const stmt = this.db.prepare(`
        SELECT added_by, COUNT(*) as count
        FROM smart_money_wallets 
        WHERE is_active = 1 AND enabled = 1
        GROUP BY added_by
      `);
      
      const results = stmt.all() as Array<{ added_by: string | null; count: number }>;
      
      const stats = { manual: 0, dragon: 0, discovery: 0, other: 0, total: 0 };
      
      for (const result of results) {
        const count = result.count;
        stats.total += count;
        
        switch (result.added_by) {
          case 'manual': stats.manual = count; break;
          case 'dragon': stats.dragon = count; break;
          case 'discovery': stats.discovery = count; break;
          default: stats.other += count; break;
        }
      }
      
      return stats;
      
    } catch (error) {
      this.logger.error('Error getting wallet stats by source:', error);
      return { manual: 0, dragon: 0, discovery: 0, other: 0, total: 0 };
    }
  }

  // ========== ОСНОВНЫЕ МЕТОДЫ ==========

  async saveSmartWallet(wallet: SmartMoneyWallet, config?: {
    nickname?: string; description?: string; minTradeAlert?: number;
    priority?: 'high' | 'medium' | 'low'; enabled?: boolean; verified?: boolean;
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
        0, // 🔥 ИСПРАВЛЕНО: было false, стало 0
        null,
        0,
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
        wallet.address, wallet.category, wallet.winRate, wallet.totalPnL, wallet.totalTrades,
        wallet.avgTradeSize, wallet.maxTradeSize, wallet.minTradeSize, wallet.performanceScore,
        wallet.sharpeRatio || null, wallet.maxDrawdown || null, wallet.lastActiveAt.toISOString(),
        wallet.isActive ? 1 : 0, 0, null, 0, wallet.stealthLevel || null, // 🔥 ИСПРАВЛЕНО: 0 вместо false
        wallet.earlyEntryRate || null, wallet.avgHoldTime || null, wallet.volumeScore || null
      );
    }

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
    minTradeAlert?: number; priority?: 'high' | 'medium' | 'low'; enabled?: boolean;
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
      params.push(settings.enabled ? 1 : 0); // 🔥 ИСПРАВЛЕНО: явная конвертация в 1/0
    }

    if (updates.length > 0) {
      updates.push('updated_at = datetime(\'now\')');
      params.push(address);
      const query = `UPDATE smart_money_wallets SET ${updates.join(', ')} WHERE address = ?`;
      this.db.prepare(query).run(...params);
    }
  }

  async getWalletSettings(address: string): Promise<{
    minTradeAlert: number; priority: 'high' | 'medium' | 'low'; enabled: boolean;
    nickname?: string; description?: string;
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

  // ========== PERFORMANCE МЕТОДЫ ==========

  private async initializeWalletPerformanceMetrics(address: string, initialScore: number = 50): Promise<void> {
    try {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO wallet_performance_metrics (
          address, real_time_score, tier, created_at, last_updated
        ) VALUES (?, ?, ?, datetime('now'), datetime('now'))
      `);
      const tier = this.calculateTierFromScore(initialScore);
      stmt.run(address, initialScore, tier);
    } catch (error) {
      this.logger.error(`❌ Error initializing performance metrics for ${address}:`, error);
    }
  }

  private async updateWalletPerformanceOnTransaction(
    address: string, 
    transaction: { amountUSD: number; swapType: 'buy' | 'sell'; timestamp: Date }
  ): Promise<void> {
    try {
      const current = await this.getWalletPerformanceMetrics(address);
      if (!current) return;

      let scoreChange = 0;
      if (transaction.swapType === 'buy' && transaction.amountUSD > 10000) {
        scoreChange = 2;
      } else if (transaction.swapType === 'sell' && transaction.amountUSD > 50000) {
        scoreChange = 3;
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

  async getWalletPerformanceMetrics(address: string): Promise<WalletPerformanceUpdate | null> {
    try {
      const row = this.db.prepare(`SELECT * FROM wallet_performance_metrics WHERE address = ?`).get(address) as any;
      if (!row) return null;
      return {
        address: row.address, currentPnL: row.current_pnl, last30DaysPnL: row.last_30days_pnl,
        last7DaysPnL: row.last_7days_pnl, profitFactor: row.profit_factor, recentWinRate: row.recent_win_rate,
        realTimeScore: row.real_time_score, trendDirection: row.trend_direction, lastUpdated: new Date(row.last_updated)
      };
    } catch (error) {
      this.logger.error(`❌ Error getting performance metrics for ${address}:`, error);
      return null;
    }
  }

  async safeReplaceAllWallets(newWallets: SmartMoneyWallet[], configs?: any[]): Promise<void> {
    const transaction = this.db.transaction(() => {
      try {
        this.db.prepare('DELETE FROM wallet_performance_history').run();
        this.db.prepare('DELETE FROM wallet_performance_metrics').run();
        this.db.prepare('DELETE FROM smart_money_transactions').run();
        const walletResult = this.db.prepare('DELETE FROM smart_money_wallets').run();
        this.logger.info(`🧹 Cleared ${walletResult.changes} existing wallets`);
        
        for (let i = 0; i < newWallets.length; i++) {
          const wallet = newWallets[i];
          const config = configs?.[i];
          
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
            wallet.address, wallet.category,
            config?.nickname || `${wallet.category.charAt(0).toUpperCase() + wallet.category.slice(1)} ${wallet.address.slice(0, 8)}`,
            config?.description || `Автоматически добавленный ${wallet.category} кошелек`,
            wallet.winRate, wallet.totalPnL, wallet.totalTrades, wallet.avgTradeSize, wallet.maxTradeSize, wallet.minTradeSize,
            wallet.performanceScore, wallet.sharpeRatio || null, wallet.maxDrawdown || null, wallet.volumeScore || null,
            wallet.earlyEntryRate || null, wallet.avgHoldTime || null,
            config?.minTradeAlert || (wallet.category === 'trader' ? 15000 : wallet.category === 'hunter' ? 5000 : 3000),
            config?.priority || (wallet.performanceScore > 85 ? 'high' : 'medium'),
            1, // enabled
            wallet.isActive ? 1 : 0, safeEnabled, wallet.lastActiveAt.toISOString(),
            0, null, 0, wallet.stealthLevel || null, // 🔥 ИСПРАВЛЕНО: 0 вместо false
            normalizedAddedBy, new Date().toISOString()
          );

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

  async getWalletStats(): Promise<{
    total: number; active: number; enabled: number;
    byCategory: { sniper: number; hunter: number; trader: number };
    byPriority: { high: number; medium: number; low: number };
    familyMembers: number;
  }> {
    try {
      const diagnostics = await this.getDiagnosticInfo();
      const activeWallets = await this.getAllActiveSmartWallets();
      
      const byCategory = {
        sniper: activeWallets.filter(w => w.category === 'sniper').length,
        hunter: activeWallets.filter(w => w.category === 'hunter').length,
        trader: activeWallets.filter(w => w.category === 'trader').length
      };

      const byPriority = {
        high: activeWallets.filter(w => w.performanceScore > 85).length,
        medium: activeWallets.filter(w => w.performanceScore >= 70 && w.performanceScore <= 85).length,
        low: activeWallets.filter(w => w.performanceScore < 70).length
      };

      return {
        total: diagnostics.totalWallets, active: diagnostics.activeWallets, enabled: diagnostics.enabledWallets,
        byCategory, byPriority, familyMembers: 0
      };
    } catch (error) {
      this.logger.error('❌ Error getting wallet stats:', error);
      return {
        total: 0, active: 0, enabled: 0,
        byCategory: { sniper: 0, hunter: 0, trader: 0 },
        byPriority: { high: 0, medium: 0, low: 0 },
        familyMembers: 0
      };
    }
  }

  async getDiagnosticInfo(): Promise<{
    totalWallets: number; activeWallets: number; enabledWallets: number;
    recentAddresses: string[]; oldestAddresses: string[];
  }> {
    try {
      const totalRow = this.db.prepare('SELECT COUNT(*) as count FROM smart_money_wallets').get() as any;
      const activeRow = this.db.prepare('SELECT COUNT(*) as count FROM smart_money_wallets WHERE is_active = 1').get() as any;
      
      const tableInfo = this.db.prepare("PRAGMA table_info(smart_money_wallets)").all() as any[];
      const hasEnabledColumn = tableInfo.some((col: any) => col.name === 'enabled');
      
      let enabledCount = 0;
      if (hasEnabledColumn) {
        const enabledRow = this.db.prepare('SELECT COUNT(*) as count FROM smart_money_wallets WHERE enabled = 1').get() as any;
        enabledCount = enabledRow.count;
      }

      const recentRows = this.db.prepare(`SELECT address FROM smart_money_wallets ORDER BY created_at DESC, address DESC LIMIT 5`).all() as any[];
      const oldestRows = this.db.prepare(`SELECT address FROM smart_money_wallets ORDER BY created_at ASC, address ASC LIMIT 5`).all() as any[];

      return {
        totalWallets: totalRow.count, activeWallets: activeRow.count, enabledWallets: enabledCount,
        recentAddresses: recentRows.map(row => row.address), oldestAddresses: oldestRows.map(row => row.address)
      };
    } catch (error) {
      this.logger.error('❌ Error getting diagnostic info:', error);
      throw error;
    }
  }

  private mapRowToWallet(row: any): SmartMoneyWallet {
    return {
      address: row.address, category: row.category, winRate: row.win_rate, totalPnL: row.total_pnl,
      totalTrades: row.total_trades, avgTradeSize: row.avg_trade_size, maxTradeSize: row.max_trade_size,
      minTradeSize: row.min_trade_size, sharpeRatio: row.sharpe_ratio, maxDrawdown: row.max_drawdown,
      lastActiveAt: new Date(row.last_active_at), performanceScore: row.performance_score,
      volumeScore: row.volume_score, isActive: !!row.is_active, isFamilyMember: false,
      familyAddresses: undefined, coordinationScore: 0, stealthLevel: row.stealth_level,
      earlyEntryRate: row.early_entry_rate, avgHoldTime: row.avg_hold_time,
      createdAt: row.created_at ? new Date(row.created_at) : undefined,
      updatedAt: row.updated_at ? new Date(row.updated_at) : undefined
    };
  }

  private calculateTierFromScore(score: number): 'elite' | 'premium' | 'good' | 'average' | 'underperforming' {
    if (score >= this.PROFIT_THRESHOLDS.elite) return 'elite';
    if (score >= this.PROFIT_THRESHOLDS.premium) return 'premium';
    if (score >= this.PROFIT_THRESHOLDS.good) return 'good';
    if (score >= this.PROFIT_THRESHOLDS.average) return 'average';
    return 'underperforming';
  }

  // ========== ОСТАЛЬНЫЕ МЕТОДЫ ==========

  async saveSmartMoneyTransaction(swapInfo: any): Promise<void> {
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
        swapInfo.transactionId, swapInfo.walletAddress, swapInfo.tokenAddress,
        swapInfo.tokenSymbol, swapInfo.tokenName, swapInfo.tokenAmount, swapInfo.amountUSD,
        swapInfo.swapType, swapInfo.timestamp.toISOString(), swapInfo.dex || 'Smart-Money',
        swapInfo.category, 0, null, swapInfo.pnl, swapInfo.winRate, swapInfo.totalTrades
      );

      await this.updateWalletPerformanceOnTransaction(swapInfo.walletAddress, swapInfo);
    } catch (error) {
      this.logger.error('❌ Error saving Smart Money transaction:', error);
      throw error;
    }
  }

  async getSmartWalletTransactions(walletAddress: string, afterDate: Date): Promise<TokenSwap[]> {
    const rows = this.db.prepare(`
      SELECT * FROM smart_money_transactions 
      WHERE wallet_address = ? AND timestamp > ?
      ORDER BY timestamp DESC
    `).all(walletAddress, afterDate.toISOString()) as any[];

    return rows.map(row => ({
      transactionId: row.transaction_id, walletAddress: row.wallet_address, tokenAddress: row.token_address,
      tokenSymbol: row.token_symbol, tokenName: row.token_name, amount: row.amount, amountUSD: row.amount_usd,
      timestamp: new Date(row.timestamp), dex: row.dex, isNewWallet: false, isReactivatedWallet: false,
      walletAge: 0, daysSinceLastActivity: 0, swapType: row.swap_type as 'buy' | 'sell'
    }));
  }

  async updateWalletPerformance(address: string, metrics: {
    winRate: number; totalPnL: number; totalTrades: number; lastActiveAt: Date; performanceScore?: number;
  }): Promise<void> {
    this.db.prepare(`
      UPDATE smart_money_wallets 
      SET win_rate = ?, total_pnl = ?, total_trades = ?, last_active_at = ?, 
          performance_score = COALESCE(?, performance_score), updated_at = datetime('now')
      WHERE address = ?
    `).run(
      metrics.winRate, metrics.totalPnL, metrics.totalTrades,
      metrics.lastActiveAt.toISOString(), metrics.performanceScore || null, address
    );
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.logger.info('📊 Smart Money Database connection closed');
    }
  }
}