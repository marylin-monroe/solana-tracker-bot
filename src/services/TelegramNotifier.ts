// src/services/TelegramNotifier.ts - УПРОЩЕННАЯ ВЕРСИЯ: убрана сложная дедупликация, оставлена простая защита
import TelegramBot from 'node-telegram-bot-api';
import { SmartMoneyFlow, HotNewToken, SmartMoneySwap } from '../types';
import { Logger } from '../utils/Logger';
import { LargeTransaction } from './LargeTransactionMonitor';

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
  sendLargeTransactionAlert(arg0: LargeTransaction): any {
      throw new Error("Method not implemented.");
  }
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
  
  // 🆕 ПРОСТАЯ дедупликация (только основная защита)
  private recentTransactions = new Map<string, number>(); // signature -> timestamp
  private readonly SIMPLE_DUPLICATE_WINDOW = 5 * 60 * 1000; // 5 минут простой защиты
  
  // Rate limits: Telegram allows 30 messages per second
  private readonly MAX_MESSAGES_PER_SECOND = 20; // Больше запаса
  private readonly MESSAGE_DELAY = 75; // 75ms между сообщениями
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
    lastMessageTime: new Date(),
    duplicatesFiltered: 0,
    hotTokenAlerts: 0,
    positionSplittingAlerts: 0,
    tokenNameAlerts: 0,
    inflowsSent: 0
  };

  constructor(token: string, userId: string) {
    this.bot = new TelegramBot(token, { polling: true });
    this.userId = userId;
    this.logger = Logger.getInstance();
    
    this.setupBaseHandlers();
    this.startMessageQueueProcessor();
    this.startSimpleCleanup();
    this.logger.info('📱 TelegramNotifier initialized with SIMPLE deduplication');
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

  // 🆕 ПРОСТАЯ очистка дедупликации
  private startSimpleCleanup(): void {
    setInterval(() => {
      const now = Date.now();
      let cleaned = 0;
      
      for (const [signature, timestamp] of this.recentTransactions) {
        if (now - timestamp > this.SIMPLE_DUPLICATE_WINDOW) {
          this.recentTransactions.delete(signature);
          cleaned++;
        }
      }
      
      if (cleaned > 0) {
        this.logger.debug(`🧹 Simple cleanup: ${cleaned} transactions removed`);
      }
    }, 60 * 1000); // Каждую минуту
  }

  // 🔍 ПРОСТАЯ проверка на дубликаты
  private isSimpleDuplicate(transactionId: string): boolean {
    const now = Date.now();
    const lastTime = this.recentTransactions.get(transactionId);
    
    if (lastTime && (now - lastTime) < this.SIMPLE_DUPLICATE_WINDOW) {
      this.stats.duplicatesFiltered++;
      this.logger.debug(`🚫 Simple duplicate filtered: ${transactionId.slice(0, 8)}...`);
      return true;
    }
    
    // Регистрируем новую транзакцию
    this.recentTransactions.set(transactionId, now);
    return false;
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

  // ✅ ОСНОВНЫЕ КОМАНДЫ (без изменений - они работают правильно)

  async sendStatsResponse(data: StatsData): Promise<void> {
    try {
      const uptimeHours = Math.floor(data.uptime / 3600);
      const uptimeMinutes = Math.floor((data.uptime % 3600) / 60);
      
      let message = `📊 <b>Smart Money Bot Statistics</b>\n\n`;
      
      message += `🟢 <b>System Status:</b>\n`;
      message += `⏱️ Uptime: <code>${uptimeHours}h ${uptimeMinutes}m</code>\n`;
      message += `🔄 Mode: <code>${data.webhookMode === 'polling' ? 
        'Polling (1min)' : 'Real-time Webhooks'}</code>\n`;
      message += `📡 Monitoring: <code>${data.pollingStats?.walletsMonitored || 0}/100</code> wallets\n\n`;
      
      message += `👥 <b>Smart Money Wallets:</b>\n`;
      message += `🟢 Active: <code>${data.walletStats?.active || 0}</code>\n`;
      message += `✅ Enabled: <code>${data.walletStats?.enabled || 0}</code>\n`;
      message += `🔫 Snipers: <code>${data.walletStats?.byCategory?.sniper || 0}</code>\n`;
      message += `💡 Hunters: <code>${data.walletStats?.byCategory?.hunter || 0}</code>\n`;
      message += `🐳 Traders: <code>${data.walletStats?.byCategory?.trader || 0}</code>\n\n`;
      
      message += `📊 <b>Database:</b>\n`;
      message += `💱 Total Swaps: <code>${data.dbStats?.totalSwaps || 0}</code>\n`;
      message += `🎯 Positions: <code>${data.dbStats?.positionAggregations || 0}</code>\n\n`;
      
      message += `🤖 <b>Notifications (SIMPLE DEDUP):</b>\n`;
      message += `📤 Total Sent: <code>${this.stats.totalSent}</code>\n`;
      message += `🚀 Smart Swaps: <code>${this.stats.smartMoneySwaps}</code>\n`;
      message += `📈 Flow Reports: <code>${this.stats.flowsSent}</code>\n`;
      message += `🔥 Hot Tokens: <code>${this.stats.hotTokenAlerts}</code>\n`;
      message += `🐲 Dragon Imports: <code>${this.stats.dragonImports}</code>\n`;
      message += `⚙️ Commands: <code>${this.stats.commandsProcessed}</code>\n`;
      message += `🚫 Duplicates: <code>${this.stats.duplicatesFiltered}</code>\n`;
      message += `❌ Errors: <code>${this.stats.errorsSent}</code>\n\n`;
      
      message += `🔒 <b>Simple Deduplication:</b>\n`;
      message += `👁️ Tracked: <code>${this.recentTransactions.size}</code> transactions\n`;
      message += `⏰ Window: <code>${this.SIMPLE_DUPLICATE_WINDOW / (60 * 1000)}</code> minutes\n\n`;
      
      message += `<code>#BotStats #SystemStatus #SimpleDedup</code>`;

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
        message += `    <code>${wallet.address}</code>\n`;
        message += `    WR: <code>${(wallet.winRate || 0).toFixed(1)}%</code> | PnL: <code>${this.formatNumber(wallet.totalPnL || 0)}</code> | Trades: <code>${wallet.totalTrades || 0}</code>\n`;
        message += `    Avg: <code>${this.formatNumber(wallet.avgTradeSize || 0)}</code> | Score: <code>${wallet.performanceScore || 0}</code>\n\n`;
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
  `<code>${i + 1}.</code> ${w.pnl.toFixed(0)} | ${w.winrate}% WR | ${w.trades} trades`
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
        const tokenSymbol = this.getDisplayTokenSymbol(inflow.tokenSymbol, inflow.tokenAddress);
        message += `<code>${index + 1}.</code> <b>#${tokenSymbol}</b> `;
        message += `${this.formatNumber(inflow.inflowUSD)} `;
        message += `(${inflow.walletCount} wallets)\n`;
      });

      message += `\n<code>#SmartMoneyInflows #TopFlows</code>`;

      await this.sendCycleLog(message);
      this.stats.inflowsSent++;
      
    } catch (error) {
      this.logger.error('Error sending smart money inflows:', error);
      this.stats.errorsSent++;
    }
  }

  // 2. sendPositionSplittingAlert (для SolanaMonitor.ts)
  async sendPositionSplittingAlert(alert: PositionSplittingAlert): Promise<void> {
    try {
      let message = `🚨 <b>Position Splitting Detected!</b>\n\n`;
      
      const tokenSymbol = this.getDisplayTokenSymbol(alert.tokenSymbol, alert.tokenAddress);
      message += `🎯 <b>Token:</b> <code>${tokenSymbol}</code>\n`;
      message += `💰 <b>Total Position:</b> <code>${this.formatNumber(alert.totalUSD)}</code>\n`;
      message += `📦 <b>Split into:</b> <code>${alert.purchaseCount}</code> purchases\n`;
      message += `📊 <b>Avg Size:</b> <code>${this.formatNumber(alert.avgPurchaseSize)}</code>\n`;
      message += `⏱️ <b>Time Window:</b> <code>${alert.timeWindowMinutes}min</code>\n`;
      message += `🚩 <b>Suspicion Score:</b> <code>${alert.suspicionScore}/100</code>\n\n`;
      
      message += `👤 <b>Wallet:</b>\n`;
      message += `<code>${alert.walletAddress}</code>\n\n`;
      
      message += `🔗 <b>Token:</b>\n`;
      message += `<code>${alert.tokenAddress}</code>\n\n`;
      
      message += `📋 <b>Purchases (last 5):</b>\n`;
      alert.purchases.slice(-5).forEach((purchase, index) => {
        message += `<code>${index + 1}.</code> ${this.formatNumber(purchase.amountUSD)} `;
        message += `${this.formatTransactionAge(purchase.timestamp)}\n`;
      });

      message += `\n<code>#PositionSplitting #SuspiciousActivity</code>`;

      await this.sendCycleLog(message);
      this.stats.positionSplittingAlerts++;
      this.logger.info(`🚨 Position splitting alert sent: ${tokenSymbol}`);
      
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
      this.stats.tokenNameAlerts++;
      this.logger.info(`⚠️ Token name alert sent: ${alert.tokenName}`);
      
    } catch (error) {
      this.logger.error('Error sending token name alert:', error);
      this.stats.errorsSent++;
    }
  }

  // ✅ ДОПОЛНИТЕЛЬНЫЕ МЕТОДЫ ДЛЯ FLOWS - КОМПАКТНЫЙ ФОРМАТ

  async sendInflowOutflowSummary(type: 'inflow' | 'outflow', period: string, flows: any[]): Promise<void> {
    try {
      const emoji = type === 'inflow' ? '📈' : '📉';
      const title = type === 'inflow' ? 'Inflows' : 'Outflows';
      
      // Компактный формат как у CryptoAttack
      let message = `${emoji} <b>SM ${title} (${period})</b>\n\n`;
      
      flows.slice(0, 8).forEach((flow, index) => {
        const tokenSymbol = this.getDisplayTokenSymbol(flow.tokenSymbol, flow.tokenAddress || '');
        message += `<code>${index + 1}.</code> <b>#${tokenSymbol}</b> `;
        message += `${this.formatNumber(flow.amount || 0)} `;
        message += `(${flow.walletCount || 0} wallets)\n`;
      });

      message += `\n<code>#${title} #SmartMoney</code>`;

      await this.sendCycleLog(message);
      this.stats.flowsSent++;
      
    } catch (error) {
      this.logger.error(`Error sending ${type} summary:`, error);
      this.stats.errorsSent++;
    }
  }

  // 🔥 HOT NEW TOKEN - КОМПАКТНЫЙ ФОРМАТ
  async sendHotNewTokenAlert(token: HotNewToken): Promise<void> {
    try {
      const tokenSymbol = this.getDisplayTokenSymbol(token.symbol, token.address);
      
      // Компактный формат как у CryptoAttack
      let message = `🔥 <b>HNT: #${tokenSymbol}</b>\n`;
      message += `💰 Buy: ${this.formatNumber(token.buyVolumeUSD || 0)} `;
      message += `Sell: ${this.formatNumber(token.sellVolumeUSD || 0)}\n`;
      message += `👥 ${token.uniqueSmWallets || 0} SM wallets | `;
      message += `📊 FDV: ${this.formatNumber(token.fdv || 0)} | `;
      message += `🕒 ${token.ageHours || 0}h\n`;
      message += `🔗 #${token.address.slice(0, 8)}...${token.address.slice(-4)}\n`;
      message += `<code>#HotToken #NewListing</code>`;

      await this.sendCycleLog(message);
      this.stats.hotTokenAlerts++;
      this.logger.info(`🔥 Hot token alert sent: ${tokenSymbol}`);
      
    } catch (error) {
      this.logger.error('Error sending hot token alert:', error);
      this.stats.errorsSent++;
    }
  }

  // 🎯 ГЛАВНЫЙ МЕТОД SMART MONEY SWAP - УПРОЩЕННАЯ ВЕРСИЯ
  async sendSmartMoneySwapAlert(swap: SmartMoneySwap, source: string = 'Unknown'): Promise<void> {
    try {
      // 1. ПРОСТАЯ проверка на дубликаты
      if (this.isSimpleDuplicate(swap.transactionId)) {
        return; // Пропускаем дубликат
      }
      
      // 2. Отправляем индивидуальное сообщение
      await this.sendIndividualSwapMessage(swap);
      
    } catch (error) {
      this.logger.error('Error processing smart money swap alert:', error);
      this.stats.errorsSent++;
    }
  }

  // 💡 УПРОЩЕННОЕ индивидуальное сообщение в стиле CryptoAttack
  private async sendIndividualSwapMessage(swap: SmartMoneySwap): Promise<void> {
    try {
      const categoryEmoji = this.getCategoryEmoji(swap.category);
      const actionEmoji = swap.swapType === 'buy' ? '🟢' : '🔴';
      
      // Правильное отображение символов токенов
      const tokenSymbol = this.getDisplayTokenSymbol(swap.tokenSymbol, swap.tokenAddress);
      
      const tokenAmount = this.formatTokenAmount(swap.tokenAmount || 0);
      
      // 🎯 КОМПАКТНЫЙ ФОРМАТ КАК У CRYPTOATTACK
      let message = `${categoryEmoji} ${this.formatNumber(swap.amountUSD)} ${actionEmoji} ${tokenAmount} `;
      message += `<b>#${tokenSymbol}</b>`;
      
      // Добавляем цену токена если есть и она валидна
      if (swap.tokenPrice && swap.tokenPrice > 0 && swap.tokenPrice < 1000000) {
        message += ` (${this.formatPrice(swap.tokenPrice)})`;
      }
      
      // Добавляем arrow для направления как у CryptoAttack
      message += ` --> `;
      
      // Добавляем метрики кошелька с проверками
      message += `#${swap.walletAddress.slice(0, 7)}`;
      
      if (swap.winRate !== undefined && swap.winRate > 0) {
        message += ` WR: ${swap.winRate.toFixed(1)}%`;
      }
      
      if (swap.pnl !== undefined) {
        message += ` PNL: ${this.formatNumber(Math.abs(swap.pnl))}`;
      }
      
      if (swap.totalTrades !== undefined && swap.totalTrades > 0) {
        message += ` TT: ${swap.totalTrades}`;
      }
      
      message += ` BS DS`; // Как у CryptoAttack
      message += `\nWallet TXN #SmartSwap${swap.swapType === 'buy' ? 'Buy' : 'Sell'}`;
      
      // HTML-ссылки на SOLSCAN
      message += `\n🔗 <a href="https://solscan.io/tx/${swap.transactionId}">TX</a> | `;
      message += `<a href="https://solscan.io/account/${swap.walletAddress}">Wallet</a> | `;
      message += `<a href="https://solscan.io/token/${swap.tokenAddress}">Token</a>`;
      
      // Подпись для отслеживания дублей
      message += `\n📋 ${swap.transactionId.slice(0, 12)}...${swap.transactionId.slice(-6)}`;

      await this.sendCycleLog(message);
      this.stats.smartMoneySwaps++;
      
    } catch (error) {
      this.logger.error('Error sending individual swap message:', error);
      this.stats.errorsSent++;
    }
  }

  // 🆕 МЕТОД ДЛЯ ПРАВИЛЬНОГО ОТОБРАЖЕНИЯ СИМВОЛОВ ТОКЕНОВ
  private getDisplayTokenSymbol(tokenSymbol: string | undefined, tokenAddress: string): string {
    // Проверяем, что символ валидный (не пустой, не "UNKNOWN", не часть адреса)
    if (tokenSymbol && 
        tokenSymbol !== 'UNKNOWN' && 
        tokenSymbol !== 'Unknown' && 
        tokenSymbol.length <= 10 && // Разумная длина символа
        !tokenSymbol.includes('...') && // Не частичный адрес
        !/^[0-9A-Fa-f]{6,}$/.test(tokenSymbol)) { // Не hex-строка
      return tokenSymbol;
    }
    
    // Fallback к части адреса с более красивым форматом
    return `${tokenAddress.slice(0, 6).toUpperCase()}`;
  }

  // 🆕 МЕТОД ДЛЯ ФОРМАТИРОВАНИЯ ЦЕНЫ ТОКЕНОВ
  private formatPrice(price: number): string {
    if (price >= 1000) {
      return `$${(price / 1000).toFixed(1)}K`;
    } else if (price >= 1) {
      return `$${price.toFixed(2)}`;
    } else if (price >= 0.01) {
      return `$${price.toFixed(4)}`;
    } else if (price >= 0.0001) {
      return `$${price.toFixed(6)}`;
    } else if (price >= 0.000001) {
      return `$${price.toFixed(8)}`;
    } else {
      return `$${price.toExponential(2)}`;
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

  // 🔄 ИСПРАВЛЕНИЕ ФОРМАТА ВОЗРАСТА ТРАНЗАКЦИИ - как у CryptoAttack
  private formatTransactionAge(timestamp: Date): string {
    const ageMs = Date.now() - timestamp.getTime();
    const ageMinutes = Math.floor(ageMs / (1000 * 60));
    
    if (ageMinutes < 1) {
      return 'now';
    } else if (ageMinutes < 60) {
      return `${ageMinutes}m ago`;
    } else {
      const ageHours = Math.floor(ageMinutes / 60);
      const remainingMinutes = ageMinutes % 60;
      if (ageHours < 24) {
        return remainingMinutes > 0 ? `${ageHours}h ${remainingMinutes}m ago` : `${ageHours}h ago`;
      } else {
        const ageDays = Math.floor(ageHours / 24);
        const remainingHours = ageHours % 24;
        return remainingHours > 0 ? `${ageDays}d ${remainingHours}h ago` : `${ageDays}d ago`;
      }
    }
  }

  // ✅ GET STATS с упрощенными метриками
  getNotificationStats() {
    return {
      ...this.stats,
      queueSize: this.messageQueue.length,
      isProcessingQueue: this.isProcessingQueue,
      messagesThisSecond: this.messagesThisSecond,
      duplicatesTracked: this.recentTransactions.size,
      errorRate: this.stats.totalSent > 0 ? (this.stats.errorsSent / this.stats.totalSent * 100).toFixed(2) + '%' : '0%',
      successRate: this.stats.totalSent > 0 ? ((this.stats.totalSent - this.stats.errorsSent) / this.stats.totalSent * 100).toFixed(2) + '%' : '100%',
      duplicateWindowMinutes: this.SIMPLE_DUPLICATE_WINDOW / (60 * 1000)
    };
  }

  // 🆕 Метод для приоритетной отправки (например, для команд)
  async sendPriorityMessage(message: string): Promise<void> {
    await this.sendCycleLog(message, 10); // Высокий приоритет
  }

  // 🆕 ALIAS for backward compatibility with WebhookServer.ts - ДОБАВЛЕНО ЗДЕСЬ!
  async sendSmartMoneySwap(swap: SmartMoneySwap): Promise<void> {
    return this.sendSmartMoneySwapAlert(swap, 'WebhookServer');
  }

  // 🆕 МЕТОДЫ ДЛЯ УПРАВЛЕНИЯ ДЕДУПЛИКАЦИЕЙ (упрощенные)
  getDuplicationStats(): {
    totalTracked: number;
    duplicatesFiltered: number;
    oldestTransaction: Date | null;
    newestTransaction: Date | null;
    windowMinutes: number;
  } {
    let oldest: Date | null = null;
    let newest: Date | null = null;
    
    for (const timestamp of this.recentTransactions.values()) {
      const date = new Date(timestamp);
      if (!oldest || date < oldest) {
        oldest = date;
      }
      if (!newest || date > newest) {
        newest = date;
      }
    }
    
    return {
      totalTracked: this.recentTransactions.size,
      duplicatesFiltered: this.stats.duplicatesFiltered,
      oldestTransaction: oldest,
      newestTransaction: newest,
      windowMinutes: this.SIMPLE_DUPLICATE_WINDOW / (60 * 1000)
    };
  }

  // 🆕 ОЧИСТКА ДЕДУПЛИКАЦИИ
  clearDuplicationCache(): void {
    this.recentTransactions.clear();
    this.logger.info('🧹 Simple duplication cache cleared');
  }
}