// src/services/TelegramNotifier.ts - ИСПРАВЛЕННАЯ ВЕРСИЯ с недостающими методами
import TelegramBot from 'node-telegram-bot-api';
import { SmartMoneyFlow, HotNewToken, SmartMoneySwap } from '../types';
import { Logger } from '../utils/Logger';

// 🎯 ИНТЕРФЕЙСЫ для команд
interface StatsData {
  walletStats: any;
  dbStats: any;
  pollingStats: any;
  aggregationStats: any;
  loaderStats: any;
  notificationStats: any;
  webhookMode: 'polling' | 'webhook';
  uptime: number;
}

interface WalletsData {
  wallets: any[];
  stats: any;
  totalCount: number;
}

// 🆕 ИНТЕРФЕЙСЫ для недостающих методов
interface PositionSplittingAlert {
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

interface TokenNameAlert {
  tokenName: string;
  contractAddress: string;
  holders: number;
  similarTokens: number;
}

interface SmartMoneyInflow {
  tokenSymbol: string;
  tokenAddress: string;
  inflowUSD: number;
  walletCount: number;
  topWallets: Array<{
    address: string;
    category: string;
    amountUSD: number;
  }>;
}

export class TelegramNotifier {
  private bot: TelegramBot;
  private userId: string;
  private logger: Logger;
  private commandHandlers: Map<string, () => Promise<void>> = new Map();
  
  // 🚀 RATE LIMITING & QUEUE SYSTEM
  private messageQueue: Array<{ message: string; priority: number; retryCount: number }> = [];
  private isProcessingQueue: boolean = false;
  private lastMessageTime: number = 0;
  private messagesThisSecond: number = 0;
  private secondReset: number = 0;
  
  // Rate limits: Telegram allows 30 messages per second
  private readonly MAX_MESSAGES_PER_SECOND = 25; // Оставляем запас
  private readonly MESSAGE_DELAY = 50; // 50ms между сообщениями
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY = 2000; // 2 seconds
  
  // Статистика
  private stats = {
    totalSent: 0,
    smartMoneySwaps: 0,
    flowsSent: 0,
    dragonImports: 0,
    commandsProcessed: 0,
    errorsSent: 0,
    queuedMessages: 0,
    retryAttempts: 0,
    lastMessageTime: new Date()
  };

  constructor(token: string, userId: string) {
    this.bot = new TelegramBot(token, { polling: true });
    this.userId = userId;
    this.logger = Logger.getInstance();
    this.setupBaseHandlers();
    this.startMessageQueueProcessor(); // 🆕 Запускаем обработчик очереди
  }

  // 🆕 БАЗОВЫЕ ОБРАБОТЧИКИ
  private setupBaseHandlers(): void {
    this.bot.on('message', (msg) => {
      // Только от нужного пользователя
      if (msg.from?.id.toString() !== this.userId) {
        return;
      }

      // Только команды
      if (msg.text && msg.text.startsWith('/')) {
        const command = msg.text.split(' ')[0];
        const handler = this.commandHandlers.get(command);
        
        if (handler) {
          this.stats.commandsProcessed++;
          handler().catch(error => {
            this.logger.error(`Error handling command ${command}:`, error);
            this.sendCommandError(command.substring(1), error);
          });
        } else {
          this.sendCycleLog(`❓ Неизвестная команда: <code>${command}</code>\n\nИспользуйте /help для списка команд.`);
        }
      }
    });

    this.bot.on('polling_error', (error) => {
      this.logger.error('Telegram polling error:', error);
    });

    this.logger.info('🤖 Telegram base handlers setup completed');
  }

  // 🚀 MESSAGE QUEUE SYSTEM для защиты от rate limits
  private startMessageQueueProcessor(): void {
    setInterval(async () => {
      if (!this.isProcessingQueue && this.messageQueue.length > 0) {
        await this.processMessageQueue();
      }
    }, 100); // Проверяем очередь каждые 100ms
  }

  private async processMessageQueue(): Promise<void> {
    if (this.isProcessingQueue || this.messageQueue.length === 0) return;
    
    this.isProcessingQueue = true;
    
    try {
      // Сортируем по приоритету (высший приоритет первым)
      this.messageQueue.sort((a, b) => b.priority - a.priority);
      
      while (this.messageQueue.length > 0) {
        const messageData = this.messageQueue.shift()!;
        
        try {
          await this.sendMessageSafely(messageData.message);
          break; // Успешно отправили, выходим
        } catch (error) {
          messageData.retryCount++;
          
          if (messageData.retryCount < this.MAX_RETRIES) {
            // Возвращаем в очередь для повторной попытки
            this.messageQueue.unshift(messageData);
            this.stats.retryAttempts++;
            await this.sleep(this.RETRY_DELAY);
          } else {
            this.logger.error(`❌ Failed to send message after ${this.MAX_RETRIES} retries:`, error);
            this.stats.errorsSent++;
          }
        }
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  private async sendMessageSafely(message: string): Promise<void> {
    // Rate limiting check
    await this.enforceRateLimit();
    
    // Chunking для длинных сообщений
    const chunks = this.chunkMessage(message);
    
    for (const chunk of chunks) {
      await this.bot.sendMessage(this.userId, chunk, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
      
      this.stats.totalSent++;
      this.stats.lastMessageTime = new Date();
      
      // Пауза между chunks
      if (chunks.length > 1) {
        await this.sleep(200);
      }
    }
  }

  private async enforceRateLimit(): Promise<void> {
    const now = Date.now();
    
    // Сброс счетчика секунды
    if (now > this.secondReset) {
      this.messagesThisSecond = 0;
      this.secondReset = now + 1000;
    }
    
    // Проверяем лимит сообщений в секунду
    if (this.messagesThisSecond >= this.MAX_MESSAGES_PER_SECOND) {
      const waitTime = this.secondReset - now;
      if (waitTime > 0) {
        await this.sleep(waitTime);
        this.messagesThisSecond = 0;
        this.secondReset = Date.now() + 1000;
      }
    }
    
    // Минимальная задержка между сообщениями
    const timeSinceLastMessage = now - this.lastMessageTime;
    if (timeSinceLastMessage < this.MESSAGE_DELAY) {
      await this.sleep(this.MESSAGE_DELAY - timeSinceLastMessage);
    }
    
    this.messagesThisSecond++;
    this.lastMessageTime = Date.now();
  }

  private chunkMessage(message: string, maxLength: number = 4000): string[] {
    if (message.length <= maxLength) {
      return [message];
    }
    
    const chunks: string[] = [];
    let currentChunk = '';
    const lines = message.split('\n');
    
    for (const line of lines) {
      if (currentChunk.length + line.length + 1 > maxLength) {
        if (currentChunk) {
          chunks.push(currentChunk.trim());
          currentChunk = '';
        }
        
        // Если одна строка слишком длинная, разбиваем её
        if (line.length > maxLength) {
          const subChunks = line.match(new RegExp(`.{1,${maxLength}}`, 'g')) || [];
          chunks.push(...subChunks);
        } else {
          currentChunk = line;
        }
      } else {
        currentChunk += (currentChunk ? '\n' : '') + line;
      }
    }
    
    if (currentChunk) {
      chunks.push(currentChunk.trim());
    }
    
    return chunks;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // 🆕 НАСТРОЙКА ОБРАБОТЧИКОВ КОМАНД
  setupCommandHandlers(handlers: Record<string, () => Promise<void>>): void {
    for (const [command, handler] of Object.entries(handlers)) {
      this.commandHandlers.set(command, handler);
    }
    this.logger.info(`🤖 Registered ${Object.keys(handlers).length} command handlers`);
  }

  // ✅ ОСНОВНОЙ МЕТОД ДЛЯ ОТПРАВКИ СООБЩЕНИЙ с Rate Limiting
  async sendCycleLog(message: string, priority: number = 1): Promise<void> {
    try {
      // Добавляем в очередь вместо прямой отправки
      this.messageQueue.push({
        message,
        priority,
        retryCount: 0
      });
      
      this.stats.queuedMessages++;
      
      // Если очередь небольшая и не обрабатывается, запускаем немедленно
      if (this.messageQueue.length <= 3 && !this.isProcessingQueue) {
        await this.processMessageQueue();
      }
      
    } catch (error) {
      this.logger.error('Error queuing message:', error);
      this.stats.errorsSent++;
    }
  }

  // ✅ ОСНОВНЫЕ КОМАНДЫ

  async sendStatsResponse(data: StatsData): Promise<void> {
    try {
      const uptimeHours = Math.floor(data.uptime / 3600);
      const uptimeMinutes = Math.floor((data.uptime % 3600) / 60);
      
      let message = `📊 <b>Smart Money Bot Statistics</b>\n\n`;
      
      message += `🟢 <b>System Status:</b>\n`;
      message += `⏱️ Uptime: <code>${uptimeHours}h ${uptimeMinutes}m</code>\n`;
      message += `🔄 Mode: <code>${data.webhookMode === 'polling' ? 
        'Polling (5min)' : 'Real-time Webhooks'}</code>\n`;
      message += `📡 Monitoring: <code>${data.pollingStats?.monitoredWallets || 0}/20</code> wallets\n\n`;
      
      message += `👥 <b>Smart Money Wallets:</b>\n`;
      message += `🟢 Active: <code>${data.walletStats?.active || 0}</code>\n`;
      message += `✅ Enabled: <code>${data.walletStats?.enabled || 0}</code>\n`;
      message += `🔫 Snipers: <code>${data.walletStats?.byCategory?.sniper || 0}</code>\n`;
      message += `💡 Hunters: <code>${data.walletStats?.byCategory?.hunter || 0}</code>\n`;
      message += `🐳 Traders: <code>${data.walletStats?.byCategory?.trader || 0}</code>\n\n`;
      
      message += `📊 <b>Database:</b>\n`;
      message += `💱 Total Swaps: <code>${data.dbStats?.totalSwaps || 0}</code>\n`;
      message += `🎯 Positions: <code>${data.dbStats?.positionAggregations || 0}</code>\n\n`;
      
      message += `🤖 <b>Notifications:</b>\n`;
      message += `📤 Total Sent: <code>${this.stats.totalSent}</code>\n`;
      message += `🚀 Smart Swaps: <code>${this.stats.smartMoneySwaps}</code>\n`;
      message += `📈 Flow Reports: <code>${this.stats.flowsSent}</code>\n`;
      message += `🐲 Dragon Imports: <code>${this.stats.dragonImports}</code>\n`;
      message += `⚙️ Commands: <code>${this.stats.commandsProcessed}</code>\n`;
      message += `❌ Errors: <code>${this.stats.errorsSent}</code>\n\n`;
      
      message += `<code>#BotStats #SystemStatus</code>`;

      await this.sendCycleLog(message);
      this.logger.info('📊 Stats response sent');

    } catch (error) {
      this.logger.error('Error sending stats response:', error);
      this.stats.errorsSent++;
    }
  }

  async sendWalletsResponse(data: WalletsData): Promise<void> {
    try {
      let message = `👥 <b>Active Smart Money Wallets</b>\n\n`;
      
      message += `📊 <b>Summary:</b>\n`;
      message += `🟢 Active: <code>${data.stats?.active || 0}</code>\n`;
      message += `✅ Enabled: <code>${data.stats?.enabled || 0}</code>\n`;
      message += `👥 Total: <code>${data.totalCount}</code>\n\n`;
      
      message += `🏆 <b>Top Performers (showing ${Math.min(data.wallets.length, 15)}):</b>\n\n`;
      
      data.wallets.slice(0, 15).forEach((wallet, index) => {
        const categoryEmoji = this.getCategoryEmoji(wallet.category || 'unknown');
        const priorityEmoji = wallet.priority === 'high' ? 
          '🔴' : wallet.priority === 'medium' ? '🟡' : '🟢';
        const statusEmoji = wallet.enabled ? '✅' : '⚪';
        
        message += `<code>${(index + 1).toString().padStart(2, '0')}.</code> ${categoryEmoji} <b>${wallet.nickname || 'Unknown'}</b> ${priorityEmoji}${statusEmoji}\n`;
        message += `    <code>${wallet.address}</code>\n`; // 🔧 ПОЛНЫЙ АДРЕС!
        message += `    WR: <code>${(wallet.winRate || 0).toFixed(1)}%</code> | PnL: <code>$${this.formatNumber(wallet.totalPnL || 0)}</code> | Trades: <code>${wallet.totalTrades || 0}</code>\n`;
        message += `    Avg: <code>$${this.formatNumber(wallet.avgTradeSize || 0)}</code> | Score: <code>${wallet.performanceScore || 0}</code>\n\n`;
      });
      
      if (data.wallets.length > 15) {
        message += `<i>... and ${data.wallets.length - 15} more wallets</i>\n\n`;
      }
      
      message += `🔫 <b>Snipers:</b> <code>${data.stats?.byCategory?.sniper || 0}</code> | `;
      message += `💡 <b>Hunters:</b> <code>${data.stats?.byCategory?.hunter || 0}</code> | `;
      message += `🐳 <b>Traders:</b> <code>${data.stats?.byCategory?.trader || 0}</code>\n\n`;
      
      message += `<code>#SmartWallets #ActiveMonitoring</code>`;

      await this.sendCycleLog(message);
      this.logger.info(`👥 Wallets response sent: ${data.wallets.length} wallets`);

    } catch (error) {
      this.logger.error('Error sending wallets response:', error);
      this.stats.errorsSent++;
    }
  }

  async sendHelpResponse(): Promise<void> {
    try {
      let message = `🤖 <b>Smart Money Bot Commands</b>\n\n`;
      
      message += `📊 <b>Main Commands:</b>\n`;
      message += `• <code>/stats</code> - Bot statistics and status\n`;
      message += `• <code>/wallets</code> - Active Smart Money wallets\n`;
      message += `• <code>/dragon</code> - Process Dragon results\n`;
      message += `• <code>/flows</code> - Analyze current flows\n`;
      message += `• <code>/help</code> - This help message\n\n`;
      
      message += `🔥 <b>Key Features:</b>\n`;
      message += `• Real-time Smart Money monitoring\n`;
      message += `• Dragon wallet integration\n`;
      message += `• Flow analysis (Inflows/Outflows)\n`;
      message += `• Hot token detection\n`;
      message += `• Large transaction alerts (2M$+)\n\n`;
      
      message += `🎯 <b>Current Settings:</b>\n`;
      message += `• Min Trade Alert: <code>$10,000+</code>\n`;
      message += `• Large TX Alert: <code>$2,000,000+</code>\n`;
      message += `• Monitoring: <code>Top 20 wallets</code>\n`;
      message += `• Dragon Processing: <code>Every 6 hours</code>\n`;
      message += `• Flow Analysis: <code>Every 4 hours</code>\n\n`;
      
      message += `<code>#Help #BotCommands #SmartMoney</code>`;

      await this.sendCycleLog(message);
      this.logger.info('❓ Help response sent');

    } catch (error) {
      this.logger.error('Error sending help response:', error);
      this.stats.errorsSent++;
    }
  }

  async sendCommandError(command: string, error: any): Promise<void> {
    try {
      let message = `❌ <b>Command Error</b>\n\n`;
      message += `🤖 Command: <code>/${command}</code>\n`;
      message += `⚠️ Error: <code>${error.message || 'Unknown error'}</code>\n\n`;
      message += `💡 Try again in a few seconds, or use /help for available commands.`;

      await this.sendCycleLog(message);
      this.stats.errorsSent++;

    } catch (sendError) {
      this.logger.error('Critical error in sendCommandError:', sendError);
    }
  }

  // ✅ DRAGON INTEGRATION NOTIFICATIONS
  async sendDragonImportNotification(result: {
    totalParsed: number;
    added: number;
    updated: number;
    skipped: number;
    categories: { snipers: number; hunters: number; traders: number };
    topPerformers: any[];
  }): Promise<void> {
    try {
      const message = `🐲 <b>Dragon Import Results</b>

📊 <b>Statistics:</b>
• Parsed: <code>${result.totalParsed}</code> wallets
• Added: <code>${result.added}</code> new
• Updated: <code>${result.updated}</code> existing  
• Skipped: <code>${result.skipped}</code> duplicates

🎯 <b>Categories:</b>
• 🔫 Snipers: <code>${result.categories.snipers}</code>
• 💡 Hunters: <code>${result.categories.hunters}</code>  
• 🐳 Traders: <code>${result.categories.traders}</code>

🏆 <b>Top 5 Performers:</b>
${result.topPerformers.slice(0, 5).map((w, i) => 
  `<code>${i + 1}.</code> $${w.pnl.toFixed(0)} | ${w.winrate}% WR | ${w.trades} trades`
).join('\n')}

⏰ <code>${new Date().toLocaleString()}</code>`;

      await this.sendCycleLog(message);
      this.stats.dragonImports++;
      
    } catch (error) {
      this.logger.error('❌ Error sending Dragon import notification:', error);
    }
  }

  // 🆕 НЕДОСТАЮЩИЕ МЕТОДЫ - ВОССТАНОВЛЕНЫ!

  // 1. sendTopSmartMoneyInflows (для SmartMoneyFlowAnalyzer.ts)
  async sendTopSmartMoneyInflows(inflows: SmartMoneyInflow[]): Promise<void> {
    try {
      let message = `📈 <b>Top Smart Money Inflows</b>\n\n`;
      
      inflows.slice(0, 10).forEach((inflow, index) => {
        message += `<code>${index + 1}.</code> <b>${inflow.tokenSymbol}</b>\n`;
        message += `    💰 Inflow: <code>$${this.formatNumber(inflow.inflowUSD)}</code>\n`;
        message += `    👥 Wallets: <code>${inflow.walletCount}</code>\n`;
        message += `    🔗 <code>${inflow.tokenAddress.slice(0, 8)}...${inflow.tokenAddress.slice(-4)}</code>\n\n`;
      });

      message += `<code>#SmartMoneyInflows #TopFlows</code>`;

      await this.sendCycleLog(message);
      this.stats.flowsSent++;
      
    } catch (error) {
      this.logger.error('Error sending smart money inflows:', error);
      this.stats.errorsSent++;
    }
  }

  // 2. sendPositionSplittingAlert (для SolanaMonitor.ts)
  async sendPositionSplittingAlert(alert: PositionSplittingAlert): Promise<void> {
    try {
      let message = `🚨 <b>Position Splitting Detected!</b>\n\n`;
      
      message += `🎯 <b>Token:</b> <code>${alert.tokenSymbol}</code>\n`;
      message += `💰 <b>Total Position:</b> <code>$${this.formatNumber(alert.totalUSD)}</code>\n`;
      message += `📦 <b>Split into:</b> <code>${alert.purchaseCount}</code> purchases\n`;
      message += `📊 <b>Avg Size:</b> <code>$${this.formatNumber(alert.avgPurchaseSize)}</code>\n`;
      message += `⏱️ <b>Time Window:</b> <code>${alert.timeWindowMinutes}min</code>\n`;
      message += `🚩 <b>Suspicion Score:</b> <code>${alert.suspicionScore}/100</code>\n\n`;
      
      message += `👤 <b>Wallet:</b>\n`;
      message += `<code>${alert.walletAddress}</code>\n\n`;
      
      message += `🔗 <b>Token:</b>\n`;
      message += `<code>${alert.tokenAddress}</code>\n\n`;
      
      message += `📋 <b>Purchases (last 5):</b>\n`;
      alert.purchases.slice(-5).forEach((purchase, index) => {
        message += `<code>${index + 1}.</code> $${this.formatNumber(purchase.amountUSD)} `;
        message += `${this.formatTransactionAge(purchase.timestamp)}\n`;
      });

      message += `\n<code>#PositionSplitting #SuspiciousActivity</code>`;

      await this.sendCycleLog(message);
      this.logger.info(`🚨 Position splitting alert sent: ${alert.tokenSymbol}`);
      
    } catch (error) {
      this.logger.error('Error sending position splitting alert:', error);
      this.stats.errorsSent++;
    }
  }

  // 3. sendTokenNameAlert (для WebhookServer.ts)
  async sendTokenNameAlert(alert: TokenNameAlert): Promise<void> {
    try {
      let message = `⚠️ <b>Token Name Alert!</b>\n\n`;
      
      message += `🏷️ <b>Token Name:</b> <code>${alert.tokenName}</code>\n`;
      message += `👥 <b>Holders:</b> <code>${alert.holders}</code>\n`;
      message += `🔄 <b>Similar Tokens:</b> <code>${alert.similarTokens}</code>\n\n`;
      
      message += `🔗 <b>Contract:</b>\n`;
      message += `<code>${alert.contractAddress}</code>\n\n`;
      
      message += `⚠️ <b>Warning:</b> Multiple tokens with similar names detected!\n`;
      message += `This could indicate a potential scam or copycat token.\n\n`;
      
      message += `<code>#TokenNameAlert #ScamPrevention</code>`;

      await this.sendCycleLog(message);
      this.logger.info(`⚠️ Token name alert sent: ${alert.tokenName}`);
      
    } catch (error) {
      this.logger.error('Error sending token name alert:', error);
      this.stats.errorsSent++;
    }
  }

  // ✅ ДОПОЛНИТЕЛЬНЫЕ МЕТОДЫ ДЛЯ FLOWS

  async sendInflowOutflowSummary(type: 'inflow' | 'outflow', period: string, flows: any[]): Promise<void> {
    try {
      const emoji = type === 'inflow' ? '📈' : '📉';
      const title = type === 'inflow' ? 'Smart Money Inflows' : 'Smart Money Outflows';
      
      let message = `${emoji} <b>${title} (${period})</b>\n\n`;
      
      flows.slice(0, 8).forEach((flow, index) => {
        message += `<code>${index + 1}.</code> <b>${flow.tokenSymbol || 'Unknown'}</b>\n`;
        message += `    ${emoji} Amount: <code>$${this.formatNumber(flow.amount || 0)}</code>\n`;
        message += `    👥 Wallets: <code>${flow.walletCount || 0}</code>\n\n`;
      });

      message += `<code>#${type}s #SmartMoney</code>`;

      await this.sendCycleLog(message);
      this.stats.flowsSent++;
      
    } catch (error) {
      this.logger.error(`Error sending ${type} summary:`, error);
      this.stats.errorsSent++;
    }
  }

  async sendHotNewTokenAlert(token: HotNewToken): Promise<void> {
    try {
      let message = `🔥 <b>Hot New Token Alert!</b>\n\n`;
      
      message += `🏷️ <b>Token:</b> <code>${token.symbol || 'Unknown'}</code>\n`;
      message += `💰 <b>Buy Volume:</b> <code>${this.formatNumber(token.buyVolumeUSD || 0)}</code>\n`;
      message += `💸 <b>Sell Volume:</b> <code>${this.formatNumber(token.sellVolumeUSD || 0)}</code>\n`;
      message += `👥 <b>Smart Money:</b> <code>${token.uniqueSmWallets || 0}</code> wallets\n`;
      message += `📊 <b>FDV:</b> <code>${this.formatNumber(token.fdv || 0)}</code>\n`;
      message += `🕒 <b>Age:</b> <code>${token.ageHours || 0}h</code>\n\n`;
      
      message += `🔗 <b>Token Address:</b>\n`;
      message += `<code>${token.address}</code>\n\n`;
      
      message += `<code>#HotToken #NewListing</code>`;

      await this.sendCycleLog(message);
      this.logger.info(`🔥 Hot token alert sent: ${token.symbol}`);
      
    } catch (error) {
      this.logger.error('Error sending hot token alert:', error);
      this.stats.errorsSent++;
    }
  }

  async sendSmartMoneySwapAlert(swap: SmartMoneySwap): Promise<void> {
    try {
      const actionEmoji = swap.swapType === 'buy' ? '🟢' : '🔴';
      const action = swap.swapType === 'buy' ? 'BUY' : 'SELL';
      
      let message = `${actionEmoji} <b>Smart Money ${action}</b>\n\n`;
      
      message += `🎯 <b>Token:</b> <code>${swap.tokenSymbol || 'Unknown'}</code>\n`;
      message += `💰 <b>Amount:</b> <code>${this.formatNumber(swap.amountUSD)}</code>\n`;
      message += `👤 <b>Category:</b> <code>${swap.category}</code>\n`;
      message += `🕒 <b>Age:</b> <code>${this.formatTransactionAge(swap.timestamp)}</code>\n\n`;
      
      message += `👤 <b>Wallet:</b>\n`;
      message += `<code>${swap.walletAddress}</code>\n\n`;
      
      message += `🔗 <b>Token:</b>\n`;
      message += `<code>${swap.tokenAddress}</code>\n\n`;
      
      message += `<code>#SmartMoneySwap #${action}</code>`;

      await this.sendCycleLog(message);
      this.stats.smartMoneySwaps++;
      
    } catch (error) {
      this.logger.error('Error sending smart money swap alert:', error);
      this.stats.errorsSent++;
    }
  }

  // ✅ UTILITY METHODS
  private getCategoryEmoji(category: string): string {
    switch (category) {
      case 'sniper': return '🔫';
      case 'hunter': return '💡';
      case 'trader': return '🐳';
      default: return '💡';
    }
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

  private formatTokenAmount(amount: number): string {
    if (amount >= 1_000_000_000) {
      return `${(amount / 1_000_000_000).toFixed(2)}B`;
    } else if (amount >= 1_000_000) {
      return `${(amount / 1_000_000).toFixed(2)}M`;
    } else if (amount >= 1_000) {
      return `${(amount / 1_000).toFixed(2)}K`;
    } else {
      return amount.toFixed(2);
    }
  }

  private truncateAddress(address: string): string {
    return `${address.slice(0, 4)}...${address.slice(-4)}`;
  }

  private formatTransactionAge(timestamp: Date): string {
    const ageMs = Date.now() - timestamp.getTime();
    const ageMinutes = Math.floor(ageMs / (1000 * 60));
    
    if (ageMinutes < 1) {
      return 'Just now';
    } else if (ageMinutes < 60) {
      return `${ageMinutes}m ago`;
    } else {
      const ageHours = Math.floor(ageMinutes / 60);
      return `${ageHours}h ${ageMinutes % 60}m ago`;
    }
  }

  // ✅ GET STATS с новыми метриками
  getNotificationStats() {
    return {
      ...this.stats,
      queueSize: this.messageQueue.length,
      isProcessingQueue: this.isProcessingQueue,
      messagesThisSecond: this.messagesThisSecond,
      errorRate: this.stats.totalSent > 0 ? (this.stats.errorsSent / this.stats.totalSent * 100).toFixed(2) + '%' : '0%',
      successRate: this.stats.totalSent > 0 ? ((this.stats.totalSent - this.stats.errorsSent) / this.stats.totalSent * 100).toFixed(2) + '%' : '100%'
    };
  }

  // 🆕 Метод для приоритетной отправки (например, для команд)
  async sendPriorityMessage(message: string): Promise<void> {
    await this.sendCycleLog(message, 10); // Высокий приоритет
  }

  // 🆕 Метод для получения статуса очереди
  getQueueStatus(): { size: number; processing: boolean; oldestMessage?: Date } {
    return {
      size: this.messageQueue.length,
      processing: this.isProcessingQueue,
      oldestMessage: this.messageQueue.length > 0 ? new Date() : undefined
    };
  }

  // 🆕 ALIAS for backward compatibility with WebhookServer.ts - ДОБАВЛЕНО ЗДЕСЬ!
  async sendSmartMoneySwap(swap: SmartMoneySwap): Promise<void> {
    return this.sendSmartMoneySwapAlert(swap);
  }
}