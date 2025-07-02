// src/services/TelegramNotifier.ts - 🔥 ИСПРАВЛЕНО: КЛИКАБЕЛЬНЫЙ АДРЕС ТОКЕНА ВМЕСТО SIGNATURE
import TelegramBot from 'node-telegram-bot-api';
import { SmartMoneyFlow, HotNewToken, SmartMoneySwap } from '../types';
import { Logger } from '../utils/Logger';
import { LargeTransaction } from './LargeTransactionMonitor';

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
  
  private messageQueue: Array<{ message: string; priority: number; retryCount: number }> = [];
  private isProcessingQueue: boolean = false;
  private lastMessageTime: number = 0;
  private messagesThisSecond: number = 0;
  private secondReset: number = 0;
  
  private recentTransactions = new Map<string, number>();
  private readonly SIMPLE_DUPLICATE_WINDOW = 3 * 60 * 1000; // 3 минуты
  
  private readonly MAX_MESSAGES_PER_SECOND = 20;
  private readonly MESSAGE_DELAY = 50;
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY = 1500;
  
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
    inflowsSent: 0,
    largeTransactionAlerts: 0,
    profitableSignals: 0
  };

  constructor(token: string, userId: string) {
    this.bot = new TelegramBot(token, { polling: true });
    this.userId = userId;
    this.logger = Logger.getInstance();
    
    this.setupBaseHandlers();
    this.startMessageQueueProcessor();
    this.startSimpleCleanup();
    this.logger.info('📱 TelegramNotifier: ИСПРАВЛЕНО - кликабельный адрес токена вместо signature!');
  }

  private setupBaseHandlers(): void {
    this.bot.on('message', (msg) => {
      if (msg.from?.id.toString() !== this.userId) return;

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
  }

  private startMessageQueueProcessor(): void {
    setInterval(async () => {
      if (!this.isProcessingQueue && this.messageQueue.length > 0) {
        await this.processMessageQueue();
      }
    }, 50);
  }

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
        this.logger.debug(`🧹 Cleanup: ${cleaned} transactions removed`);
      }
    }, 30 * 1000);
  }

  private isSimpleDuplicate(transactionId: string): boolean {
    const now = Date.now();
    const lastTime = this.recentTransactions.get(transactionId);
    
    if (lastTime && (now - lastTime) < this.SIMPLE_DUPLICATE_WINDOW) {
      this.stats.duplicatesFiltered++;
      this.logger.debug(`🚫 Duplicate filtered: ${transactionId.slice(0, 8)}...`);
      return true;
    }
    
    this.recentTransactions.set(transactionId, now);
    return false;
  }

  private async processMessageQueue(): Promise<void> {
    if (this.isProcessingQueue || this.messageQueue.length === 0) return;
    
    this.isProcessingQueue = true;
    
    try {
      this.messageQueue.sort((a, b) => b.priority - a.priority);
      
      while (this.messageQueue.length > 0) {
        const messageData = this.messageQueue.shift()!;
        
        try {
          await this.sendMessageSafely(messageData.message);
          break;
        } catch (error) {
          messageData.retryCount++;
          
          if (messageData.retryCount < this.MAX_RETRIES) {
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
    await this.enforceRateLimit();
    
    const chunks = this.chunkMessage(message);
    
    for (const chunk of chunks) {
      await this.bot.sendMessage(this.userId, chunk, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
      
      this.stats.totalSent++;
      this.stats.lastMessageTime = new Date();
      
      if (chunks.length > 1) {
        await this.sleep(100);
      }
    }
  }

  private async enforceRateLimit(): Promise<void> {
    const now = Date.now();
    
    if (now > this.secondReset) {
      this.messagesThisSecond = 0;
      this.secondReset = now + 1000;
    }
    
    if (this.messagesThisSecond >= this.MAX_MESSAGES_PER_SECOND) {
      const waitTime = this.secondReset - now;
      if (waitTime > 0) {
        await this.sleep(waitTime);
        this.messagesThisSecond = 0;
        this.secondReset = Date.now() + 1000;
      }
    }
    
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

  setupCommandHandlers(handlers: Record<string, () => Promise<void>>): void {
    for (const [command, handler] of Object.entries(handlers)) {
      this.commandHandlers.set(command, handler);
    }
    this.logger.info(`🤖 Registered ${Object.keys(handlers).length} command handlers`);
  }

  async sendCycleLog(message: string, priority: number = 1): Promise<void> {
    try {
      this.messageQueue.push({
        message,
        priority,
        retryCount: 0
      });
      
      this.stats.queuedMessages++;
      
      if (this.messageQueue.length <= 2 && !this.isProcessingQueue) {
        await this.processMessageQueue();
      }
      
    } catch (error) {
      this.logger.error('Error queuing message:', error);
      this.stats.errorsSent++;
    }
  }

  // 🔥🔥🔥 ГЛАВНОЕ ИСПРАВЛЕНИЕ: КЛИКАБЕЛЬНЫЙ АДРЕС ТОКЕНА ВМЕСТО SIGNATURE 🔥🔥🔥
  async sendSmartMoneySwapAlert(swap: SmartMoneySwap): Promise<void> {
    try {
      if (this.isSimpleDuplicate(swap.transactionId)) return;

      const categoryEmoji = this.getCategoryEmoji(swap.category);
      const swapTypeEmoji = swap.swapType === 'buy' ? '🟢' : '🔴';
      
      // 🔥 ИСПОЛЬЗУЕМ ТОЛЬКО ГОТОВЫЕ ДАННЫЕ ИЗ SWAP ОБЪЕКТА
      const firstLine = `${categoryEmoji} ${this.formatUSD(swap.amountUSD)} ${swapTypeEmoji}`;
      
      // Показываем количество и символ токена (УЖЕ ГОТОВЫЕ ДАННЫЕ)
      const tokenInfo = `${this.formatTokenAmount(swap.tokenAmount)} #${this.getDisplayTokenSymbol(swap.tokenSymbol, swap.tokenAddress)}`;
      
      // Цена токена если есть
      let priceInfo = '';
      if (swap.tokenPrice && swap.tokenPrice > 0) {
        priceInfo = ` (${this.formatPrice(swap.tokenPrice)})`;
      }
      
      // Платежный токен если есть
      let paymentInfo = '';
      if (swap.paymentTokenSymbol) {
        paymentInfo = ` ${swap.swapType === 'buy' ? 'from' : 'to'} #${swap.paymentTokenSymbol}`;
      }
      
      // Wallet hash (first 7 chars как на скрине)
      const walletTag = `#${swap.walletAddress.slice(0, 7)}`;
      
      // 🔥 ТОЛЬКО НАШИ МЕТРИКИ ЗА 7 ДНЕЙ
      const wr7dTag = `WR7d: ${(swap.winrate7d || 0).toFixed(1)}%`;
      const pnl7dTag = `PnL7d: ${this.formatUSD(Math.abs(swap.usdProfit7d || 0))}`;
      const buys7dTag = `Buys7d: ${swap.buy7d || 0}`;
      
      // 🔥🔥🔥 КЛИКАБЕЛЬНЫЕ ССЫЛКИ 🔥🔥🔥
      const walletLink = `<a href="https://solscan.io/account/${swap.walletAddress}">Wallet</a>`;
      const txnLink = `<a href="https://solscan.io/tx/${swap.transactionId}">TXN</a>`;
      
      // 🚀🚀🚀 ГЛАВНОЕ ИСПРАВЛЕНИЕ: КЛИКАБЕЛЬНЫЙ АДРЕС ТОКЕНА ВМЕСТО SIGNATURE 🚀🚀🚀
      const copyableTokenAddress = `<code>${swap.tokenAddress}</code>`;
      
      // Объединяем все в одну строку как на скрине
      const message = 
        `${firstLine} ${tokenInfo}${priceInfo}${paymentInfo} ${walletTag} ${wr7dTag} ${pnl7dTag} ${buys7dTag} BS DS\n` +
        `${walletLink} ${txnLink} #SmartSwap${swap.swapType === 'buy' ? 'Buy' : 'Sell'}\n` +
        `${copyableTokenAddress}`;

      await this.sendCycleLog(message, 10);
      
      this.stats.smartMoneySwaps++;
      this.stats.profitableSignals++;
      
      this.logger.info(`${categoryEmoji} SWAP ALERT: ${swap.tokenSymbol} for ${swap.amountUSD.toFixed(0)} - Token: ${swap.tokenAddress.slice(0,8)}...`);

    } catch (error) {
      this.logger.error('Error sending smart money swap alert:', error);
      this.stats.errorsSent++;
    }
  }

  // 🔥🔥🔥 HOT NEW TOKEN ALERT (HNT) - ДИЗАЙН КАК В ЗАДАНИИ 🔥🔥🔥
  async sendHotNewTokenAlert(token: HotNewToken): Promise<void> {
    try {
      const title = `🔥 <b>Hot New Token on Smart Money</b>\n<a href="https://t.me/smart_money_alpha">#HotNTSM</a>\n\n`;

      const tokenLine = `<b>#${this.getDisplayTokenSymbol(token.symbol, token.address)}</b>\n` +
                        `<b>FDV:</b> <code>${this.formatUSD(token.fdv)}</code> | ` +
                        `<b>SM Holds:</b> <code>${this.formatUSD(token.smStakeUSD)}</code> | ` +
                        `<b>Age:</b> <code>${token.ageHours.toFixed(1)}h</code>\n` +
                        `<b>Buy:</b> <code>${this.formatUSD(token.buyVolumeUSD)} (${token.buyCount})</code> | ` +
                        `<b>Sell:</b> <code>${this.formatUSD(token.sellVolumeUSD)} (${token.sellCount})</code>\n` +
                        `🔗 <a href="https://dexscreener.com/solana/${token.address}">Chart</a>`;
                        
      await this.sendCycleLog(title + tokenLine, 8);
      this.stats.hotTokenAlerts++;

    } catch (error) {
      this.logger.error('Error sending hot token alert:', error);
      this.stats.errorsSent++;
    }
  }
  public async sendPositionSplittingAlert(alert: PositionSplittingAlert): Promise<void> {
    try {
      // Простая проверка на дубликат по первой транзакции
      if (this.isSimpleDuplicate(alert.purchases[0].transactionId)) return;

      let message = `🚨 <b>Position Splitting Detected!</b>\n\n`;
      message += `🪙 <b>Token:</b> <code>#${this.getDisplayTokenSymbol(alert.tokenSymbol, alert.tokenAddress)}</code>\n`;
      message += `👤 <b>Wallet:</b> <code>${alert.walletAddress}</code>\n\n`;
      
      message += `💰 <b>Total Buy:</b> ${this.formatUSD(alert.totalUSD)}\n`;
      message += `🔢 <b>Purchases:</b> ${alert.purchaseCount} times\n`;
      message += `⏰ <b>Time Window:</b> ${alert.timeWindowMinutes.toFixed(1)} min\n`;
      message += `🎯 <b>Suspicion Score:</b> ${alert.suspicionScore}/100\n\n`;
      
      message += `<a href="https://solscan.io/token/${alert.tokenAddress}">Token</a> | <a href="https://solscan.io/account/${alert.walletAddress}">Wallet</a>\n\n`;

      message += `<b>Breakdown:</b>\n<pre>`;
      // Показываем до 10 покупок, чтобы сообщение не было слишком длинным
      for (const p of alert.purchases.slice(0, 10)) {
        const time = new Date(p.timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        message += `${time} - ${this.formatUSD(p.amountUSD)}\n`;
      }
      if (alert.purchases.length > 10) {
        message += `...and ${alert.purchases.length - 10} more\n`;
      }
      message += `</pre>`;

      // Отправляем сообщение с высоким приоритетом
      await this.sendCycleLog(message, 9);
      
      this.stats.positionSplittingAlerts++;
      this.logger.info(`🚨 Position Splitting alert sent for wallet ${alert.walletAddress.slice(0, 8)}`);

    } catch (error) {
      this.logger.error('Error sending position splitting alert:', error);
    }
  }

  // 🔥🔥🔥 TOP SMART MONEY INFLOWS - ДИЗАЙН ТОЧНО КАК НА СКРИНЕ 🔥🔥🔥
  async sendTopSmartMoneyInflows(inflows: any[]): Promise<void> {
    try {
      let message = `🟢 <b>Top Smart Money Inflows in the past 1 hour</b>\n<a href="@SOLsmflowsBot>#TopSMIn1</a>\n\n`;

      inflows.slice(0, 10).forEach(flow => {
        message += `<code>#${this.getDisplayTokenSymbol(flow.tokenSymbol, flow.tokenAddress)}</code>   $${Math.round(flow.totalInflowUSD).toLocaleString()}\n`;
      });

      await this.sendCycleLog(message, 7);
      this.stats.flowsSent++;

    } catch (error) {
      this.logger.error('Error sending smart money inflows:', error);
      this.stats.errorsSent++;
    }
  }

  // 🔥 ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ДЛЯ ФОРМАТИРОВАНИЯ (БЕЗ РАСЧЕТОВ!) 🔥

  private formatUSD(amount: number): string {
    if (amount >= 1_000_000) {
      return `$${(amount / 1_000_000).toFixed(2)}M`;
    } else if (amount >= 1_000) {
      return `$${(amount / 1_000).toFixed(1)}K`;
    } else {
      return `$${amount.toFixed(0)}`;
    }
  }

  private formatTokenAmount(amount: number): string {
    if (amount >= 1_000_000_000) {
      return `${(amount / 1_000_000_000).toFixed(2)}B`;
    } else if (amount >= 1_000_000) {
      return `${(amount / 1_000_000).toFixed(2)}M`;
    } else if (amount >= 1_000) {
      return `${(amount / 1_000).toFixed(2)}K`;
    } else if (amount >= 1) {
      return `${amount.toFixed(2)}`;
    } else {
      return `${amount.toFixed(4)}`;
    }
  }

  private formatPrice(price: number): string {
    if (price >= 1000) {
      return `$${(price / 1000).toFixed(1)}K`;
    } else if (price >= 1) {
      return `$${price.toFixed(3)}`;
    } else if (price >= 0.01) {
      return `$${price.toFixed(4)}`;
    } else if (price >= 0.0001) {
      return `$${price.toFixed(6)}`;
    } else {
      return `$${price.toExponential(2)}`;
    }
  }

  private getCategoryEmoji(category: string): string {
    switch (category) {
      case 'sniper': return '🔫';
      case 'hunter': return '💡';
      case 'trader': return '🐳';
      default: return '👨‍🎨'; // Default как на скрине
    }
  }

  private getDisplayTokenSymbol(tokenSymbol: string | undefined, tokenAddress: string): string {
    if (tokenSymbol && 
        tokenSymbol !== 'UNKNOWN' && 
        tokenSymbol !== 'Unknown' && 
        tokenSymbol.length <= 10 && 
        !tokenSymbol.includes('...') && 
        !/^[0-9A-Fa-f]{6,}$/.test(tokenSymbol)) {
      return tokenSymbol;
    }
    
    return `${tokenAddress.slice(0, 6).toUpperCase()}`;
  }

  // 🔥 ОСТАЛЬНЫЕ МЕТОДЫ БЕЗ ИЗМЕНЕНИЙ (для совместимости)

  async sendLargeTransactionAlert(transaction: LargeTransaction): Promise<void> {
    try {
      if (this.isSimpleDuplicate(transaction.signature)) {
        return;
      }

      const riskEmoji = this.getRiskEmoji(transaction.riskScore || 0);
      const typeEmoji = transaction.transactionType === 'buy' ? '💰' : '💸';
      const tokenSymbol = this.getDisplayTokenSymbol(transaction.tokenSymbol, transaction.tokenAddress);
      
      const message = `🚨 <b>Large Transaction Alert ${riskEmoji}</b>\n\n` +
        `${typeEmoji} <b>Type:</b> <code>${transaction.transactionType.toUpperCase()}</code>\n` +
        `💵 <b>Amount:</b> <code>$${transaction.amountUSD.toLocaleString()}</code>\n` +
        `📄 <b>Token:</b> <code>#${tokenSymbol}</code>\n` +
        `🏷️ <b>Name:</b> <code>${transaction.tokenName}</code>\n\n` +
        `👤 <b>Wallet:</b> <code>${transaction.walletAddress.slice(0, 8)}...${transaction.walletAddress.slice(-8)}</code>\n` +
        `🪙 <b>Token:</b> <code>${transaction.tokenAddress.slice(0, 8)}...${transaction.tokenAddress.slice(-8)}</code>\n\n` +
        `🔍 <b>Risk Score:</b> <code>${transaction.riskScore || 0}/100</code>\n` +
        (transaction.filterReason ? `📝 <b>Analysis:</b> <code>${transaction.filterReason}</code>\n` : '') +
        `🔗 <b>TX:</b> <code>${transaction.signature.slice(0, 16)}...</code>\n\n` +
        `⏰ <code>${transaction.timestamp.toLocaleString()}</code>\n\n` +
        `<a href="https://solscan.io/tx/${transaction.signature}">Transaction</a> | ` +
        `<a href="https://solscan.io/account/${transaction.walletAddress}">Wallet</a> | ` +
        `<a href="https://solscan.io/token/${transaction.tokenAddress}">Token</a>`;

      await this.sendCycleLog(message, 8);
      
      this.stats.largeTransactionAlerts++;
      this.logger.info(`🚨 Large TX alert sent: ${tokenSymbol} $${transaction.amountUSD.toLocaleString()}`);
      
    } catch (error) {
      this.logger.error('Error sending large transaction alert:', error);
      this.stats.errorsSent++;
    }
  }

  private getRiskEmoji(riskScore: number): string {
    if (riskScore >= 80) return '🔴';
    if (riskScore >= 50) return '🟡'; 
    if (riskScore >= 20) return '🟢';
    return '✅';
  }

  async sendStatsResponse(data: StatsData): Promise<void> {
    try {
      const uptimeHours = Math.floor(data.uptime / 3600);
      const uptimeMinutes = Math.floor((data.uptime % 3600) / 60);
      
      let message = `📊 <b>Smart Money Bot</b>\n\n`;
      
      message += `🟢 Uptime: <code>${uptimeHours}h ${uptimeMinutes}m</code>\n`;
      message += `🔄 Mode: <code>${data.webhookMode === 'polling' ? 'Polling' : 'Webhooks'}</code>\n`;
      message += `📡 Wallets: <code>${data.pollingStats?.walletsMonitored || 0}/100</code>\n\n`;
      
      message += `👥 <b>Active SM Wallets:</b>\n`;
      message += `✅ Enabled: <code>${data.walletStats?.enabled || 0}</code>\n`;
      message += `🔫 Snipers: <code>${data.walletStats?.byCategory?.sniper || 0}</code>\n`;
      message += `💡 Hunters: <code>${data.walletStats?.byCategory?.hunter || 0}</code>\n`;
      message += `🐳 Traders: <code>${data.walletStats?.byCategory?.trader || 0}</code>\n\n`;
      
      message += `🤖 <b>Notifications:</b>\n`;
      message += `🚀 Profit Signals: <code>${this.stats.profitableSignals}</code>\n`;
      message += `📤 Total Sent: <code>${this.stats.totalSent}</code>\n`;
      message += `🚫 Duplicates: <code>${this.stats.duplicatesFiltered}</code>\n`;
      message += `❌ Errors: <code>${this.stats.errorsSent}</code>\n\n`;
      
      message += `<code>#BotStats #ProfitFirst</code>`;

      await this.sendCycleLog(message);
      this.logger.info('📊 Stats response sent');

    } catch (error) {
      this.logger.error('Error sending stats response:', error);
      this.stats.errorsSent++;
    }
  }

  async sendWalletsResponse(data: WalletsData): Promise<void> {
    try {
      let message = `👥 <b>Top Smart Money Wallets</b>\n\n`;
      
      message += `📊 Active: <code>${data.stats?.active || 0}</code> | Enabled: <code>${data.stats?.enabled || 0}</code>\n\n`;
      
      message += `🏆 <b>Top Performers:</b>\n\n`;
      
      data.wallets.slice(0, 10).forEach((wallet, index) => {
        const categoryEmoji = this.getCategoryEmoji(wallet.category || 'unknown');
        const priorityEmoji = wallet.priority === 'high' ? '🔴' : wallet.priority === 'medium' ? '🟡' : '🟢';
        const statusEmoji = wallet.enabled ? '✅' : '⚪';
        
        message += `<code>${(index + 1).toString().padStart(2, '0')}.</code> ${categoryEmoji} <b>${wallet.nickname || 'Unknown'}</b> ${priorityEmoji}${statusEmoji}\n`;
        
        message += `    WR7d: <code>${(wallet.winrate7d || 0).toFixed(1)}%</code> | `;
        message += `PnL7d: <code>${this.formatUSD(wallet.usdProfit7d || 0)}</code> | `;
        message += `Buys7d: <code>${wallet.buy7d || 0}</code>\n`;
        
        message += `    Avg Hold: <code>${(wallet.avgHoldingMins || 0).toFixed(0)}m</code> | `;
        message += `SOL: <code>${(wallet.solBalance || 0).toFixed(1)}</code> | `;
        message += `Score: <code>${(wallet.performanceScore || 0).toFixed(0)}</code>\n\n`;
      });
      
      message += `<code>#SmartWallets #ProfitTracking</code>`;

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

  async sendDragonImportNotification(result: {
    totalParsed: number;
    added: number;
    updated: number;
    skipped: number;
    categories: { snipers: number; hunters: number; traders: number };
    topPerformers: any[];
  }): Promise<void> {
    try {
      let message = `🐲 <b>Dragon Import Results</b>\n\n`;
      
      message += `📊 <b>Statistics:</b>\n`;
      message += `• Parsed: <code>${result.totalParsed}</code> wallets\n`;
      message += `• Added: <code>${result.added}</code> new\n`;
      message += `• Updated: <code>${result.updated}</code> existing\n`;
      message += `• Skipped: <code>${result.skipped}</code> duplicates\n\n`;
      
      message += `🎯 <b>Categories:</b>\n`;
      message += `• 🔫 Snipers: <code>${result.categories.snipers}</code>\n`;
      message += `• 💡 Hunters: <code>${result.categories.hunters}</code>\n`;
      message += `• 🐳 Traders: <code>${result.categories.traders}</code>\n\n`;
      
      message += `🏆 <b>Top 5 Performers:</b>\n`;
      result.topPerformers.slice(0, 5).forEach((w, i) => {
        message += `<code>${i + 1}.</code> ${this.formatUSD(w.usdProfit7d || 0)} | `;
        message += `${(w.winrate7d || 0).toFixed(1)}% WR7d | `;
        message += `${w.buy7d || 0} buys7d\n`;
      });
      
      message += `\n⏰ <code>${new Date().toLocaleString()}</code>`;

      await this.sendCycleLog(message);
      this.stats.dragonImports++;
      
    } catch (error) {
      this.logger.error('❌ Error sending Dragon import notification:', error);
    }
  }

  getNotificationStats() {
    return {
      ...this.stats,
      queueSize: this.messageQueue.length,
      isProcessingQueue: this.isProcessingQueue,
      messagesThisSecond: this.messagesThisSecond,
      duplicatesTracked: this.recentTransactions.size,
      errorRate: this.stats.totalSent > 0 ? (this.stats.errorsSent / this.stats.totalSent * 100).toFixed(2) + '%' : '0%',
      successRate: this.stats.totalSent > 0 ? ((this.stats.totalSent - this.stats.errorsSent) / this.stats.totalSent * 100).toFixed(2) + '%' : '100%',
      duplicateWindowMinutes: this.SIMPLE_DUPLICATE_WINDOW / (60 * 1000),
      profitSignalsPerHour: this.stats.profitableSignals
    };
  }

  async sendPriorityMessage(message: string): Promise<void> {
    await this.sendCycleLog(message, 10);
  }

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

  clearDuplicationCache(): void {
    this.recentTransactions.clear();
    this.logger.info('🧹 Duplication cache cleared');
  }
}