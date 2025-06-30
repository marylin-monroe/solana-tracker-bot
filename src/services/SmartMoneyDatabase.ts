// src/services/SmartMoneyDatabase.ts - 🔥 ПОЛНОСТЬЮ ПЕРЕРАБОТАНО ПОД НОВУЮ CSV СТРУКТУРУ
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

  // 🔥 ЗАЩИТА ОТ ПОВРЕЖДЕННЫХ ФАЙЛОВ
  if (fs.existsSync(dbPath)) {
    try {
      // Пытаемся открыть файл для проверки
      const testDb = new BetterSqlite3(dbPath, { readonly: true });
      testDb.prepare("SELECT name FROM sqlite_master LIMIT 1").all();
      testDb.close();
      this.logger.info(`✅ Existing SmartMoney database is valid`);
    } catch (error) {
      this.logger.warn(`⚠️ Corrupted SmartMoney database detected, recreating...`);
      // Создаем бэкап поврежденного файла
      const backupPath = `${dbPath}.corrupted.${Date.now()}`;
      fs.renameSync(dbPath, backupPath);
      this.logger.info(`📁 Corrupted file backed up to: ${path.basename(backupPath)}`);
    }
  }

  this.db = new BetterSqlite3(dbPath);
}

  async init(): Promise<void> {
    try {
      // 🔥🔥🔥 УМНАЯ МИГРАЦИЯ: ПРОВЕРЯЕМ СХЕМУ И ДОБАВЛЯЕМ НЕДОСТАЮЩИЕ КОЛОНКИ 🔥🔥🔥
      this.logger.info('🔍 Checking existing database schema...');
      
      // 🔥 СОЗДАЕМ ТАБЛИЦЫ ЕСЛИ ИХ НЕТ (СОХРАНЯЕМ СУЩЕСТВУЮЩИЕ!)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS smart_money_wallets (
          address TEXT PRIMARY KEY,
          category TEXT CHECK (category IN ('sniper', 'hunter', 'trader')) NOT NULL,
          nickname TEXT,
          
          -- Системные поля (всегда должны быть)
          performance_score REAL NOT NULL DEFAULT 50,
          is_active BOOLEAN DEFAULT 1,
          last_active_at DATETIME NOT NULL,
          
          -- Дополнительные поля для совместимости
          is_family_member BOOLEAN DEFAULT 0,
          family_addresses TEXT,
          coordination_score REAL DEFAULT 0,
          stealth_level REAL,
          early_entry_rate REAL,
          volume_score REAL,
          
          -- Управление
          enabled BOOLEAN DEFAULT 1,
          priority TEXT DEFAULT "medium",
          added_by TEXT DEFAULT "discovery",
          verified BOOLEAN DEFAULT 0,
          min_trade_alert REAL DEFAULT 2000,
          description TEXT,
          
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

      // 🔥🔥🔥 МИГРАЦИЯ: ДОБАВЛЯЕМ НОВЫЕ CSV КОЛОНКИ ЕСЛИ ИХ НЕТ 🔥🔥🔥
      this.logger.info('🔄 Migrating database schema: adding CSV columns...');
      
      try {
        // Проверяем и добавляем новые CSV колонки в smart_money_wallets
        const addColumnQueries = [
          `ALTER TABLE smart_money_wallets ADD COLUMN usd_profit_7d REAL NOT NULL DEFAULT 0`,
          `ALTER TABLE smart_money_wallets ADD COLUMN usd_profit_30d REAL NOT NULL DEFAULT 0`,
          `ALTER TABLE smart_money_wallets ADD COLUMN winrate_7d REAL NOT NULL DEFAULT 0`,
          `ALTER TABLE smart_money_wallets ADD COLUMN buy_7d INTEGER NOT NULL DEFAULT 0`,
          `ALTER TABLE smart_money_wallets ADD COLUMN avg_holding_mins REAL NOT NULL DEFAULT 0`,
          `ALTER TABLE smart_money_wallets ADD COLUMN total_profit_percent REAL NOT NULL DEFAULT 0`,
          `ALTER TABLE smart_money_wallets ADD COLUMN sol_balance REAL NOT NULL DEFAULT 0`,
          `ALTER TABLE smart_money_transactions ADD COLUMN wallet_usd_profit_7d REAL`,
          `ALTER TABLE smart_money_transactions ADD COLUMN wallet_winrate_7d REAL`,
          `ALTER TABLE smart_money_transactions ADD COLUMN wallet_buy_7d INTEGER`
        ];

        for (const query of addColumnQueries) {
          try {
            this.db.exec(query);
            this.logger.debug(`✅ Added column: ${query.split(' ')[4]}`);
          } catch (error) {
            // Колонка уже существует - это нормально
            if (!error.message.includes('duplicate column name')) {
              this.logger.warn(`⚠️ Migration warning: ${error.message}`);
            }
          }
        }
        
        this.logger.info('✅ Database migration completed successfully');
      } catch (error) {
        this.logger.error('❌ Error during database migration:', error);
        // Не падаем - продолжаем работу
      }

      // 🔥 СОЗДАЕМ ИНДЕКСЫ (С IF NOT EXISTS ЧТОБЫ НЕ БЫЛО ОШИБОК!)
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_sm_wallets_category ON smart_money_wallets(category);
        CREATE INDEX IF NOT EXISTS idx_sm_wallets_active ON smart_money_wallets(is_active);
        CREATE INDEX IF NOT EXISTS idx_sm_wallets_performance ON smart_money_wallets(performance_score);
        CREATE INDEX IF NOT EXISTS idx_sm_wallets_usd_profit_7d ON smart_money_wallets(usd_profit_7d);
        CREATE INDEX IF NOT EXISTS idx_sm_wallets_winrate_7d ON smart_money_wallets(winrate_7d);
        CREATE INDEX IF NOT EXISTS idx_sm_wallets_enabled ON smart_money_wallets(enabled);
        CREATE INDEX IF NOT EXISTS idx_sm_wallets_priority ON smart_money_wallets(priority);
        CREATE INDEX IF NOT EXISTS idx_sm_wallets_added_by ON smart_money_wallets(added_by);
        CREATE INDEX IF NOT EXISTS idx_sm_transactions_wallet ON smart_money_transactions(wallet_address);
        CREATE INDEX IF NOT EXISTS idx_performance_score ON wallet_performance_metrics(real_time_score);
        CREATE INDEX IF NOT EXISTS idx_performance_tier ON wallet_performance_metrics(tier);
      `);

      // Проверяем статистику существующих кошельков
      const existingWalletCount = this.db.prepare('SELECT COUNT(*) as count FROM smart_money_wallets').get() as any;
      
      this.logger.info(`✅ Smart Money Database initialized with CSV migration support`);
      this.logger.info(`📊 Found ${existingWalletCount?.count || 0} existing wallets in database`);
      
      if (existingWalletCount?.count > 0) {
        const sourceStats = this.db.prepare(`
          SELECT added_by, COUNT(*) as count 
          FROM smart_money_wallets 
          WHERE is_active = 1 AND enabled = 1 
          GROUP BY added_by
        `).all() as Array<{ added_by: string; count: number }>;
        
        const statsStr = sourceStats.map(s => `${s.added_by}: ${s.count}`).join(', ');
        this.logger.info(`📈 Active wallet sources: ${statsStr}`);
      }
      
    } catch (error) {
      this.logger.error('❌ Error initializing Smart Money database:', error);
      throw error;
    }
  }

  // 🔥 НОВЫЙ МЕТОД: Получение кошельков по источнику (для разделения БД)
  async getWalletsByAddedBy(source: 'manual' | 'dragon' | 'discovery' | string): Promise<SmartMoneyWallet[]> {
    try {
      const query = `SELECT * FROM smart_money_wallets WHERE added_by = ? AND is_active = 1`;
      const rows = this.db.prepare(query).all(source) as any[];
      
      this.logger.debug(`📊 Found ${rows.length} wallets with added_by = '${source}'`);
      return rows.map(row => this.mapRowToWallet(row));
    } catch (error) {
      this.logger.error(`❌ Error getting wallets by source '${source}':`, error);
      return [];
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

  async replaceDragonWallets(newWallets: SmartMoneyWallet[], dragonTiers?: string[]): Promise<{
    cleared: number; added: number; skipped: number; errors: string[];
    priorityStats: { high: number; medium: number; low: number };
  }> {
    try {
      this.logger.info(`🔄 Replacing Dragon wallets: ${newWallets.length} new wallets`);
      
      if (dragonTiers && dragonTiers.length !== newWallets.length) {
        this.logger.warn(`⚠️ Dragon tiers array length (${dragonTiers.length}) doesn't match wallets (${newWallets.length}), will use fallback priority logic`);
      }
      
      const clearedCount = await this.clearAllDragonWallets();
      
      let addedCount = 0;
      let skippedLowPriority = 0;
      const errors: string[] = [];
      const priorityStats = { high: 0, medium: 0, low: 0 };
      
      for (let i = 0; i < newWallets.length; i++) {
        const wallet = newWallets[i];
        const dragonTier = dragonTiers && dragonTiers.length > i ? dragonTiers[i] : undefined;
        
        try {
          const priority = this.mapDragonTierToPriority(dragonTier, wallet);
          priorityStats[priority]++;
          
          if (priority === 'low') {
            skippedLowPriority++;
            this.logger.warn(`🚫 Skipping Dragon wallet with low priority: ${wallet.address.slice(0, 8)} (tier: ${dragonTier})`);
            continue;
          }
          
          await this.saveSmartWallet(wallet, {
            nickname: wallet.nickname || `Dragon-${wallet.address.slice(0, 8)}`,
            addedBy: 'dragon',
            verified: true,
            enabled: true,
            priority: priority
          });
          addedCount++;
          
          this.logger.debug(`✅ Added Dragon wallet: ${wallet.address.slice(0, 8)} (${dragonTier} → ${priority})`);
        } catch (error) {
          const errorMsg = `Failed to add ${wallet.address}: ${error}`;
          errors.push(errorMsg);
          this.logger.warn(`⚠️ ${errorMsg}`);
        }
      }
      
      this.logger.info(`✅ Dragon replacement completed: cleared ${clearedCount}, added ${addedCount}, skipped ${skippedLowPriority} low priority`);
      this.logger.info(`📊 Priority distribution: High=${priorityStats.high}, Medium=${priorityStats.medium}, Low=${priorityStats.low}`);
      return { 
        cleared: clearedCount, 
        added: addedCount, 
        skipped: skippedLowPriority,
        errors,
        priorityStats 
      };
      
    } catch (error) {
      this.logger.error('❌ Error in Dragon wallet replacement:', error);
      throw error;
    }
  }

  // 🔥 МАППИНГ DRAGON TIER → PRIORITY
  private mapDragonTierToPriority(dragonTier: string | undefined, wallet: SmartMoneyWallet): 'high' | 'medium' | 'low' {
    if (dragonTier) {
      switch (dragonTier) {
        case 'whale':
        case 'genius':
          return 'high';
        case 'quality':
          return 'medium';
        case 'filter_out':
          return 'low';
        default:
          this.logger.warn(`⚠️ Unknown dragon tier: ${dragonTier}, fallback to determinePriority`);
          return this.determinePriority(wallet);
      }
    }
    
    return this.determinePriority(wallet);
  }

  // 🔥🔥🔥 СУПЕР УМНАЯ ЛОГИКА ОПРЕДЕЛЕНИЯ ПРИОРИТЕТА + КИТЫ + ЭФФЕКТИВНОСТЬ КАПИТАЛА 🔥🔥🔥
  private determinePriority(wallet: SmartMoneyWallet): 'high' | 'medium' | 'low' {
    const SOL_PRICE_USD = 140; // Приблизительная цена SOL
    const solBalanceUSD = wallet.solBalance * SOL_PRICE_USD;
    
    // 🐋 MEGAWHALE: 3000+ SOL - высокий приоритет независимо от времени холда
    if (wallet.solBalance >= 3000 && wallet.usdProfit7d >= 30000) {
      this.logger.debug(`🐋 HIGH priority: ${wallet.address.slice(0,8)} - MEGAWHALE (${wallet.solBalance.toLocaleString()} SOL, $${wallet.usdProfit7d.toLocaleString()})`);
      return 'high';
    }
    
    // 🐳 WHALE: 1500+ SOL - высокий приоритет независимо от времени холда  
    if (wallet.solBalance >= 1500 && wallet.usdProfit7d >= 20000) {
      this.logger.debug(`🐳 HIGH priority: ${wallet.address.slice(0,8)} - WHALE (${wallet.solBalance.toLocaleString()} SOL, $${wallet.usdProfit7d.toLocaleString()})`);
      return 'high';
    }
    
    // 🚀 ЭЛИТНЫЕ: Супер высокая 7-дневная прибыль + отличный рост капитала
    if (wallet.usdProfit7d >= 100000 && wallet.totalProfitPercent >= 10) {
      this.logger.debug(`🏆 HIGH priority: ${wallet.address.slice(0,8)} - Elite profit ($${wallet.usdProfit7d.toLocaleString()}, ${wallet.totalProfitPercent}%)`);
      return 'high';
    }
    
    // 💎 ХОРОШИЕ: Классические пороги - средняя 7-дневная прибыль + хороший рост капитала
    if (wallet.usdProfit7d >= 30000 && wallet.totalProfitPercent >= 10) {
      this.logger.debug(`💎 MEDIUM priority: ${wallet.address.slice(0,8)} - Good profit ($${wallet.usdProfit7d.toLocaleString()}, ${wallet.totalProfitPercent}%)`);
      return 'medium';
    }
    
    // 🔥🔥🔥 НОВАЯ ЛОГИКА: ЭФФЕКТИВНЫЕ ТРЕЙДЕРЫ! 🔥🔥🔥
    // Проверяем, сколько процентов от текущего баланса заработал за последние периоды
    if (solBalanceUSD > 0) {
      const profit7dPercent = (wallet.usdProfit7d / solBalanceUSD) * 100;
      const profit30dPercent = (wallet.usdProfit30d / solBalanceUSD) * 100;
      
      // Если заработал 80%+ от текущего баланса за 7 дней - это супер эффективный трейдер!
      if (profit7dPercent >= 80) {
        this.logger.debug(`🔥 MEDIUM priority: ${wallet.address.slice(0,8)} - Super efficient! 7d profit ${profit7dPercent.toFixed(1)}% of balance ($${wallet.usdProfit7d.toLocaleString()} / $${solBalanceUSD.toLocaleString()})`);
        return 'medium';
      }
      
      // Если заработал 70%+ от текущего баланса за 30 дней - тоже очень хорошо!
      if (profit30dPercent >= 70) {
        this.logger.debug(`💰 MEDIUM priority: ${wallet.address.slice(0,8)} - Efficient trader! 30d profit ${profit30dPercent.toFixed(1)}% of balance ($${wallet.usdProfit30d.toLocaleString()} / $${solBalanceUSD.toLocaleString()})`);
        return 'medium';
      }
    }
    
    // 🏅 АЛЬТЕРНАТИВНЫЙ ПУТЬ: Отличный рост капитала даже при меньшей прибыли
    if (wallet.totalProfitPercent >= 20 && wallet.usdProfit7d >= 15000) {
      this.logger.debug(`📈 MEDIUM priority: ${wallet.address.slice(0,8)} - High growth (${wallet.totalProfitPercent}%, $${wallet.usdProfit7d.toLocaleString()})`);
      return 'medium';
    }
    
    // ❌ ОСТАЛЬНЫЕ НЕ БЕРЕМ
    this.logger.debug(`❌ LOW priority: ${wallet.address.slice(0,8)} - Profit7d: $${wallet.usdProfit7d.toLocaleString()}, Growth: ${wallet.totalProfitPercent}%, Balance: $${solBalanceUSD.toLocaleString()}`);
    return 'low';
  }

  async getWalletSource(address: string): Promise<string | null> {
    try {
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
      const query = `
        SELECT address, last_active_at, created_at
        FROM smart_money_wallets 
        WHERE added_by = 'dragon' 
          AND is_active = 1 
          AND enabled = 1
          AND ABS(strftime('%s', last_active_at) - strftime('%s', created_at)) < 300
        ORDER BY usd_profit_7d DESC
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

  async getAllActiveDragonWallets(): Promise<string[]> {
    try {
      const query = `
        SELECT address FROM smart_money_wallets 
        WHERE added_by = 'dragon' AND is_active = 1 AND enabled = 1
        ORDER BY created_at ASC`;
      
      const rows = this.db.prepare(query).all() as Array<{ address: string }>;
      
      this.logger.debug(`📊 Found ${rows.length} active Dragon wallets for activity checking`);
      return rows.map(row => row.address);
      
    } catch (error) {
      this.logger.error('❌ Error getting active Dragon wallets:', error);
      return [];
    }
  }

  // ========== ОСНОВНЫЕ МЕТОДЫ ==========

  // 🔥 ПОЛНОСТЬЮ ПЕРЕПИСАН saveSmartWallet ПОД НОВУЮ СТРУКТУРУ
  async saveSmartWallet(wallet: SmartMoneyWallet, config?: {
    nickname?: string; description?: string; minTradeAlert?: number;
    priority?: 'high' | 'medium' | 'low'; enabled?: boolean; verified?: boolean;
    addedBy?: 'manual' | 'discovery' | 'dragon';
  }): Promise<void> {

    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO smart_money_wallets (
          address, category, nickname, description,
          usd_profit_7d, usd_profit_30d, winrate_7d, buy_7d, avg_holding_mins, total_profit_percent, sol_balance,
          performance_score, is_active, last_active_at,
          is_family_member, family_addresses, coordination_score, stealth_level,
          early_entry_rate, volume_score,
          enabled, priority, added_by, verified, min_trade_alert,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      stmt.run(
        wallet.address,
        wallet.category,
        config?.nickname || wallet.nickname || `${wallet.category.charAt(0).toUpperCase() + wallet.category.slice(1)} ${wallet.address.slice(0, 8)}`,
        config?.description || `High-performance ${wallet.category} кошелек`,
        
        // 🔥 НОВЫЕ CSV ПОЛЯ
        wallet.usdProfit7d,
        wallet.usdProfit30d,
        wallet.winrate7d,
        wallet.buy7d,
        wallet.avgHoldingMins,
        wallet.totalProfitPercent,
        wallet.solBalance,
        
        // Системные поля
        wallet.performanceScore,
        wallet.isActive ? 1 : 0,
        wallet.lastActiveAt.toISOString(),
        
        // Дополнительные поля (совместимость)
        0, // is_family_member
        null, // family_addresses
        0, // coordination_score
        null, // stealth_level
        null, // early_entry_rate
        null, // volume_score
        
        // Управление
        config?.enabled !== undefined ? (config.enabled ? 1 : 0) : 1,
        config?.priority || (wallet.performanceScore > 85 ? 'high' : 'medium'),
        config?.addedBy || 'discovery',
        config?.verified !== undefined ? (config.verified ? 1 : 0) : 0,
        config?.minTradeAlert || (wallet.category === 'trader' ? 15000 : wallet.category === 'hunter' ? 5000 : 3000),
        
        // Timestamps
        new Date().toISOString(),
        new Date().toISOString()
      );

      await this.initializeWalletPerformanceMetrics(wallet.address, wallet.performanceScore);
    } catch (error) {
      this.logger.error(`❌ Error saving wallet ${wallet.address}:`, error);
      throw error;
    }
  }

  async getSmartWallet(address: string): Promise<SmartMoneyWallet | null> {
    const row = this.db.prepare('SELECT * FROM smart_money_wallets WHERE address = ?').get(address) as any;
    if (!row) return null;
    return this.mapRowToWallet(row);
  }

  async getAllActiveSmartWallets(): Promise<SmartMoneyWallet[]> {
    let query = 'SELECT * FROM smart_money_wallets WHERE is_active = 1 AND enabled = 1 ORDER BY performance_score DESC';
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
    const updates: string[] = [];
    const params: any[] = [];

    if (settings.minTradeAlert !== undefined) {
      updates.push('min_trade_alert = ?');
      params.push(settings.minTradeAlert);
    }
    if (settings.priority !== undefined) {
      updates.push('priority = ?');
      params.push(settings.priority);
    }
    if (settings.enabled !== undefined) {
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
    minTradeAlert: number; priority: 'high' | 'medium' | 'low'; enabled: boolean;
    nickname?: string; description?: string;
  } | null> {
    const query = `SELECT min_trade_alert, priority, enabled, nickname, description FROM smart_money_wallets WHERE address = ?`;
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
              usd_profit_7d, usd_profit_30d, winrate_7d, buy_7d, avg_holding_mins, total_profit_percent, sol_balance,
              performance_score, is_active, last_active_at,
              is_family_member, family_addresses, coordination_score, stealth_level,
              early_entry_rate, volume_score,
              enabled, priority, added_by, verified, min_trade_alert,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);

          const normalizedAddedBy = config?.addedBy === 'placeholder' ? 'discovery' : (config?.addedBy || 'manual');
          const safeEnabled = config?.verified !== undefined ? (config.verified ? 1 : 0) : 0;

          stmt.run(
            wallet.address, wallet.category,
            config?.nickname || `${wallet.category.charAt(0).toUpperCase() + wallet.category.slice(1)} ${wallet.address.slice(0, 8)}`,
            config?.description || `Автоматически добавленный ${wallet.category} кошелек`,
            
            // 🔥 НОВЫЕ CSV ПОЛЯ
            wallet.usdProfit7d, wallet.usdProfit30d, wallet.winrate7d, wallet.buy7d,
            wallet.avgHoldingMins, wallet.totalProfitPercent, wallet.solBalance,
            
            // Системные поля
            wallet.performanceScore, wallet.isActive ? 1 : 0, wallet.lastActiveAt.toISOString(),
            
            // Дополнительные поля
            0, null, 0, null, null, null,
            
            // Управление
            1, // enabled
            config?.priority || (wallet.performanceScore > 85 ? 'high' : 'medium'),
            normalizedAddedBy, 
            safeEnabled,
            config?.minTradeAlert || (wallet.category === 'trader' ? 15000 : wallet.category === 'hunter' ? 5000 : 3000),
            
            // Timestamps
            new Date().toISOString(),
            new Date().toISOString()
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
    this.logger.info(`✅ Successfully replaced all wallets with NEW CSV STRUCTURE: ${newWallets.length} new wallets added`);
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
      const enabledRow = this.db.prepare('SELECT COUNT(*) as count FROM smart_money_wallets WHERE enabled = 1').get() as any;

      const recentRows = this.db.prepare(`SELECT address FROM smart_money_wallets ORDER BY created_at DESC, address DESC LIMIT 5`).all() as any[];
      const oldestRows = this.db.prepare(`SELECT address FROM smart_money_wallets ORDER BY created_at ASC, address ASC LIMIT 5`).all() as any[];

      return {
        totalWallets: totalRow.count, activeWallets: activeRow.count, enabledWallets: enabledRow.count,
        recentAddresses: recentRows.map(row => row.address), oldestAddresses: oldestRows.map(row => row.address)
      };
    } catch (error) {
      this.logger.error('❌ Error getting diagnostic info:', error);
      throw error;
    }
  }

  // 🔥 ПОЛНОСТЬЮ ПЕРЕПИСАН mapRowToWallet ПОД НОВУЮ СТРУКТУРУ
  private mapRowToWallet(row: any): SmartMoneyWallet {
    return {
      address: row.address,
      category: row.category,
      nickname: row.nickname,
      
      // 🔥 НОВЫЕ CSV ПОЛЯ
      usdProfit7d: row.usd_profit_7d || 0,
      usdProfit30d: row.usd_profit_30d || 0,
      winrate7d: row.winrate_7d || 0,
      buy7d: row.buy_7d || 0,
      avgHoldingMins: row.avg_holding_mins || 0,
      totalProfitPercent: row.total_profit_percent || 0,
      solBalance: row.sol_balance || 0,
      
      // Системные поля
      performanceScore: row.performance_score || 50,
      isActive: !!row.is_active,
      lastActiveAt: new Date(row.last_active_at),
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

  // 🔥 ИСПРАВЛЕНО: используем новые поля в saveSmartMoneyTransaction
  async saveSmartMoneyTransaction(swapInfo: any): Promise<void> {
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO smart_money_transactions (
          transaction_id, wallet_address, token_address, token_symbol, token_name,
          amount, amount_usd, swap_type, timestamp, dex,
          wallet_category, is_family_member, family_id,
          wallet_usd_profit_7d, wallet_winrate_7d, wallet_buy_7d
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        swapInfo.transactionId, swapInfo.walletAddress, swapInfo.tokenAddress,
        swapInfo.tokenSymbol, swapInfo.tokenName, swapInfo.tokenAmount, swapInfo.amountUSD,
        swapInfo.swapType, swapInfo.timestamp.toISOString(), swapInfo.dex || 'Smart-Money',
        swapInfo.category, 0, null, 
        // 🔥 НОВЫЕ ПОЛЯ ВМЕСТО СТАРЫХ
        swapInfo.usdProfit7d, swapInfo.winrate7d, swapInfo.buy7d
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

  // 🔥 ПОЛНОСТЬЮ ИСПРАВЛЕНО: Сигнатура и тело метода под новую CSV структуру
  async updateWalletPerformance(address: string, metrics: {
    winrate7d: number; usdProfit7d: number; buy7d: number; lastActiveAt: Date; performanceScore?: number;
  }): Promise<void> {
    this.db.prepare(`
      UPDATE smart_money_wallets 
      SET winrate_7d = ?, usd_profit_7d = ?, buy_7d = ?, last_active_at = ?, 
          performance_score = COALESCE(?, performance_score), updated_at = datetime('now')
      WHERE address = ?
    `).run(
      metrics.winrate7d, metrics.usdProfit7d, metrics.buy7d,
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