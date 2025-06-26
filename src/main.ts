// src/main.ts - 🔥 МИНИМИЗИРОВАННЫЕ STARTUP СООБЩЕНИЯ
import * as dotenv from 'dotenv';
import { TelegramNotifier } from './services/TelegramNotifier';
import { Database } from './services/Database';
import { SmartMoneyDatabase } from './services/SmartMoneyDatabase';
import { SmartMoneyFlowAnalyzer } from './services/SmartMoneyFlowAnalyzer';
import { TokenMetadataService } from './services/TokenMetadataService';
import { WebhookServer } from './services/WebhookServer';
import { QuickNodeWebhookManager } from './services/QuickNodeWebhookManager';
import { DragonResultsParser } from './services/DragonResultsParser';
import { DragonActivityChecker } from './services/DragonActivityChecker';
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
  private flowAnalyzer: SmartMoneyFlowAnalyzer;
  private webhookServer: WebhookServer;
  private webhookManager: QuickNodeWebhookManager;
  private smartWalletLoader: SmartWalletLoader;
  private dragonParser: DragonResultsParser;
  private dragonActivityChecker: DragonActivityChecker;
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
    
    this.flowAnalyzer = new SmartMoneyFlowAnalyzer(this.smDatabase, this.telegramNotifier, this.database, this.tokenMetadataService);
    this.webhookServer = new WebhookServer(this.database, this.telegramNotifier, null, this.smDatabase);
    this.webhookManager = new QuickNodeWebhookManager();

    this.multiProviderService = new MultiProviderService();
    this.dragonParser = new DragonResultsParser(
      this.smDatabase, 
      this.telegramNotifier, 
      this.multiProviderService,
      {
      minPnl: 150000,        // $150K
      minWinrate: 35,       // 58%
      minTrades: 25,       // 100
      maxDaysInactive: 14
    });

    
    this.largeTransactionMonitor = new LargeTransactionMonitor(
      this.telegramNotifier, this.multiProviderService, this.tokenMetadataService, this.smDatabase
    );

    this.dragonActivityChecker = new DragonActivityChecker(
      this.smDatabase, 
      this.multiProviderService, 
      this.telegramNotifier,
      {
        enabled: true,
        maxDaysInactive: 7,
        batchSize: 5,
        delayBetweenBatches: 10000,
        recheckIntervalHours: 24
      }
    );

    this.logger.info('✅ Services initialized with CORRECT swap logic');
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
      '/dragon_activity': this.handleDragonActivityCommand.bind(this),
      '/flows': this.handleFlowsCommand.bind(this),
      '/holdings': this.handleHoldingsCommand.bind(this),
      '/large': this.handleLargeTransactionsCommand.bind(this),
      '/dedup': this.handleDeduplicationCommand.bind(this),
      '/help': this.handleHelpCommand.bind(this)
    });
  }

  private async handleStatsCommand(): Promise<void> {
    try {
      const [walletStats, dbStats, pollingStats] = await Promise.all([
        this.smDatabase.getWalletStats(),
        this.database.getDatabaseStats(),
        this.webhookManager.getPollingStats()
      ]);

      await this.telegramNotifier.sendStatsResponse({
        walletStats, dbStats, pollingStats,
        aggregationStats: { activePositions: 0, stats: null },
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
      await this.telegramNotifier.sendCycleLog('🐲 <b>Processing Dragon results...</b>');
      
      const result = await this.dragonParser.parseLatestDragonResults(false);
      
      await this.telegramNotifier.sendCycleLog(
        `🐲 <b>Dragon Import Complete!</b>\n\n` +
        `📊 Added: <code>${result.added}</code> | Updated: <code>${result.updated}</code> | Skipped: <code>${result.skipped}</code>\n` +
        `📈 Categories: 🔫${result.categories.snipers} 💡${result.categories.hunters} 🐳${result.categories.traders}\n` +
        `💰 Profit Distribution: 🐋${result.profitDistribution.megaWhales} 🐳${result.profitDistribution.whales} 💎${result.profitDistribution.bigPlayers}\n` +
        `💵 Avg PnL: <code>$${this.formatNumber(result.averagePnL)}</code>\n` +
        `⏰ <code>${new Date().toLocaleString()}</code>`
      );
    } catch (error) {
      await this.telegramNotifier.sendCommandError('dragon', error);
    }
  }

  private async handleDragonReplaceCommand(): Promise<void> {
    try {
      this.logger.info('🔥 Processing /dragon_replace - FORCE REPLACEMENT');
      
      await this.telegramNotifier.sendCycleLog(
        `🔥 <b>FORCE Dragon Database Replacement</b>\n\n` +
        `⚠️ <b>WARNING:</b> Deleting ALL existing Dragon wallets!\n` +
        `🔄 Processing new Dragon files...\n\n` +
        `This may take 2-3 minutes.`
      );
      
      const result = await this.dragonParser.parseLatestDragonResults(true);
      
      await this.telegramNotifier.sendCycleLog(
        `🔥 <b>Dragon Database REPLACED!</b>\n\n` +
        `🗑️ <b>Cleared Old:</b> <code>${result.cleared}</code>\n` +
        `➕ <b>Added New:</b> <code>${result.added}</code>\n` +
        `📊 <b>Total Processed:</b> <code>${result.totalParsed}</code>\n` +
        `🚫 <b>Filtered Out:</b> <code>${result.filtered}</code>\n\n` +
        `💰 <b>Profit Distribution:</b>\n` +
        `• 🐋 Mega-Whales: <code>${result.profitDistribution.megaWhales}</code>\n` +
        `• 🐳 Whales: <code>${result.profitDistribution.whales}</code>\n` +
        `• 💎 Big Players: <code>${result.profitDistribution.bigPlayers}</code>\n` +
        `• ⭐ Quality: <code>${result.profitDistribution.quality}</code>\n\n` +
        `📈 <b>Categories:</b> 🔫${result.categories.snipers} 💡${result.categories.hunters} 🐳${result.categories.traders}\n` +
        `💵 <b>Avg PnL:</b> <code>$${this.formatNumber(result.averagePnL)}</code>\n` +
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
        `🐲 <b>Dragon:</b> <code>${stats.dragon}</code>\n` +
        `🔍 <b>Discovery:</b> <code>${stats.discovery}</code>\n` +
        (stats.other > 0 ? `❓ <b>Other:</b> <code>${stats.other}</code>\n` : '') +
        `\n📈 <b>Total Active:</b> <code>${stats.total}</code>\n\n` +
        `⏰ <code>${new Date().toLocaleString()}</code>`
      );

    } catch (error) {
      this.logger.error('Error in /dragon_stats:', error);
      await this.telegramNotifier.sendCommandError('dragon_stats', error);
    }
  }

  private async handleDragonActivityCommand(): Promise<void> {
    try {
      this.logger.info('🧹 Processing /dragon_activity - ACTIVITY CHECK');
      
      await this.telegramNotifier.sendCycleLog(
        `🧹 <b>Dragon Activity Check Started</b>\n\n` +
        `🔍 Checking Dragon wallets for real activity...\n` +
        `⚠️ Inactive wallets (>7 days) will be deactivated\n\n` +
        `This may take 2-5 minutes.`
      );
      
      const result = await this.dragonActivityChecker.checkDragonWalletsActivity();
      
      await this.telegramNotifier.sendCycleLog(
        `🧹 <b>Dragon Activity Check Complete!</b>\n\n` +
        `✅ <b>Checked:</b> <code>${result.checked}</code> wallets\n` +
        `🚫 <b>Deactivated:</b> <code>${result.deactivated}</code> inactive\n` +
        (result.errors > 0 ? `❌ <b>Errors:</b> <code>${result.errors}</code>\n` : '') +
        `\n📊 <b>Details:</b>\n` +
        `${result.details.slice(0, 10).map(d => `<code>${d}</code>`).join('\n')}\n` +
        (result.details.length > 10 ? `<i>...and ${result.details.length - 10} more</i>\n` : '') +
        `\n⏰ <code>${new Date().toLocaleString()}</code>`
      );

    } catch (error) {
      this.logger.error('Error in /dragon_activity:', error);
      await this.telegramNotifier.sendCommandError('dragon_activity', error);
    }
  }

  private async handleFlowsCommand(): Promise<void> {
    try {
      await this.telegramNotifier.sendCycleLog('📈 <b>Analyzing flows...</b>');
      const result = await this.flowAnalyzer.analyzeSmartMoneyFlows();
      
      await this.telegramNotifier.sendCycleLog(
        `📈 <b>Flow Analysis</b>\n\n` +
        `💚 Top Inflows: ${result.inflows.filter(f => f.period === '1h').slice(0, 3).map(f => 
          `#${f.tokenSymbol}($${this.formatNumber(f.totalInflowUSD)})`).join(', ')}\n` +
        `🔴 Top Outflows: ${result.outflows.filter(f => f.period === '1h').slice(0, 3).map(f => 
          `#${f.tokenSymbol}($${this.formatNumber(f.totalOutflowUSD)})`).join(', ')}\n` +
        `🔥 Hot Tokens: <code>${result.hotNewTokens.length}</code>`
      );
    } catch (error) {
      await this.telegramNotifier.sendCommandError('flows', error);
    }
  }

  private async handleHoldingsCommand(): Promise<void> {
    try {
      await this.telegramNotifier.sendCycleLog('📊 <b>Analyzing holdings...</b>');
      const report = await this.flowAnalyzer.analyzeSmartMoneyHoldings();
      await this.flowAnalyzer.sendHoldingsReport(report);
    } catch (error) {
      await this.telegramNotifier.sendCommandError('holdings', error);
    }
  }

  private async handleLargeTransactionsCommand(): Promise<void> {
    try {
      const stats = this.largeTransactionMonitor.getStats();
      const multiMetrics = this.multiProviderService.getMetrics();
      
      await this.telegramNotifier.sendCycleLog(
        `🚨 <b>Large TX Monitor</b>\n\n` +
        `📊 Scanned: <code>${stats.totalScanned}</code> | Found: <code>${stats.largeTransactionsFound}</code>\n` +
        `✅ Alerts: <code>${stats.alertsSent}</code> | Filtered: <code>${stats.filtered}</code>\n` +
        `🔧 Providers: <code>${multiMetrics.healthyProviders}/${multiMetrics.totalProviders}</code>\n` +
        `💾 Cache Hits: <code>${multiMetrics.cacheHitRate.toFixed(1)}%</code>\n` +
        `⚠️ Threshold: <code>$2M+</code> | Interval: <code>2min</code>\n` +
        `⏰ <code>${new Date().toLocaleString()}</code>`
      );
    } catch (error) {
      await this.telegramNotifier.sendCommandError('large', error);
    }
  }

  private async handleDeduplicationCommand(): Promise<void> {
    try {
      const dedupStats = this.telegramNotifier.getDuplicationStats();
      await this.telegramNotifier.sendCycleLog(
        `🔍 <b>Deduplication Stats</b>\n\n` +
        `📍 Window: <code>${dedupStats.windowMinutes}min</code>\n` +
        `🚫 Filtered: <code>${dedupStats.duplicatesFiltered}</code>\n` +
        `📊 Success Rate: <code>${this.telegramNotifier.getNotificationStats().successRate}</code>`
      );
    } catch (error) {
      await this.telegramNotifier.sendCommandError('dedup', error);
    }
  }

  // ✅ УБРАНА СТРОЧКА "🔥 Features: STRICT Dragon criteria"
  private async handleHelpCommand(): Promise<void> {
    try {
      await this.telegramNotifier.sendCycleLog(
        `❓ <b>Smart Money Bot Commands</b>\n\n` +
        `📊 /stats - Bot statistics\n` +
        `👥 /wallets - Smart Money wallets\n\n` +
        `🐲 <b>Dragon Commands:</b>\n` +
        `• /dragon - Add/Update Dragon wallets\n` +
        `• /dragon_replace - <b>FORCE</b> replace Dragon DB\n` +
        `• /dragon_stats - Wallet source statistics\n` +
        `• /dragon_activity - Check Dragon wallets activity\n\n` +
        `📈 /flows - Flow analysis\n` +
        `📊 /holdings - Holdings analysis\n` +
        `🚨 /large - Large TX monitor\n` +
        `🔍 /dedup - Deduplication stats\n` +
        `❓ /help - This help\n\n` +
        `⏰ <code>${new Date().toLocaleString()}</code>`
      );
    } catch (error) {
      await this.telegramNotifier.sendCommandError('help', error);
    }
  }

  async start(): Promise<void> {
    try {
      this.logger.info('🚀 Starting Optimized Smart Money Bot with CORRECT swap logic...');

      await Promise.all([this.database.init(), this.smDatabase.init()]);
      const smartWallets = await this.smDatabase.getAllActiveSmartWallets();
      
      this.isRunning = true;
      this.setupTelegramCommands();
      
      await this.webhookServer.start();
      this.webhookManager.setDependencies(this.smDatabase, this.telegramNotifier);
      
      await this.setupQuickNodeWebhook();
      await this.largeTransactionMonitor.startMonitoring();
      
      // ✅ МИНИМИЗИРОВАННОЕ STARTUP СООБЩЕНИЕ
      await this.sendStartupNotification();
      
      this.startPeriodicAnalysis();
      this.startDragonProcessing();

      this.logger.info('✅ Optimized Smart Money Bot with CORRECT logic started successfully!');
    } catch (error) {
      this.logger.error('❌ Error starting bot:', error);
      throw error;
    }
  }

  // 🔥 ОПТИМИЗИРОВАННЫЕ ИНТЕРВАЛЫ
  private startPeriodicAnalysis(): void {
    // 💚 Inflows/Outflows каждый час
    const flowInterval = setInterval(async () => {
      try {
        this.logger.info('💚 Hourly Flow Analysis...');
        const result = await this.flowAnalyzer.analyzeSmartMoneyFlows();
        await this.flowAnalyzer.sendFlowAnalysisNotifications(result);
      } catch (error) {
        this.logger.error('❌ Error in flow analysis:', error);
      }
    }, 1 * 60 * 60 * 1000); // 1 ЧАС

    // 🔥 Hot New Tokens каждый час
    const hotTokenInterval = setInterval(async () => {
      try {
        this.logger.info('🔥 Hot Token Analysis...');
        const smartWallets = await this.smDatabase.getAllActiveSmartWallets();
        const hotTokens = await this.flowAnalyzer.findProfitableHotNewTokensBatched(smartWallets);
        
        for (const token of hotTokens.slice(0, 3)) {
          await this.telegramNotifier.sendHotNewTokenAlert(token);
          await this.sleep(2000);
        }
      } catch (error) {
        this.logger.error('❌ Error in hot token analysis:', error);
      }
    }, 1 * 60 * 60 * 1000); // 1 ЧАС

    const holdingsInterval = setInterval(() => this.runHoldingsAnalysis(), 6 * 60 * 60 * 1000);
    const summaryInterval = setInterval(() => this.sendLargeTransactionSummary(), 4 * 60 * 60 * 1000);
    const walletUpdateInterval = setInterval(() => this.updateWalletPerformanceBatch(), 8 * 60 * 60 * 1000);
    const activityCheckInterval = setInterval(() => this.dragonActivityChecker.checkDragonWalletsActivity(), 12 * 60 * 60 * 1000);

    this.intervalIds.push(flowInterval, hotTokenInterval, holdingsInterval, summaryInterval, walletUpdateInterval, activityCheckInterval);
    
    this.logger.info('🔄 CORRECT intervals: 1h flows/1h hot/6h holdings/4h large/8h wallets/12h dragon');
  }

  private async runHoldingsAnalysis(): Promise<void> {
    try {
      const report = await this.flowAnalyzer.analyzeSmartMoneyHoldings();
      await this.telegramNotifier.sendCycleLog(
        `📊 <b>Holdings Update</b>\n\n` +
        `🏷️ Tokens: <code>${report.totalTokens}</code>\n` +
        `💰 Value: <code>$${this.formatNumber(report.totalValueUSD)}</code>\n` +
        `🥇 Top: <code>#${report.summary.topTokenByValue}</code>`
      );
    } catch (error) {
      this.logger.error('❌ Error in holdings analysis:', error);
    }
  }

  private async sendLargeTransactionSummary(): Promise<void> {
    try {
      const stats = this.largeTransactionMonitor.getStats();
      if (stats.largeTransactionsFound > 0) {
        await this.telegramNotifier.sendCycleLog(
          `🚨 <b>Large TX Summary (4h)</b>\n\n` +
          `💰 Found: <code>${stats.largeTransactionsFound}</code> ($2M+)\n` +
          `✅ Alerts: <code>${stats.alertsSent}</code>\n` +
          `🚫 Filtered: <code>${stats.filtered}</code>`
        );
      }
    } catch (error) {
      this.logger.error('❌ Error in large TX summary:', error);
    }
  }

  private async updateWalletPerformanceBatch(): Promise<void> {
    try {
      const activeWallets = await this.smDatabase.getAllActiveSmartWallets();
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

  private startDragonProcessing(): void {
    const dragonInterval = setInterval(async () => {
      try {
        this.logger.info('🐲 Starting automatic Dragon processing (NORMAL mode)...');
        
        const result = await this.dragonParser.parseLatestDragonResults(false);
        
        if (result.added > 0 || result.updated > 0) {
          await this.telegramNotifier.sendCycleLog(
            `🐲 <b>Auto Dragon Import</b>\n\n` +
            `➕ Added: <code>${result.added}</code> | 🔄 Updated: <code>${result.updated}</code>\n` +
            `💰 Avg PnL: <code>$${this.formatNumber(result.averagePnL)}</code>\n` +
            `⏰ <code>${new Date().toLocaleString()}</code>`
          );
        }
      } catch (error) {
        this.logger.error('❌ Error in automatic Dragon processing:', error);
      }
    }, 6 * 60 * 60 * 1000);

    this.intervalIds.push(dragonInterval);
    this.logger.info('🐲 Dragon auto-processing scheduled every 6 hours (NORMAL mode)');
  }

  private async setupQuickNodeWebhook(): Promise<void> {
    try {
      const webhookURL = process.env.NODE_ENV === 'production' 
        ? `${this.detectRenderURL()}/webhook/solana`
        : process.env.WEBHOOK_URL || 'http://localhost:3000/webhook/solana';

      try {
        this.webhookId = await this.webhookManager.createSmartMoneyWebhook(webhookURL);
      } catch {
        const smartWallets = await this.smDatabase.getAllActiveSmartWallets();
        this.webhookId = await this.webhookManager.startPollingMode(smartWallets);
      }
    } catch (error) {
      this.logger.error('❌ Failed to setup webhook/polling:', error);
      throw error;
    }
  }

  // ✅ МИНИМИЗИРОВАННОЕ STARTUP СООБЩЕНИЕ
  private async sendStartupNotification(): Promise<void> {
    try {
      const mode = this.webhookId === 'polling-mode' ? 'Polling (2 min)' : 'Webhooks';
      const stats = await this.smDatabase.getWalletStats();
      
      await this.telegramNotifier.sendCycleLog(
        `🚀 <b>Smart Money Bot Started!</b>\n\n` +
        `🔄 Mode: <code>${mode}</code>\n` +
        `👥 Wallets: <code>${stats.total}</code> | 💰 Tracking: $5K+ \n` +
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

  async stop(): Promise<void> {
    try {
      this.isRunning = false;
      this.intervalIds.forEach(id => clearInterval(id));
      this.intervalIds = [];

      if (this.webhookId && this.webhookId !== 'polling-mode') {
        await this.webhookManager.deleteStream(this.webhookId);
      }

      await Promise.all([
        this.largeTransactionMonitor.stopMonitoring(),
        this.multiProviderService.shutdown(),
        this.webhookServer.stop()
      ]);

      await this.telegramNotifier.sendCycleLog('🛑 <b>Smart Money Bot Stopped</b>');
      this.logger.info('✅ Bot stopped successfully');
    } catch (error) {
      this.logger.error('❌ Error stopping bot:', error);
      throw error;
    }
  }
}

process.on('SIGINT', async () => {
  if (global.botInstance) await global.botInstance.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  if (global.botInstance) await global.botInstance.stop();
  process.exit(0);
});

async function main() {
  try {
    const bot = new SmartMoneyBotRunner();
    global.botInstance = bot;
    await bot.start();
  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  }
}

declare global {
  var botInstance: SmartMoneyBotRunner | undefined;
}

if (require.main === module) {
  main().catch(error => {
    console.error('❌ Unhandled error:', error);
    process.exit(1);
  });
}

export { SmartMoneyBotRunner };