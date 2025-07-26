// src/main.ts - 🔥 ИСПРАВЛЕНА РАССИНХРОНИЗАЦИЯ: Dragon CSV загружается ДО мониторинга
import * as dotenv from 'dotenv';
import { TelegramNotifier } from './services/TelegramNotifier';
import { Database } from './services/Database';
import { SmartMoneyDatabase } from './services/SmartMoneyDatabase';
import { SmartMoneyFlowAnalyzer } from './services/SmartMoneyFlowAnalyzer';
import { TokenMetadataService } from './services/TokenMetadataService';
import { WebhookServer } from './services/WebhookServer';
import { QuickNodeWebhookManager } from './services/QuickNodeWebhookManager';
import { DragonResultsParser } from './services/DragonResultsParser';
import { SolanaMonitor } from './services/SolanaMonitor'; 

import { LargeTransactionMonitor } from './services/LargeTransactionMonitor';
import { MultiProviderService } from './services/MultiProviderService';
import { Logger } from './utils/Logger';
import { SmartWalletLoader } from './services/SmartWalletLoader';
import * as path from 'path';
import * as fs from 'fs';

dotenv.config();

class SmartMoneyBotRunner {
  private database: Database;
  private smDatabase: SmartMoneyDatabase;
  private telegramNotifier: TelegramNotifier;
  private tokenMetadataService: TokenMetadataService;
  private solanaMonitor: SolanaMonitor; // 🔥 ДОБАВЛЕН SolanaMonitor
  private flowAnalyzer: SmartMoneyFlowAnalyzer;
  private webhookServer: WebhookServer;
  private webhookManager: QuickNodeWebhookManager;
  private smartWalletLoader: SmartWalletLoader;
  private dragonParser: DragonResultsParser;
  private largeTransactionMonitor: LargeTransactionMonitor;
  private multiProviderService: MultiProviderService;
  private logger: Logger;
  private isRunning: boolean = false;
  private webhookId: string | null = null;
  private intervalIds: NodeJS.Timeout[] = [];

  constructor() {
    this.logger = Logger.getInstance();
    this.validateEnvironment();

    this.database = new Database();
    this.smDatabase = new SmartMoneyDatabase();
    this.telegramNotifier = new TelegramNotifier(process.env.TELEGRAM_BOT_TOKEN!, process.env.TELEGRAM_USER_ID!);
    this.tokenMetadataService = new TokenMetadataService();
    this.smartWalletLoader = new SmartWalletLoader(this.smDatabase, this.telegramNotifier);
    
    // 🔥🔥🔥 ПРОТОКОЛ "ПОЛНЫЙ КОНТРОЛЬ" - СОЗДАНИЕ И ИНТЕГРАЦИЯ SolanaMonitor 🔥🔥🔥
    this.solanaMonitor = new SolanaMonitor(this.database, this.telegramNotifier);
    
    // 🔥🔥🔥 ПЕРЕДАЧА SolanaMonitor В SmartMoneyFlowAnalyzer 🔥🔥🔥
    this.flowAnalyzer = new SmartMoneyFlowAnalyzer(
      this.smDatabase, 
      this.telegramNotifier, 
      this.database, 
      this.tokenMetadataService,
      this.solanaMonitor // 🔥 КРИТИЧЕСКИ ВАЖНО: передаем SolanaMonitor для интеграции с агрегированными позициями
    );
    
    // 🔥🔥🔥 ПЕРЕДАЧА SolanaMonitor В WebhookServer 🔥🔥🔥
    this.webhookServer = new WebhookServer(this.database, this.telegramNotifier, this.solanaMonitor, this.smDatabase);
    
    // 🔥🔥🔥 ИСПРАВЛЕНИЕ: ПЕРЕДАЧА smDatabase В КОНСТРУКТОР QuickNodeWebhookManager 🔥🔥🔥
    this.webhookManager = new QuickNodeWebhookManager(this.smDatabase, this.telegramNotifier);

    this.multiProviderService = new MultiProviderService();
    
    // 🔥 ОБНОВЛЕННАЯ КОНФИГУРАЦИЯ ДЛЯ BULK WALLET CSV - ТОЛЬКО НОВЫЕ ПОЛЯ!
    this.dragonParser = new DragonResultsParser(
      this.smDatabase, 
      this.telegramNotifier, 
      this.multiProviderService,
      {
        // 🔥 НОВЫЕ КРИТЕРИИ "ВХОДНОГО БИЛЕТА" НА ОСНОВЕ НЕДАВНЕЙ АКТИВНОСТИ
        minProfit7d: 20000,                    // $20K прибыль за 7 дней
        minWinrate7d: 51,                      // 51% винрейт за 7 дней  
        minSolBalance: 30,                     // 30 SOL баланс
        minTotalProfitPercent: 9,              // 9% общая прибыль
        minActivity7d: 1,                      // минимум 1 покупка за 7 дней
        maxDaysInactive: 14
      }
    );

    this.largeTransactionMonitor = new LargeTransactionMonitor(
      this.telegramNotifier, this.multiProviderService, this.tokenMetadataService, this.smDatabase
    );

    this.logger.info('🚀 SmartMoneyBotRunner initialized with 🔥 ПРОТОКОЛ "ПОЛНЫЙ КОНТРОЛЬ"');
    this.logger.info('🔥 ✅ ЕДИНЫЙ РАСЧЕТНЫЙ ЦЕНТР integrated');
    this.logger.info('🔥 ✅ Position Aggregation System integrated');
    this.logger.info('🔥 ✅ SolanaMonitor → SmartMoneyFlowAnalyzer integration active');
    this.logger.info('🔥 ✅ QuickNodeWebhookManager dependencies FIXED');
    this.logger.info('✅ Services initialized with BULK WALLET CSV mode');
  }

  private validateEnvironment(): void {
    const requiredVars = ['QUICKNODE_HTTP_URL', 'QUICKNODE_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_USER_ID'];
    const missingVars = requiredVars.filter(varName => !process.env[varName]);
    if (missingVars.length > 0) {
      this.logger.error(`❌ Missing required environment variables: ${missingVars.join(', ')}`);
      process.exit(1);
    }
  }

  private formatNumber(num: number): string {
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
    if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
    return num.toFixed(0);
  }

  private setupTelegramCommands(): void {
    this.telegramNotifier.setupCommandHandlers({
      '/stats': this.handleStatsCommand.bind(this),
      '/wallets': this.handleWalletsCommand.bind(this),
      '/dragon': this.handleDragonCommand.bind(this),
      '/dragon_replace': this.handleDragonReplaceCommand.bind(this),
      '/dragon_stats': this.handleDragonStatsCommand.bind(this),
      '/flows': this.handleFlowsCommand.bind(this),
      '/holdings': this.handleHoldingsCommand.bind(this),
      '/large': this.handleLargeTransactionsCommand.bind(this),
      '/dedup': this.handleDeduplicationCommand.bind(this),
      '/help': this.handleHelpCommand.bind(this)
    });
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Bot is already running');
      return;
    }

    try {
      this.logger.info('🚀 Starting Smart Money Bot with ПРОТОКОЛ "ПОЛНЫЙ КОНТРОЛЬ"...');

      // Инициализация базы данных
      await this.database.init();
      await this.smDatabase.init();

      // Инициализация провайдеров
      await this.multiProviderService.init();

      // Загрузка кошельков из конфига
      const walletsLoaded = await this.smartWalletLoader.loadWallets();
      this.logger.info(`💼 Loaded ${walletsLoaded} wallets from config`);

      // 🔥🔥🔥 ПРОВЕРКА: УБЕЖДАЕМСЯ ЧТО КОШЕЛЬКИ ЗАГРУЖЕНЫ 🔥🔥🔥
      const existingWallets = await this.smDatabase.getAllActiveSmartWallets();
      this.logger.info(`📊 CRITICAL CHECK: Found ${existingWallets.length} total wallets in database before starting monitoring`);
      
      if (existingWallets.length === 0) {
        this.logger.warn('⚠️ WARNING: No wallets found in database! Monitoring will start with empty list.');
        await this.telegramNotifier.sendCycleLog(
          `⚠️ <b>WARNING: No Wallets Found</b>\n\n` +
          `📊 Database contains: <code>0 wallets</code>\n` +
          `🔄 Monitoring will start with empty list\n` +
          `🐲 Dragon CSV may be empty or not processed yet\n\n` +
          `💡 Try running <code>/dragon</code> command manually`
        );
      } else {
        // Показываем статистику по источникам
        const sourceStats = await this.smDatabase.getWalletsBySource();
        this.logger.info(`📊 Wallet sources: Manual=${sourceStats.manual}, Dragon=${sourceStats.dragon}, Discovery=${sourceStats.discovery}, Other=${sourceStats.other}`);
        
        await this.telegramNotifier.sendCycleLog(
          `✅ <b>Wallets Ready for Monitoring</b>\n\n` +
          `📊 Total: <code>${existingWallets.length}</code>\n` +
          `👤 Manual: <code>${sourceStats.manual}</code>\n` +
          `🐲 Dragon: <code>${sourceStats.dragon}</code>\n` +
          `🔍 Discovery: <code>${sourceStats.discovery}</code>\n` +
          (sourceStats.other > 0 ? `❓ Other: <code>${sourceStats.other}</code>\n` : '') +
          `🚀 Ready to start monitoring!`
        );
      }

      // Запуск веб-сервера
      await this.webhookServer.start();

      // 🔥 TELEGRAM COMMANDS С ПОДДЕРЖКОЙ ПРОТОКОЛА
      this.setupTelegramCommands();

      // 🔥 ИСПРАВЛЕНИЕ: QuickNodeWebhookManager уже имеет все зависимости из конструктора
      // Больше НЕ нужно вызывать setDependencies!

      // 🔥🔥🔥 ТЕПЕРЬ запускаем мониторинг с ПРАВИЛЬНЫМ списком кошельков 🔥🔥🔥
      await this.setupQuickNodeWebhook();

      // Настройка периодических задач с улучшенными интервалами
      this.setupPeriodicTasks();

      // 🔥 ИСПРАВЛЕНИЕ: Запуск Dragon processing как ПЕРИОДИЧЕСКОЙ задачи (не первичной загрузки)
      this.startDragonProcessing();

      // Настройка обработчиков сигналов
      this.setupSignalHandlers();

      this.isRunning = true;
      this.logger.info('✅ Smart Money Bot started successfully with ПРОТОКОЛ "ПОЛНЫЙ КОНТРОЛЬ"');

      // Отправляем уведомление о запуске
      await this.sendStartupNotification();

    } catch (error) {
      this.logger.error('Failed to start Smart Money Bot:', error);
      throw error;
    }
  }

  private setupPeriodicTasks(): void {
    this.logger.info('⏰ Setting up periodic tasks for ПРОТОКОЛ "ПОЛНЫЙ КОНТРОЛЬ"...');

    // 🔥 FLOW ANALYSIS с новой логикой агрегированных позиций (каждые 15 минут)
    const flowAnalysisInterval = setInterval(async () => {
      try {
        this.logger.info('🔍 Starting ПРОТОКОЛ "ПОЛНЫЙ КОНТРОЛЬ" flow analysis...');
        const flowResult = await this.flowAnalyzer.analyzeSmartMoneyFlows();
        await this.flowAnalyzer.sendFlowAnalysisNotifications(flowResult);
        
        // 🔥 СТАТИСТИКА ПРОТОКОЛА
        const aggregationStats = this.solanaMonitor.getAggregationStats();
        if (aggregationStats.activePositions > 0) {
          await this.telegramNotifier.sendCycleLog(
            `📊 <b>ПРОТОКОЛ "ПОЛНЫЙ КОНТРОЛЬ" Status</b>\n\n` +
            `🎯 Active Positions: <code>${aggregationStats.activePositions}</code>\n` +
            `🔥 Detected: <code>${aggregationStats.stats.totalPositionsDetected}</code>\n` +
            `⚠️ High Risk: <code>${aggregationStats.stats.highRiskPositions}</code>\n` +
            `📨 Alerts Sent: <code>${aggregationStats.stats.alertsSent}</code>\n` +
            `🎛️ Filter Efficiency: <code>${aggregationStats.filteringStats.filteringEfficiency}</code>`
          );
        }
      } catch (error) {
        this.logger.error('Error in flow analysis:', error);
      }
    }, 15 * 60 * 1000); // 15 минут
    this.intervalIds.push(flowAnalysisInterval);

    // Holdings analysis (каждые 30 минут)
    const holdingsInterval = setInterval(async () => {
      try {
        const holdingsReport = await this.flowAnalyzer.analyzeSmartMoneyHoldings();
        await this.flowAnalyzer.sendHoldingsReport(holdingsReport);
      } catch (error) {
        this.logger.error('Error in holdings analysis:', error);
      }
    }, 30 * 60 * 1000); // 30 минут
    this.intervalIds.push(holdingsInterval);

    // 🔥 ПРИНУДИТЕЛЬНАЯ ПРОВЕРКА ВСЕХ АКТИВНЫХ ПОЗИЦИЙ (каждый час)
    const positionCheckInterval = setInterval(async () => {
      try {
        const processed = await this.solanaMonitor.forceCheckAllPositions();
        if (processed > 0) {
          this.logger.info(`🔍 Force-checked all positions: ${processed} analyzed`);
        }
      } catch (error) {
        this.logger.error('Error in position force check:', error);
      }
    }, 60 * 60 * 1000); // 1 час
    this.intervalIds.push(positionCheckInterval);

    // Batch wallet updates (каждые 4 часа)
    const walletUpdateInterval = setInterval(async () => {
      try {
        await this.updateWalletsBatch();
      } catch (error) {
        this.logger.error('Error in wallet batch update:', error);
      }
    }, 4 * 60 * 60 * 1000); // 4 часа
    this.intervalIds.push(walletUpdateInterval);

    this.logger.info('✅ Periodic tasks configured for ПРОТОКОЛ "ПОЛНЫЙ КОНТРОЛЬ"');
  }

  private async updateWalletsBatch(): Promise<void> {
    try {
      const activeWallets = await this.smDatabase.getAllActiveSmartWallets();
      this.logger.info(`📊 Starting batch wallet update for ${activeWallets.length} wallets...`);
      
      const BATCH_SIZE = 10;
      for (let i = 0; i < activeWallets.length; i += BATCH_SIZE) {
        const batch = activeWallets.slice(i, i + BATCH_SIZE);
        
        await Promise.allSettled(
          batch.map(wallet => this.flowAnalyzer.updateSingleWalletMetrics(wallet))
        );
        
        await this.sleep(5000);
        this.logger.info(`📊 Updated batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(activeWallets.length/BATCH_SIZE)}`);
      }
    } catch (error) {
      this.logger.error('Error in batch wallet update:', error);
    }
  }

  // 🔥🔥🔥 ИСПРАВЛЕНИЕ: Dragon processing как ПЕРИОДИЧЕСКАЯ задача (не первичная загрузка) 🔥🔥🔥
  private startDragonProcessing(): void {
    this.logger.info('🐲 Setting up PERIODIC Dragon CSV processing (every 6 hours)...');
    
    const dragonInterval = setInterval(async () => {
      try {
        this.logger.info('🐲 Starting periodic Dragon CSV processing...');
        
        const result = await this.dragonParser.parseLatestDragonResults(false);
        
        if (result.added > 0 || result.updated > 0) {
          await this.telegramNotifier.sendCycleLog(
            `🐲 <b>Periodic Dragon CSV Import</b>\n\n` +
            `➕ Added: <code>${result.added}</code> | 🔄 Updated: <code>${result.updated}</code>\n` +
            `💰 Avg PnL: <code>${this.formatNumber(result.averagePnL)}</code>\n` +
            `🔄 <b>Source:</b> Bulk Wallet Checker CSV\n` +
            `⏰ <code>${new Date().toLocaleString()}</code>`
          );
        } else {
          this.logger.info('🐲 Periodic Dragon CSV check: No new wallets to add');
        }
      } catch (error) {
        this.logger.error('❌ Error in periodic Dragon CSV processing:', error);
      }
    }, 6 * 60 * 60 * 1000); // 6 часов

    this.intervalIds.push(dragonInterval);
    this.logger.info('✅ Dragon CSV periodic processing scheduled every 6 hours');
  }

  private async setupQuickNodeWebhook(): Promise<void> {
    try {
      const webhookURL = process.env.NODE_ENV === 'production' 
        ? `${this.detectRenderURL()}/webhook/solana`
        : process.env.WEBHOOK_URL || 'http://localhost:3000/webhook/solana';

      this.logger.info('🎯 Setting up QuickNode webhook/polling with loaded wallets...');

      // 🔥🔥🔥 ИСПРАВЛЕНИЕ: QuickNodeWebhookManager теперь имеет правильный доступ к базе данных 🔥🔥🔥
      // И автоматически получает актуальный список кошельков при fallback к polling
      try {
        this.webhookId = await this.webhookManager.createSmartMoneyWebhook(webhookURL);
        this.logger.info('✅ Webhook setup completed');
      } catch (error) {
        this.logger.warn('⚠️ Webhook creation failed, fallback to polling will use current database state');
        // Fallback к polling будет автоматически работать с правильной базой данных
        const smartWallets = await this.smDatabase.getAllActiveSmartWallets();
        this.logger.info(`📊 Fallback polling will start with ${smartWallets.length} wallets from database`);
        this.webhookId = await this.webhookManager.startPollingMode(smartWallets);
      }
    } catch (error) {
      this.logger.error('❌ Failed to setup webhook/polling:', error);
      throw error;
    }
  }

  private async sendStartupNotification(): Promise<void> {
    try {
      const mode = this.webhookId === 'polling-mode' ? 'Polling' : 'Webhooks';
      const stats = await this.smDatabase.getWalletStats();
      
      await this.telegramNotifier.sendCycleLog(
        `KORSOL & DRAGON\n\n` +
        `📊 Wallets: <code>${stats.total}</code> active\n` +
        `🎯 Mode: <code>${mode}</code>\n` +
        `⚡ System: <code>Online</code>\n` +
        `⏰ <code>${new Date().toLocaleString()}</code>`
      );
    } catch (error) {
      this.logger.error('Error sending startup notification:', error);
    }
  }

  private detectRenderURL(): string {
    if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL;
    
    const renderVars = ['RENDER_SERVICE_URL', 'RENDER_APP_URL', 'RENDER_EXTERNAL_HOSTNAME'];
    for (const varName of renderVars) {
      if (process.env[varName]) {
        return process.env[varName].startsWith('http') ? process.env[varName] : `https://${process.env[varName]}`;
      }
    }
    
    return 'https://smart-money-tracker.onrender.com';
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private setupSignalHandlers(): void {
    const gracefulShutdown = async (signal: string) => {
      this.logger.info(`🛑 Received ${signal}. Shutting down ПРОТОКОЛ "ПОЛНЫЙ КОНТРОЛЬ" gracefully...`);
      await this.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      this.logger.warn('Bot is not running');
      return;
    }

    try {
      this.logger.info('🛑 Stopping Smart Money Bot with ПРОТОКОЛ "ПОЛНЫЙ КОНТРОЛЬ"...');

      // Очищаем интервалы
      this.intervalIds.forEach(id => clearInterval(id));
      this.intervalIds = [];

      // Останавливаем веб-сервер
      await this.webhookServer.stop();

      // 🔥 ФИНАЛЬНАЯ СТАТИСТИКА ПРОТОКОЛА
      const finalStats = this.solanaMonitor.getAggregationStats();
      await this.telegramNotifier.sendCycleLog(
        `🛑 <b>ПРОТОКОЛ "ПОЛНЫЙ КОНТРОЛЬ" Shutdown</b>\n\n` +
        `📊 Final Statistics:\n` +
        `🎯 Total Positions Detected: <code>${finalStats.stats.totalPositionsDetected}</code>\n` +
        `⚠️ High Risk Positions: <code>${finalStats.stats.highRiskPositions}</code>\n` +
        `📨 Total Alerts Sent: <code>${finalStats.stats.alertsSent}</code>\n` +
        `🎛️ Final Filter Efficiency: <code>${finalStats.filteringStats.filteringEfficiency}</code>\n\n` +
        `✅ ПРОТОКОЛ "ПОЛНЫЙ КОНТРОЛЬ" completed successfully\n` +
        `✅ QuickNode dependencies properly managed\n` +
        `✅ Wallet synchronization fixed`
      );

      // Закрываем соединения с базой данных
      await this.database.close();
      await this.smDatabase.close();

      this.isRunning = false;
      this.logger.info('✅ Smart Money Bot stopped successfully');

    } catch (error) {
      this.logger.error('Error stopping Smart Money Bot:', error);
      throw error;
    }
  }

  private async handleStatsCommand(): Promise<void> {
    try {
      const [walletStats, dbStats, pollingStats] = await Promise.all([
        this.smDatabase.getWalletStats(),
        this.database.getDatabaseStats(),
        this.webhookManager.getPollingStats()
      ]);

      // 🔥 ДОБАВЛЯЕМ СТАТИСТИКУ ПРОТОКОЛА "ПОЛНЫЙ КОНТРОЛЬ"
      const aggregationStats = this.solanaMonitor.getAggregationStats();

      await this.telegramNotifier.sendStatsResponse({
        walletStats, dbStats, pollingStats,
        aggregationStats, // 🔥 НОВАЯ СТАТИСТИКА
        loaderStats: this.smartWalletLoader.getStats(),
        notificationStats: this.telegramNotifier.getNotificationStats(),
        webhookMode: this.webhookId === 'polling-mode' ? 'polling' : 'webhook',
        uptime: process.uptime()
      });
    } catch (error) {
      await this.telegramNotifier.sendCommandError('stats', error);
    }
  }

  private async handleWalletsCommand(): Promise<void> {
    try {
      const activeWallets = await this.smDatabase.getAllActiveSmartWallets();
      const walletStats = await this.smDatabase.getWalletStats();

      await this.telegramNotifier.sendWalletsResponse({
        wallets: activeWallets.slice(0, 15),
        stats: walletStats,
        totalCount: activeWallets.length
      });
    } catch (error) {
      await this.telegramNotifier.sendCommandError('wallets', error);
    }
  }

  private async handleDragonCommand(): Promise<void> {
    try {
      await this.telegramNotifier.sendCycleLog('🐲 <b>Processing Dragon CSV results...</b>');
      
      const result = await this.dragonParser.parseLatestDragonResults(false);
      
      await this.telegramNotifier.sendCycleLog(
        `🐲 <b>Dragon CSV Import Complete!</b>\n\n` +
        `📊 Added: <code>${result.added}</code> | Updated: <code>${result.updated}</code> | Skipped: <code>${result.skipped}</code>\n` +
        `📈 Categories: 🔫${result.categories.snipers} 💡${result.categories.hunters} 🐳${result.categories.traders}\n` +
        `💰 Profit Distribution: 🐋${result.profitDistribution.megaWhales} 🐳${result.profitDistribution.whales} 💎${result.profitDistribution.bigPlayers}\n` +
        `💵 Avg PnL: <code>${this.formatNumber(result.averagePnL)}</code>\n` +
        `🔄 <b>Source:</b> Bulk Wallet Checker CSV\n` +
        `⏰ <code>${new Date().toLocaleString()}</code>`
      );
    } catch (error) {
      await this.telegramNotifier.sendCommandError('dragon', error);
    }
  }

  private async handleDragonReplaceCommand(): Promise<void> {
    try {
      this.logger.info('🔥 Processing /dragon_replace - FORCE REPLACEMENT (MONEY-FIRST MODE)');
      
      await this.telegramNotifier.sendCycleLog(
        `🔥 <b>FORCE Dragon Database Replacement (MONEY-FIRST Mode)</b>\n\n` +
        `⚠️ <b>WARNING:</b> Deleting ALL existing Dragon wallets!\n` +
        `🔄 Processing new Dragon CSV files...\n\n` +
        `💰 <b>NEW MONEY-FIRST LOGIC:</b>\n` +
        `🥇 <b>Priority #1:</b> Growth ≥ 15% + profit ≥ $10K\n` +
        `🥈 <b>Priority #2:</b> Profit7d ≥ $20K + growth ≥ 10%\n` +
        `🥉 <b>Priority #3:</b> Stability (30d > 7d) + growth ≥ 12%\n` +
        `🏅 <b>Priority #4:</b> Whale balance ≥ 150 SOL + growth ≥ 10%\n\n` +
        `🚫 <b>Winrate MOSTLY IGNORED</b> (focus on 💰 not %wins)\n` +
        `📊 <b>Base filters:</b> SOL ≥ 20, Activity ≥ 1, No "?"\n\n` +
        `This may take 2-3 minutes.`
      );
      
      const result = await this.dragonParser.parseLatestDragonResults(true);
      
      await this.telegramNotifier.sendCycleLog(
        `🔥 <b>Dragon Database REPLACED (MONEY-FIRST Mode)</b>\n\n` +
        `🗑️ <b>Cleared Old:</b> <code>${result.cleared}</code>\n` +
        `➕ <b>Added New:</b> <code>${result.added}</code>\n` +
        `📊 <b>Total Processed:</b> <code>${result.totalParsed}</code>\n` +
        `🚫 <b>Filtered Out:</b> <code>${result.filtered}</code>\n\n` +
        `💰 <b>Profit Distribution (7d):</b>\n` +
        `• 🐋 Mega-Whales: <code>${result.profitDistribution.megaWhales}</code>\n` +
        `• 🐳 Whales: <code>${result.profitDistribution.whales}</code>\n` +
        `• 💎 Big Players: <code>${result.profitDistribution.bigPlayers}</code>\n` +
        `• ⭐ Quality: <code>${result.profitDistribution.quality}</code>\n\n` +
        `📈 <b>Categories:</b> 🔫${result.categories.snipers} 💡${result.categories.hunters} 🐳${result.categories.traders}\n` +
        `💵 <b>Avg PnL (7d):</b> <code>${this.formatNumber(result.averagePnL)}</code>\n` +
        `🔄 <b>Source:</b> Bulk Wallet Checker CSV\n` +
        `⏰ <code>${new Date().toLocaleString()}</code>`
      );

    } catch (error) {
      this.logger.error('Error in /dragon_replace:', error);
      await this.telegramNotifier.sendCommandError('dragon_replace', error);
    }
  }

  private async handleDragonStatsCommand(): Promise<void> {
    try {
      const stats = await this.smDatabase.getWalletsBySource();
      
      await this.telegramNotifier.sendCycleLog(
        `📊 <b>Wallet Database Statistics</b>\n\n` +
        `👤 <b>Manual:</b> <code>${stats.manual}</code>\n` +
        `🐲 <b>Dragon (CSV):</b> <code>${stats.dragon}</code>\n` +
        `🔍 <b>Discovery:</b> <code>${stats.discovery}</code>\n` +
        (stats.other > 0 ? `❓ <b>Other:</b> <code>${stats.other}</code>\n` : '') +
        `📊 <b>Total Active:</b> <code>${stats.manual + stats.dragon + stats.discovery + stats.other}</code>`
      );
    } catch (error) {
      await this.telegramNotifier.sendCommandError('dragon_stats', error);
    }
  }

  private async handleFlowsCommand(): Promise<void> {
    try {
      await this.telegramNotifier.sendCycleLog('🔍 <b>Analyzing Smart Money Flows with ПРОТОКОЛ "ПОЛНЫЙ КОНТРОЛЬ"...</b>');
      
      const flowResult = await this.flowAnalyzer.analyzeSmartMoneyFlows();
      await this.flowAnalyzer.sendFlowAnalysisNotifications(flowResult);
      
      // 🔥 СТАТИСТИКА ПРОТОКОЛА
      const aggregationStats = this.solanaMonitor.getAggregationStats();
      await this.telegramNotifier.sendCycleLog(
        `✅ <b>Flow Analysis Complete (ПРОТОКОЛ "ПОЛНЫЙ КОНТРОЛЬ")</b>\n\n` +
        `📊 Inflows: <code>${flowResult.inflows.length}</code>\n` +
        `📉 Outflows: <code>${flowResult.outflows.length}</code>\n` +
        `🔥 Hot Tokens: <code>${flowResult.hotNewTokens.length}</code>\n\n` +
        `🎯 Active Positions: <code>${aggregationStats.activePositions}</code>\n` +
        `🔍 Total Detected: <code>${aggregationStats.stats.totalPositionsDetected}</code>\n` +
        `⚠️ High Risk: <code>${aggregationStats.stats.highRiskPositions}</code>\n` +
        `🎛️ Filter Efficiency: <code>${aggregationStats.filteringStats.filteringEfficiency}</code>`
      );
    } catch (error) {
      await this.telegramNotifier.sendCommandError('flows', error);
    }
  }

  private async handleHoldingsCommand(): Promise<void> {
    try {
      await this.telegramNotifier.sendCycleLog('📊 <b>Analyzing Smart Money Holdings...</b>');
      
      const holdingsReport = await this.flowAnalyzer.analyzeSmartMoneyHoldings();
      await this.flowAnalyzer.sendHoldingsReport(holdingsReport);
    } catch (error) {
      await this.telegramNotifier.sendCommandError('holdings', error);
    }
  }

  private async handleLargeTransactionsCommand(): Promise<void> {
    try {
      // 🔥 ИСПРАВЛЕНО: Используем getStats() для получения статуса мониторинга
      const stats = this.largeTransactionMonitor.getStats();
      
      // Переключаем состояние мониторинга
      if (stats.totalScanned > 0) {
        // Если есть статистика сканирования, значит мониторинг был запущен - останавливаем
        await this.largeTransactionMonitor.stopMonitoring();
        await this.telegramNotifier.sendCycleLog(
          `💰 <b>Large Transaction Monitoring DISABLED</b>\n\n` +
          `Status: <code>DISABLED</code>\n` +
          `Threshold: <code>$2,000,000+</code>`
        );
      } else {
        // Иначе запускаем
        await this.largeTransactionMonitor.startMonitoring();
        await this.telegramNotifier.sendCycleLog(
          `💰 <b>Large Transaction Monitoring ENABLED</b>\n\n` +
          `Status: <code>ENABLED</code>\n` +
          `Threshold: <code>$2,000,000+</code>`
        );
      }
    } catch (error) {
      await this.telegramNotifier.sendCommandError('large', error);
    }
  }

  private async handleDeduplicationCommand(): Promise<void> {
    try {
      // 🔥 ИСПРАВЛЕНО: Используем правильные поля из статистики
      const notificationStats = this.telegramNotifier.getNotificationStats();
      const duplicationStats = this.telegramNotifier.getDuplicationStats();
      
      await this.telegramNotifier.sendCycleLog(
        `🧹 <b>Duplication Prevention Statistics</b>\n\n` +
        `📊 <b>Notification Stats:</b>\n` +
        `✅ Total Sent: <code>${notificationStats.totalSent}</code>\n` +
        `🚫 Duplicates Filtered: <code>${duplicationStats.duplicatesFiltered}</code>\n` +
        `📈 Smart Money Swaps: <code>${notificationStats.smartMoneySwaps}</code>\n` +
        `🔥 Hot Token Alerts: <code>${notificationStats.hotTokenAlerts}</code>\n` +
        `📊 Position Splitting: <code>${notificationStats.positionSplittingAlerts}</code>\n\n` +
        `🎯 <b>Efficiency:</b> ${notificationStats.totalSent > 0 ? 
          ((notificationStats.totalSent - duplicationStats.duplicatesFiltered) / notificationStats.totalSent * 100).toFixed(1) + '%' : '100%'} unique notifications\n` +
        `⏰ <b>Window:</b> <code>${duplicationStats.windowMinutes}min</code>`
      );
    } catch (error) {
      await this.telegramNotifier.sendCommandError('dedup', error);
    }
  }

  private async handleHelpCommand(): Promise<void> {
  await this.telegramNotifier.sendCycleLog(
    `🤖 <b>Smart Money Bot Commands (ПРОТОКОЛ "ПОЛНЫЙ КОНТРОЛЬ")</b>\n\n` +
    `📊 /stats - System statistics + Protocol status\n` +
    `👥 /wallets - Wallet information\n` +
    `🐲 /dragon - Import Dragon CSV (normal)\n` +
    `🔥 /dragon_replace - Replace all wallets (MONEY-FIRST)\n` +
    `📈 /dragon_stats - Wallet source statistics\n` +
    `🔍 /flows - Analyze flows with Protocol\n` +
    `📊 /holdings - Holdings analysis\n` +
    `💰 /large - Toggle large tx monitoring\n` +
    `🧹 /dedup - Clean database\n` +
    `❓ /help - This help\n\n` 
    );
  }
}

// Запуск бота
async function main() {
  const bot = new SmartMoneyBotRunner();
  
  try {
    await bot.start();
    
    // Держим процесс активным
    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });

  } catch (error) {
    console.error('Failed to start Smart Money Bot:', error);
    process.exit(1);
  }
}

// Запускаем, если файл выполняется напрямую
if (require.main === module) {
  main();
}

export { SmartMoneyBotRunner };
