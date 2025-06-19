// src/main.ts - КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Profit-First пороги + все функции сохранены
import * as dotenv from 'dotenv';
import { TelegramNotifier } from './services/TelegramNotifier';
import { Database } from './services/Database';
import { SmartMoneyDatabase } from './services/SmartMoneyDatabase';
import { SmartMoneyFlowAnalyzer } from './services/SmartMoneyFlowAnalyzer';
import { TokenMetadataService } from './services/TokenMetadataService'; // 🆕 ДОБАВЛЕНО
import { WebhookServer } from './services/WebhookServer';
import { QuickNodeWebhookManager } from './services/QuickNodeWebhookManager';
import { DragonResultsParser } from './services/DragonResultsParser'; // 🆕 DRAGON INTEGRATION
import { LargeTransactionMonitor } from './services/LargeTransactionMonitor'; // 🚨 MODULE B - LARGE TX MONITOR
import { MultiProviderService } from './services/MultiProviderService'; // 🆕 MULTI-PROVIDER FOR MODULE B
import { Logger } from './utils/Logger';
import { SmartWalletLoader } from './services/SmartWalletLoader';
import * as path from 'path';
import * as fs from 'fs';

dotenv.config();

class SmartMoneyBotRunner {
  private database: Database;
  private smDatabase: SmartMoneyDatabase;
  private telegramNotifier: TelegramNotifier;
  private tokenMetadataService: TokenMetadataService; // 🆕 ДОБАВЛЕНО
  private flowAnalyzer: SmartMoneyFlowAnalyzer;
  private webhookServer: WebhookServer;
  private webhookManager: QuickNodeWebhookManager;
  private smartWalletLoader: SmartWalletLoader;
  private dragonParser: DragonResultsParser; // 🆕 DRAGON PARSER
  private largeTransactionMonitor: LargeTransactionMonitor; // 🚨 MODULE B - LARGE TX MONITOR
  private multiProviderService: MultiProviderService; // 🆕 MULTI-PROVIDER SERVICE
  
  private logger: Logger;
  
  private isRunning: boolean = false;
  private webhookId: string | null = null;
  private intervalIds: NodeJS.Timeout[] = [];

  constructor() {
    this.logger = Logger.getInstance();
    
    this.validateEnvironment();

    this.database = new Database();
    this.smDatabase = new SmartMoneyDatabase();
    
    this.telegramNotifier = new TelegramNotifier(
      process.env.TELEGRAM_BOT_TOKEN!,
      process.env.TELEGRAM_USER_ID!
    );

    // 🆕 ДОБАВЛЕНО: Создаем TokenMetadataService
    this.tokenMetadataService = new TokenMetadataService();

    this.smartWalletLoader = new SmartWalletLoader(this.smDatabase, this.telegramNotifier);
    
    // ✅ ИСПРАВЛЕНО: Добавлен TokenMetadataService в конструктор (4-й аргумент)
    this.flowAnalyzer = new SmartMoneyFlowAnalyzer(
      this.smDatabase, 
      this.telegramNotifier, 
      this.database,
      this.tokenMetadataService // 🆕 ДОБАВЛЕНО
    );
    
    this.webhookServer = new WebhookServer(
      this.database, 
      this.telegramNotifier, 
      null, // SolanaMonitor убрали
      this.smDatabase
    );
    
    this.webhookManager = new QuickNodeWebhookManager();

    // 🔧 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: PROFIT-FIRST пороги вместо старых значений!
    this.dragonParser = new DragonResultsParser(
      this.smDatabase, 
      this.telegramNotifier,
      {
        // ✅ НОВЫЕ PROFIT-FIRST ЗНАЧЕНИЯ (исправлено!)
        minPnl: 50000,        // $50K (было $10K) ← ИСПРАВЛЕНО!
        minWinrate: 35,       // 35% (было 65%) ← ИСПРАВЛЕНО!
        minTrades: 10,        // 10 (было 15) ← ИСПРАВЛЕНО!
        maxDaysInactive: 7    // максимум 7 дней неактивности
      }
    );

    // 🚨 MODULE B: MULTI-PROVIDER SERVICE INITIALIZATION
    this.multiProviderService = new MultiProviderService();

    // 🔥 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Добавлен SmartMoneyDatabase в конструктор (4-й аргумент)
    this.largeTransactionMonitor = new LargeTransactionMonitor(
      this.telegramNotifier,
      this.multiProviderService,
      this.tokenMetadataService,
      this.smDatabase // 🔥 ДОБАВЛЕНО: SmartMoneyDatabase для проверки наших гениев
    );

    this.logger.info('✅ Smart Money Bot services initialized (PROFIT-FIRST + TokenMetadataService)');
    this.logger.info('💰 Dragon thresholds: PnL≥$50K, WR≥35%, Trades≥10'); // 🆕 ЛОГИРУЕМ НОВЫЕ ПОРОГИ
  }

  private validateEnvironment(): void {
    const requiredVars = [
      'QUICKNODE_HTTP_URL',
      'QUICKNODE_API_KEY', 
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_USER_ID'
    ];

    const missingVars = requiredVars.filter(varName => !process.env[varName]);
    
    if (missingVars.length > 0) {
      this.logger.error(`❌ Missing required environment variables: ${missingVars.join(', ')}`);
      process.exit(1);
    }

    this.logger.info('✅ Environment variables validated (QuickNode + Alchemy only)');
  }

  private formatNumber(num: number): string {
    if (num >= 1_000_000) {
      return `${(num / 1_000_000).toFixed(1)}M`;
    } else if (num >= 1_000) {
      return `${(num / 1_000).toFixed(1)}K`;
    } else {
      return num.toFixed(0);
    }
  }

  private async createDefaultConfig(): Promise<void> {
    try {
      const configPath = './config/smart_wallets.json';
      const configDir = path.dirname(configPath);

      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      if (!fs.existsSync(configPath)) {
        const defaultConfig = {
          smart_wallets: [],
          last_updated: new Date().toISOString(),
          version: "1.0.0",
          description: "Smart Money wallets will be automatically populated by Dragon integration"
        };

        fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
        this.logger.info(`✅ Created default config file: ${configPath}`);
      }

      this.logger.info('📁 Config ready for Smart Money intelligent wallets');

    } catch (error) {
      this.logger.error('❌ Error creating config file:', error);
      // Не бросаем ошибку дальше, чтобы не сломать запуск
    }
  }

  // 🆕 МЕТОДЫ ДЛЯ ОБРАБОТКИ TELEGRAM КОМАНД
  private setupTelegramCommands(): void {
    this.telegramNotifier.setupCommandHandlers({
      '/stats': this.handleStatsCommand.bind(this),
      '/wallets': this.handleWalletsCommand.bind(this),
      '/dragon': this.handleDragonCommand.bind(this),
      '/flows': this.handleFlowsCommand.bind(this),
      '/holdings': this.handleHoldingsCommand.bind(this), // 🆕 HOLDINGS COMMAND
      '/large': this.handleLargeTransactionsCommand.bind(this), // 🚨 MODULE B COMMAND
      '/help': this.handleHelpCommand.bind(this)
    });

    this.logger.info('🤖 Telegram commands setup completed (including /holdings + /large)');
  }

  private async handleStatsCommand(): Promise<void> {
    try {
      this.logger.info('📊 Processing /stats command');
      
      const [walletStats, dbStats, pollingStats, loaderStats] = await Promise.all([
        this.smDatabase.getWalletStats(), // ✅ ИСПРАВЛЕНО: правильный метод
        this.database.getDatabaseStats(),
        this.webhookManager.getPollingStats(),
        this.smartWalletLoader.getStats()
      ]);

      const notificationStats = this.telegramNotifier.getNotificationStats();

      await this.telegramNotifier.sendStatsResponse({
        walletStats,
        dbStats,
        pollingStats,
        aggregationStats: { activePositions: 0, stats: null }, // Заглушка для упрощенной версии
        loaderStats,
        notificationStats,
        webhookMode: this.webhookId === 'polling-mode' ? 'polling' : 'webhook',
        uptime: process.uptime()
      });

    } catch (error) {
      this.logger.error('Error processing /stats command:', error);
      await this.telegramNotifier.sendCommandError('stats', error);
    }
  }

  private async handleWalletsCommand(): Promise<void> {
    try {
      this.logger.info('👥 Processing /wallets command');
      
      const activeWallets = await this.smDatabase.getAllActiveSmartWallets();
      const walletStats = await this.smDatabase.getWalletStats(); // ✅ ИСПРАВЛЕНО: правильный метод

      await this.telegramNotifier.sendWalletsResponse({
        wallets: activeWallets.slice(0, 15), // Показываем топ 15
        stats: walletStats,
        totalCount: activeWallets.length
      });

    } catch (error) {
      this.logger.error('Error processing /wallets command:', error);
      await this.telegramNotifier.sendCommandError('wallets', error);
    }
  }

  // 🆕 DRAGON COMMAND
  private async handleDragonCommand(): Promise<void> {
    try {
      this.logger.info('🐲 Processing /dragon command');
      
      await this.telegramNotifier.sendCycleLog('🐲 <b>Processing Dragon results (PROFIT-FIRST)...</b>\n\nUsing thresholds: PnL≥$50K, WR≥35%, Trades≥10\nThis may take 1-2 minutes.');
      
      const result = await this.dragonParser.parseLatestDragonResults();
      
      await this.telegramNotifier.sendCycleLog(
        `🐲 <b>Dragon Import Complete!</b>\n\n` +
        `📊 <b>Results:</b>\n` +
        `• Parsed: <code>${result.totalParsed}</code>\n` +
        `• Added: <code>${result.added}</code>\n` +
        `• Updated: <code>${result.updated}</code>\n` +
        `• Filtered: <code>${result.filtered}</code>\n\n` +
        `📈 <b>Categories:</b>\n` +
        `• 🔫 Snipers: <code>${result.categories.snipers}</code>\n` +
        `• 💡 Hunters: <code>${result.categories.hunters}</code>\n` +
        `• 🐳 Traders: <code>${result.categories.traders}</code>\n\n` +
        `💰 <b>Profit Distribution:</b>\n` +
        `• 🐋 Mega-Whales ($1M+): <code>${result.profitDistribution.megaWhales}</code>\n` +
        `• 🐳 Whales ($500K+): <code>${result.profitDistribution.whales}</code>\n` +
        `• 💎 Big Players ($200K+): <code>${result.profitDistribution.bigPlayers}</code>\n` +
        `• ⭐ Quality ($100K+): <code>${result.profitDistribution.quality}</code>\n\n` +
        `🚀 <b>Auto-loaded:</b> <code>${result.added > 0 ? 'Yes' : 'No'}</code>\n\n` +
        `⏰ <code>${new Date().toLocaleString()}</code>`
      );

    } catch (error) {
      this.logger.error('Error processing /dragon command:', error);
      await this.telegramNotifier.sendCommandError('dragon', error);
    }
  }

  // 🆕 FLOWS COMMAND 
  private async handleFlowsCommand(): Promise<void> {
    try {
      this.logger.info('📈 Processing /flows command');
      
      await this.telegramNotifier.sendCycleLog('📈 <b>Analyzing Smart Money flows...</b>\n\nThis may take 30-60 seconds.');
      
      const flowResult = await this.flowAnalyzer.analyzeSmartMoneyFlows();
      
      // Отправляем краткую сводку
      await this.telegramNotifier.sendCycleLog(
        `📈 <b>Smart Money Flow Analysis</b>\n\n` +
        `💚 <b>Top Inflows (1h):</b>\n` +
        flowResult.inflows.filter(f => f.period === '1h').slice(0, 5).map((flow, i) => 
          `<code>${i + 1}.</code> <code>#${flow.tokenSymbol}</code> - ${this.formatNumber(flow.totalInflowUSD)} (${flow.uniqueWallets} wallets)`
        ).join('\n') +
        `\n\n🔴 <b>Top Outflows (1h):</b>\n` +
        flowResult.outflows.filter(f => f.period === '1h').slice(0, 5).map((flow, i) => 
          `<code>${i + 1}.</code> <code>#${flow.tokenSymbol}</code> - ${this.formatNumber(flow.totalOutflowUSD)} (${flow.uniqueWallets} wallets)`
        ).join('\n') +
        `\n\n🔥 <b>Hot New Tokens:</b> <code>${flowResult.hotNewTokens.length}</code>\n\n` +
        `⏰ <code>${new Date().toLocaleString()}</code>`
      );
      
      // Отправляем детальные уведомления если есть данные
      if (flowResult.inflows.length > 0) {
        const hourlyInflows = flowResult.inflows.filter(f => f.period === '1h');
        if (hourlyInflows.length > 0) {
          // Конвертируем SmartMoneyFlow в формат для sendInflowOutflowSummary
          const inflowsFormatted = hourlyInflows.map(flow => ({
            tokenSymbol: flow.tokenSymbol,
            amount: flow.totalInflowUSD,
            walletCount: flow.uniqueWallets
          }));
          await this.telegramNotifier.sendInflowOutflowSummary('inflow', '1h', inflowsFormatted);
        }
      }
      
      if (flowResult.outflows.length > 0) {
        const hourlyOutflows = flowResult.outflows.filter(f => f.period === '1h');
        if (hourlyOutflows.length > 0) {
          // Конвертируем SmartMoneyFlow в формат для sendInflowOutflowSummary
          const outflowsFormatted = hourlyOutflows.map(flow => ({
            tokenSymbol: flow.tokenSymbol,
            amount: flow.totalOutflowUSD,
            walletCount: flow.uniqueWallets
          }));
          await this.telegramNotifier.sendInflowOutflowSummary('outflow', '1h', outflowsFormatted);
        }
      }

    } catch (error) {
      this.logger.error('Error processing /flows command:', error);
      await this.telegramNotifier.sendCommandError('flows', error);
    }
  }

  // 🆕 HOLDINGS COMMAND - НОВАЯ КОМАНДА
  private async handleHoldingsCommand(): Promise<void> {
    try {
      this.logger.info('📊 Processing /holdings command');
      
      await this.telegramNotifier.sendCycleLog('📊 <b>Analyzing Smart Money holdings...</b>\n\nThis may take 45-90 seconds.');
      
      const holdingsReport = await this.flowAnalyzer.analyzeSmartMoneyHoldings();
      
      // Отправляем полный отчет
      await this.flowAnalyzer.sendHoldingsReport(holdingsReport);

    } catch (error) {
      this.logger.error('Error processing /holdings command:', error);
      await this.telegramNotifier.sendCommandError('holdings', error);
    }
  }

  // 🚨 MODULE B: LARGE TRANSACTIONS COMMAND - НОВАЯ КОМАНДА
  private async handleLargeTransactionsCommand(): Promise<void> {
    try {
      this.logger.info('🚨 Processing /large command');
      
      await this.telegramNotifier.sendCycleLog('🚨 <b>Analyzing Large Transactions ($2M+)...</b>\n\nGetting latest statistics...');
      
      const largeStats = this.largeTransactionMonitor.getStats();
      const multiProviderStats = this.multiProviderService.getProviderStats();
      const multiProviderMetrics = this.multiProviderService.getMetrics();
      
      await this.telegramNotifier.sendCycleLog(
        `🚨 <b>Large Transaction Monitor Stats</b>\n\n` +
        `📊 <b>Monitoring Status:</b>\n` +
        `• Total Scanned: <code>${largeStats.totalScanned}</code>\n` +
        `• Large TXs Found: <code>${largeStats.largeTransactionsFound}</code>\n` +
        `• Filtered Out: <code>${largeStats.filtered}</code>\n` +
        `• Alerts Sent: <code>${largeStats.alertsSent}</code>\n\n` +
        `🔧 <b>Multi-Provider Status:</b>\n` +
        `• Total Providers: <code>${multiProviderMetrics.totalProviders}</code>\n` +
        `• Healthy: <code>${multiProviderMetrics.healthyProviders}</code>\n` +
        `• Primary: <code>${multiProviderMetrics.primaryProvider}</code>\n` +
        `• Total Requests: <code>${multiProviderMetrics.totalRequests}</code>\n` +
        `• Success Rate: <code>${((multiProviderMetrics.successfulRequests / Math.max(multiProviderMetrics.totalRequests, 1)) * 100).toFixed(1)}%</code>\n` +
        `• Avg Response: <code>${multiProviderMetrics.avgResponseTime.toFixed(0)}ms</code>\n\n` +
        `💾 <b>Cache Performance:</b>\n` +
        `• Cache Hits: <code>${multiProviderMetrics.cacheHits}</code>\n` +
        `• Hit Rate: <code>${multiProviderMetrics.cacheHitRate.toFixed(1)}%</code>\n` +
        `• Cache Size: <code>${multiProviderMetrics.cacheSize}</code>\n\n` +
        `⚡ <b>Provider Details:</b>\n` +
        multiProviderStats.slice(0, 3).map(provider => 
          `• <code>${provider.name}</code>: ${provider.isHealthy ? '✅' : '❌'} ` +
          `(${provider.successRate.toFixed(1)}% success, ${provider.avgResponseTime.toFixed(0)}ms)`
        ).join('\n') +
        `\n\n⚠️ <b>Threshold:</b> <code>$2,000,000+ USD</code>\n` +
        `🛡️ <b>Filtering:</b> Scams, Token Owners, Exchange Internals\n\n` +
        `⏰ <code>${new Date().toLocaleString()}</code>`
      );

    } catch (error) {
      this.logger.error('Error processing /large command:', error);
      await this.telegramNotifier.sendCommandError('large', error);
    }
  }

  private async handleHelpCommand(): Promise<void> {
    try {
      this.logger.info('❓ Processing /help command');
      
      await this.telegramNotifier.sendCycleLog(
        `❓ <b>Smart Money Bot Commands</b>\n\n` +
        `📊 <b>/stats</b> - Bot statistics and status\n` +
        `👥 <b>/wallets</b> - Active Smart Money wallets\n` +
        `🐲 <b>/dragon</b> - Process Dragon results (PROFIT-FIRST)\n` +
        `📈 <b>/flows</b> - Analyze current flows (1h/24h)\n` +
        `📊 <b>/holdings</b> - Portfolio holdings analysis\n` +
        `🚨 <b>/large</b> - Large transaction monitor stats\n` +
        `❓ <b>/help</b> - This help message\n\n` +
        `🤖 <b>Bot Features:</b>\n` +
        `• Real-time DEX monitoring\n` +
        `• PROFIT-FIRST Smart Money (PnL≥$50K)\n` +
        `• Dragon wallet integration\n` +
        `• Hot token detection\n` +
        `• Inflows/Outflows tracking\n` +
        `• Portfolio holdings analysis\n` +
        `• Large transaction alerts ($2M+)\n` +
        `• Multi-provider API failover\n` +
        `• Advanced scam filtering\n\n` +
        `📡 <b>Data Sources:</b> QuickNode + Alchemy + Jupiter + Birdeye\n` +
        `🏷️ <b>Token Metadata:</b> Enhanced with prices & symbols\n` +
        `🚫 <b>NOT USING:</b> Helius API (removed)\n\n` +
        `⏰ <code>${new Date().toLocaleString()}</code>`
      );

    } catch (error) {
      this.logger.error('Error processing /help command:', error);
      await this.telegramNotifier.sendCommandError('help', error);
    }
  }

  async start(): Promise<void> {
    try {
      this.logger.info('🚀 Starting Smart Money Bot (PROFIT-FIRST + TokenMetadataService)...');

      await this.database.init();
      await this.smDatabase.init();
      this.logger.info('✅ Databases initialized');

      const loadedWallets = await this.smartWalletLoader.loadWalletsFromConfig();
      this.logger.info(`📁 Loaded ${loadedWallets} Smart Money wallets from config`);

      this.isRunning = true;

      this.setupTelegramCommands();

      await this.webhookServer.start();
      this.logger.info('✅ Webhook server started (NO HELIUS endpoints)');

      this.webhookManager.setDependencies(this.smDatabase, this.telegramNotifier);

      await this.setupQuickNodeWebhook();

      // 🚨 MODULE B: START LARGE TRANSACTION MONITORING
      await this.largeTransactionMonitor.startMonitoring();
      this.logger.info('🚨 Large Transaction Monitor started ($2M+ threshold)');

      await this.sendStartupNotification();

      this.startPeriodicAnalysis();
      this.startDragonProcessing(); // 🆕 DRAGON PROCESSING

      this.logger.info('✅ Smart Money Bot started successfully (PROFIT-FIRST + TokenMetadataService)!');

    } catch (error) {
      this.logger.error('❌ Error starting Smart Money Bot:', error);
      throw error;
    }
  }

  // ✅ ИСПРАВЛЕНО: Правильная передача аргументов в startPollingMode
  private async setupQuickNodeWebhook(): Promise<void> {
    try {
      let webhookURL: string;
      
      if (process.env.NODE_ENV === 'production' || process.env.PORT) {
        // ✅ ИСПРАВЛЕНО: теперь используем /webhook/solana вместо /webhook/helius
        webhookURL = `${this.detectRenderURL()}/webhook/solana`;
      } else {
        webhookURL = process.env.WEBHOOK_URL || 'http://localhost:3000/webhook/solana';
      }

      this.logger.info(`🔗 Setting up QuickNode monitoring with webhook: ${webhookURL}`);

      // Пробуем создать webhook
      try {
        this.webhookId = await this.webhookManager.createSmartMoneyWebhook(webhookURL);
        this.logger.info('🎯 Smart Money webhook created successfully (NO HELIUS)');
        this.logger.info(`📡 Webhook URL: ${webhookURL}`);
        this.logger.info(`🆔 Stream ID: ${this.webhookId}`);
      } catch (webhookError) {
        this.logger.warn('⚠️ Webhook creation failed, switching to polling mode:', webhookError);
        
        // ✅ ИСПРАВЛЕНО: Получаем Smart Money кошельки перед вызовом startPollingMode
        const smartWallets = await this.smDatabase.getAllActiveSmartWallets();
        this.webhookId = await this.webhookManager.startPollingMode(smartWallets); // Передаем аргумент
        
        this.logger.info('🔄 Polling mode started for Smart Money monitoring');
        this.logger.info(`🎯 Monitoring ${smartWallets.length} Smart Money wallets`);
      }
      
    } catch (error) {
      this.logger.error('❌ Failed to setup QuickNode webhook/polling:', error);
      throw error;
    }
  }

  private async sendStartupNotification(): Promise<void> {
    try {
      const mode = this.webhookId === 'polling-mode' ? 'Polling (1 min)' : 'Real-time Webhooks';
      const stats = await this.smDatabase.getWalletStats(); // ✅ ИСПРАВЛЕНО: теперь метод существует в SmartMoneyDatabase
      const multiProviderMetrics = this.multiProviderService.getMetrics();
      
      await this.telegramNotifier.sendCycleLog(
        `🚀 <b>Smart Money Bot Started!</b>\n\n` +
        `🔄 <b>Mode:</b> <code>${mode}</code>\n` +
        `👥 <b>Smart Wallets:</b> <code>${stats.total}</code>\n` +
        `  • 🔫 Snipers: <code>${stats.byCategory?.sniper || 0}</code>\n` +
        `  • 💡 Hunters: <code>${stats.byCategory?.hunter || 0}</code>\n` +
        `  • 🐳 Traders: <code>${stats.byCategory?.trader || 0}</code>\n\n` +
        `💰 <b>PROFIT-FIRST Thresholds:</b>\n` +
        `  • Min PnL: <code>$50,000</code>\n` +
        `  • Min WR: <code>35%</code>\n` +
        `  • Min Trades: <code>10</code>\n\n` +
        `🚨 <b>Large TX Monitor:</b> <code>Active ($2M+)</code>\n` +
        `🔧 <b>Providers:</b> <code>${multiProviderMetrics.healthyProviders}/${multiProviderMetrics.totalProviders} healthy</code>\n` +
        `🏷️ <b>Token Metadata:</b> <code>Enhanced (Jupiter + Birdeye)</code>\n\n` +
        `🔥 <b>Features:</b>\n` +
        `• Flow Analysis (1h/24h)\n` +
        `• Hot New Tokens\n` +
        `• Portfolio Holdings\n` +
        `• Dragon Integration (PROFIT-FIRST)\n` +
        `• Large TX Alerts ($2M+)\n` +
        `• Multi-Provider Failover\n` +
        `• Advanced Scam Filtering\n` +
        `• Enhanced Token Data\n\n` +
        `📡 <b>APIs:</b> QuickNode + Alchemy + Jupiter + Birdeye\n` +
        `🚫 <b>NO HELIUS:</b> Removed for stability\n\n` +
        `⏰ <code>${new Date().toLocaleString()}</code>`
      );

    } catch (error) {
      this.logger.error('Error sending startup notification:', error);
    }
  }

  private startPeriodicAnalysis(): void {
    // Flow analysis каждые 4 часа
    const flowAnalysisInterval = setInterval(async () => {
      try {
        this.logger.info('🔄 Starting periodic flow analysis...');
        const result = await this.flowAnalyzer.analyzeSmartMoneyFlows();
        await this.flowAnalyzer.sendFlowAnalysisNotifications(result);
      } catch (error) {
        this.logger.error('❌ Error in periodic flow analysis:', error);
      }
    }, 4 * 60 * 60 * 1000); // 4 hours

    this.intervalIds.push(flowAnalysisInterval);

    // Holdings analysis каждые 12 часов
    const holdingsAnalysisInterval = setInterval(async () => {
      try {
        this.logger.info('🔄 Starting periodic holdings analysis...');
        const report = await this.flowAnalyzer.analyzeSmartMoneyHoldings();
        // Отправляем только краткую сводку для периодического анализа
        await this.telegramNotifier.sendCycleLog(
          `📊 <b>Holdings Update</b>\n\n` +
          `🏷️ Tokens: <code>${report.totalTokens}</code>\n` +
          `💰 Total Value: <code>$${this.formatNumber(report.totalValueUSD)}</code>\n` +
          `🥇 Top Token: <code>#${report.summary.topTokenByValue}</code>\n\n` +
          `⏰ <code>${new Date().toLocaleString()}</code>`
        );
      } catch (error) {
        this.logger.error('❌ Error in periodic holdings analysis:', error);
      }
    }, 12 * 60 * 60 * 1000); // 12 hours

    this.intervalIds.push(holdingsAnalysisInterval);

    // 🚨 MODULE B: Large Transaction Summary каждые 6 часов
    const largeTxSummaryInterval = setInterval(async () => {
      try {
        this.logger.info('🔄 Starting periodic large transaction summary...');
        const largeStats = this.largeTransactionMonitor.getStats();
        
        if (largeStats.largeTransactionsFound > 0) {
          await this.telegramNotifier.sendCycleLog(
            `🚨 <b>Large TX Summary (6h)</b>\n\n` +
            `💰 <b>Found:</b> <code>${largeStats.largeTransactionsFound}</code> transactions $2M+\n` +
            `✅ <b>Alerts:</b> <code>${largeStats.alertsSent}</code> passed filters\n` +
            `🚫 <b>Filtered:</b> <code>${largeStats.filtered}</code> scam/owner/exchange\n` +
            `📊 <b>Total Scanned:</b> <code>${largeStats.totalScanned}</code>\n\n` +
            `⏰ <code>${new Date().toLocaleString()}</code>`
          );
        }
      } catch (error) {
        this.logger.error('❌ Error in periodic large transaction summary:', error);
      }
    }, 6 * 60 * 60 * 1000); // 6 hours

    this.intervalIds.push(largeTxSummaryInterval);

    this.logger.info('🔄 Periodic analysis started: Flow (4h), Holdings (12h), Large TX Summary (6h)');
  }

  private startDragonProcessing(): void {
    // Dragon processing каждые 6 часов
    const dragonInterval = setInterval(async () => {
      try {
        this.logger.info('🐲 Starting automatic Dragon processing (PROFIT-FIRST)...');
        const result = await this.dragonParser.parseLatestDragonResults();
        
        if (result.added > 0 || result.updated > 0) {
          await this.telegramNotifier.sendCycleLog(
            `🐲 <b>Auto Dragon Import (PROFIT-FIRST)</b>\n\n` +
            `➕ Added: <code>${result.added}</code>\n` +
            `🔄 Updated: <code>${result.updated}</code>\n` +
            `📊 Total Parsed: <code>${result.totalParsed}</code>\n` +
            `💰 Avg PnL: <code>$${this.formatNumber(result.averagePnL)}</code>\n\n` +
            `⏰ <code>${new Date().toLocaleString()}</code>`
          );
        }
      } catch (error) {
        this.logger.error('❌ Error in automatic Dragon processing:', error);
      }
    }, 6 * 60 * 60 * 1000); // 6 hours

    this.intervalIds.push(dragonInterval);

    this.logger.info('🐲 Dragon auto-processing started (PROFIT-FIRST, every 6 hours)');
  }

  private detectRenderURL(): string {
    try {
      // Проверяем стандартные переменные Render
      if (process.env.RENDER_EXTERNAL_URL) {
        this.logger.info(`🔗 Found RENDER_EXTERNAL_URL: ${process.env.RENDER_EXTERNAL_URL}`);
        return process.env.RENDER_EXTERNAL_URL;
      }

      // Пытаемся определить по git remote origin
      if (process.env.GIT_REMOTE_ORIGIN_URL) {
        const repoMatch = process.env.GIT_REMOTE_ORIGIN_URL.match(/github\.com[:/](.+?)\/(.+?)(\.git)?$/);
        if (repoMatch) {
          const repoName = repoMatch[2].replace('.git', '');
          const renderUrl = `https://${repoName}.onrender.com`;
          this.logger.info(`🔗 Guessed from git repo: ${renderUrl}`);
          return renderUrl;
        }
      }
    } catch (error) {
      this.logger.warn('⚠️ Error detecting render URL:', error);
    }

    const renderVars = [
      'RENDER_EXTERNAL_URL',
      'RENDER_SERVICE_URL', 
      'RENDER_APP_URL',
      'RENDER_EXTERNAL_HOSTNAME'
    ];

    for (const varName of renderVars) {
      if (process.env[varName]) {
        const url = process.env[varName].startsWith('http') 
          ? process.env[varName] 
          : `https://${process.env[varName]}`;
        this.logger.info(`🔗 Found in ${varName}: ${url}`);
        return url;
      }
    }

    const fallbackUrl = 'https://smart-money-tracker.onrender.com';
    this.logger.warn(`⚠️ Could not detect Render URL, using fallback: ${fallbackUrl}`);
    this.logger.info('💡 Available env vars:', Object.keys(process.env).filter(k => k.includes('RENDER')));
    
    return fallbackUrl;
  }

  async stop(): Promise<void> {
    try {
      this.logger.info('🛑 Stopping Smart Money Bot...');

      this.isRunning = false;

      // Очищаем все интервалы
      for (const intervalId of this.intervalIds) {
        clearInterval(intervalId);
      }
      this.intervalIds = [];

      // Останавливаем webhook
      if (this.webhookId && this.webhookId !== 'polling-mode') {
        await this.webhookManager.deleteStream(this.webhookId);
      }

      // 🚨 MODULE B: STOP LARGE TRANSACTION MONITORING
      await this.largeTransactionMonitor.stopMonitoring();
      this.logger.info('🚨 Large Transaction Monitor stopped');

      // 🚨 MODULE B: SHUTDOWN MULTI-PROVIDER SERVICE
      await this.multiProviderService.shutdown();
      this.logger.info('🔧 Multi-Provider Service shutdown completed');

      // Останавливаем сервисы
      await this.webhookServer.stop();
      
      await this.telegramNotifier.sendCycleLog(
        `🛑 <b>Smart Money Bot Stopped</b>\n\n` +
        `🚨 Large TX Monitor: <code>Stopped</code>\n` +
        `🔧 Multi-Provider: <code>Shutdown</code>\n` +
        `🏷️ Token Metadata: <code>Disconnected</code>\n` +
        `📊 All Services: <code>Gracefully Stopped</code>\n` +
        `🚫 APIs Used: <code>QuickNode + Alchemy + Jupiter + Birdeye (NO HELIUS)</code>\n\n` +
        `⏰ <code>${new Date().toLocaleString()}</code>`
      );

      this.logger.info('✅ Smart Money Bot stopped successfully (PROFIT-FIRST + TokenMetadataService)');

    } catch (error) {
      this.logger.error('❌ Error stopping Smart Money Bot:', error);
      throw error;
    }
  }
}

// Graceful shutdown handling
process.on('SIGINT', async () => {
  console.log('\n🛑 Received SIGINT, shutting down gracefully...');
  if (global.botInstance) {
    await global.botInstance.stop();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
  if (global.botInstance) {
    await global.botInstance.stop();
  }
  process.exit(0);
});

// Запуск бота
async function main() {
  try {
    const bot = new SmartMoneyBotRunner();
    global.botInstance = bot;
    await bot.start();
  } catch (error) {
    console.error('❌ Fatal error starting Smart Money Bot:', error);
    process.exit(1);
  }
}

// Добавляем глобальный тип для botInstance
declare global {
  var botInstance: SmartMoneyBotRunner | undefined;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('❌ Unhandled error in main:', error);
    process.exit(1);
  });
}

export { SmartMoneyBotRunner };