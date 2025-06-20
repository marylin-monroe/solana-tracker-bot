// src/services/TransactionDispatcher.ts - РЕШЕНИЕ ПРОБЛЕМЫ ДУБЛИРОВАНИЯ
import { Logger } from "../utils/Logger";
import { SmartMoneySwap } from "../types";
import { SmartMoneyDatabase } from "./SmartMoneyDatabase";
import { TelegramNotifier } from "./TelegramNotifier";
import { LargeTransaction } from './LargeTransactionMonitor';

interface TransactionEvent {
  signature: string;
  source: 'smart_money' | 'large_transaction' | 'webhook';
  data: SmartMoneySwap | LargeTransaction;
  priority: number; // 1-5, где 5 = высший приоритет
  timestamp: Date;
}

interface ProcessedTransaction {
  signature: string;
  sources: Set<string>;
  finalData: any;
  sentToTelegram: boolean;
  timestamp: Date;
}

export class TransactionDispatcher {
  private logger: Logger;
  private telegramNotifier: TelegramNotifier;
  private smDatabase: SmartMoneyDatabase;
  
  // 🔥 ГЛАВНОЕ: Глобальный кеш обработанных транзакций
  private processedTransactions = new Map<string, ProcessedTransaction>();
  private readonly PROCESSING_WINDOW = 60 * 1000; // 60 секунд на сбор всех источников
  private readonly CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 минут
  
  // Очередь событий для отложенной обработки
  private pendingEvents = new Map<string, TransactionEvent[]>();
  private processingTimers = new Map<string, NodeJS.Timeout>();

  constructor(telegramNotifier: TelegramNotifier, smDatabase: SmartMoneyDatabase) {
    this.telegramNotifier = telegramNotifier;
    this.smDatabase = smDatabase;
    this.logger = Logger.getInstance();
    
    this.startCleanupTimer();
    this.logger.info('🎯 TransactionDispatcher initialized - SOLVING DUPLICATE PROBLEM');
  }

  /**
   * 🎯 ОСНОВНОЙ МЕТОД: Регистрация события транзакции
   */
  async registerTransaction(event: TransactionEvent): Promise<void> {
    const signature = event.signature;
    
    // Проверяем, уже ли отправили уведомление по этой транзакции
    const existing = this.processedTransactions.get(signature);
    if (existing?.sentToTelegram) {
      this.logger.debug(`🚫 Transaction ${signature.slice(0,8)}... already sent to Telegram`);
      return;
    }

    // Добавляем событие в очередь
    if (!this.pendingEvents.has(signature)) {
      this.pendingEvents.set(signature, []);
    }
    this.pendingEvents.get(signature)!.push(event);

    // Обновляем/создаем запись в processedTransactions
    if (existing) {
      existing.sources.add(event.source);
    } else {
      this.processedTransactions.set(signature, {
        signature,
        sources: new Set([event.source]),
        finalData: event.data,
        sentToTelegram: false,
        timestamp: new Date()
      });
    }

    // Сбрасываем предыдущий таймер и ставим новый
    const existingTimer = this.processingTimers.get(signature);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // ✅ КЛЮЧЕВОЕ РЕШЕНИЕ: Даем 3 секунды на сбор всех источников
    const timer = setTimeout(() => {
      this.processTransaction(signature);
    }, 3000);

    this.processingTimers.set(signature, timer);
    
    this.logger.debug(`📥 Registered ${event.source} event for TX ${signature.slice(0,8)}... (sources: ${Array.from(this.processedTransactions.get(signature)!.sources).join(', ')})`);
  }

  /**
   * 🔄 ОБРАБОТКА СОБРАННЫХ СОБЫТИЙ
   */
  private async processTransaction(signature: string): Promise<void> {
    try {
      const processed = this.processedTransactions.get(signature);
      const events = this.pendingEvents.get(signature);
      
      if (!processed || !events || processed.sentToTelegram) {
        return;
      }

      // Определяем приоритетное событие
      const priorityEvent = this.selectPriorityEvent(events);
      
      // 🎯 ЛОГИКА ПРИОРИТЕТА:
      // 1. Smart Money кошелек из нашей базы = ВЫСШИЙ приоритет
      // 2. Large Transaction = средний приоритет  
      // 3. Webhook = низкий приоритет

      let finalAlert: any = null;
      const sources = Array.from(processed.sources);

      if (sources.includes('smart_money')) {
        // ✅ Отправляем как Smart Money Swap (приоритет)
        const smEvent = events.find(e => e.source === 'smart_money');
        if (smEvent) {
          finalAlert = await this.telegramNotifier.sendSmartMoneySwapAlert(smEvent.data as SmartMoneySwap);
          this.logger.info(`📤 Sent Smart Money alert for TX ${signature.slice(0,8)}... (sources: ${sources.join(', ')})`);
        }
      } else if (sources.includes('large_transaction')) {
        // ✅ Отправляем как Large Transaction
        const largeEvent = events.find(e => e.source === 'large_transaction');
        if (largeEvent) {
          finalAlert = await this.telegramNotifier.sendLargeTransactionAlert(largeEvent.data as LargeTransaction);
          this.logger.info(`📤 Sent Large TX alert for TX ${signature.slice(0,8)}... (sources: ${sources.join(', ')})`);
        }
      }

      // Помечаем как отправленное
      processed.sentToTelegram = true;
      processed.finalData = finalAlert;

      // Очищаем временные данные
      this.pendingEvents.delete(signature);
      this.processingTimers.delete(signature);

    } catch (error) {
      this.logger.error(`Error processing transaction ${signature}:`, error);
    }
  }

  /**
   * 🎯 ВЫБОР ПРИОРИТЕТНОГО СОБЫТИЯ
   */
  private selectPriorityEvent(events: TransactionEvent[]): TransactionEvent {
    // Сортируем по приоритету (высший первым)
    return events.sort((a, b) => b.priority - a.priority)[0];
  }

  /**
   * 🧹 ОЧИСТКА СТАРЫХ ЗАПИСЕЙ
   */
  private startCleanupTimer(): void {
    setInterval(() => {
      const now = Date.now();
      let cleaned = 0;

      for (const [signature, processed] of this.processedTransactions) {
        if (now - processed.timestamp.getTime() > this.CLEANUP_INTERVAL) {
          this.processedTransactions.delete(signature);
          cleaned++;
        }
      }

      if (cleaned > 0) {
        this.logger.debug(`🧹 Cleaned ${cleaned} old transaction records`);
      }
    }, this.CLEANUP_INTERVAL);
  }

  /**
   * 📊 СТАТИСТИКА
   */
  getStats(): { totalProcessed: number; pendingEvents: number; duplicatesStopped: number } {
    const duplicatesStopped = Array.from(this.processedTransactions.values())
      .filter(tx => tx.sources.size > 1).length;

    return {
      totalProcessed: this.processedTransactions.size,
      pendingEvents: this.pendingEvents.size,
      duplicatesStopped
    };
  }
}