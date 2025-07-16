import winston from 'winston';
import path from 'path';
import chalk from 'chalk';

export class Logger {
  private static instance: Logger;
  private logger: winston.Logger;

  private constructor() {
    const logLevel = process.env.LOG_LEVEL || 'info';
    const logDir = 'logs';


    const customFormat = winston.format.printf(({ level, message, timestamp, ...meta }) => {
      const time = new Date().toLocaleTimeString('tr-TR');
      const date = new Date().toLocaleDateString('tr-TR');
      
      let coloredLevel = '';
      let coloredMessage = message;
      
      switch (level) {
        case 'error':
          coloredLevel = chalk.bold.red(`[${level.toUpperCase()}]`);
          coloredMessage = chalk.red(message);
          break;
        case 'warn':
          coloredLevel = chalk.bold.yellow(`[${level.toUpperCase()}]`);
          coloredMessage = chalk.yellow(message);
          break;
        case 'info':
          coloredLevel = chalk.bold.blue(`[${level.toUpperCase()}]`);
          coloredMessage = chalk.cyan(message);
          break;
        case 'debug':
          coloredLevel = chalk.bold.gray(`[${level.toUpperCase()}]`);
          coloredMessage = chalk.gray(message);
          break;
        default:
          coloredLevel = chalk.bold.white(`[${level.toUpperCase()}]`);
      }

      return `${chalk.gray(`[${date} ${time}]`)} ${coloredLevel} ${coloredMessage}`;
    });

    this.logger = winston.createLogger({
      level: logLevel,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        customFormat
      ),
      transports: [

        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.timestamp(),
            customFormat
          )
        }),


        new winston.transports.File({
          filename: path.join(logDir, 'combined.log'),
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json()
          ),
          maxsize: 5242880,
          maxFiles: 5
        }),


        new winston.transports.File({
          filename: path.join(logDir, 'error.log'),
          level: 'error',
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json()
          ),
          maxsize: 5242880,
          maxFiles: 5
        })
      ]
    });


    this.logger.exceptions.handle(
      new winston.transports.File({
        filename: path.join(logDir, 'exceptions.log'),
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.json()
        )
      })
    );

    this.logger.rejections.handle(
      new winston.transports.File({
        filename: path.join(logDir, 'rejections.log'),
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.json()
        )
      })
    );
  }

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  public info(message: string, meta?: any): void {
    this.logger.info(message, meta);
  }

  public error(message: string, error?: any): void {
    this.logger.error(message, error);
  }

  public warn(message: string, meta?: any): void {
    this.logger.warn(message, meta);
  }

  public debug(message: string, meta?: any): void {
    this.logger.debug(message, meta);
  }

  public guard(message: string, meta?: any): void {
    this.logger.info(`${chalk.bold.green('🔒 [KORUMA]')} ${chalk.green(message)}`, meta);
  }

  public backup(message: string, meta?: any): void {
    this.logger.info(`${chalk.bold.blue('💾 [YEDEKLEME]')} ${chalk.blue(message)}`, meta);
  }

  public audit(message: string, meta?: any): void {
    this.logger.info(`${chalk.bold.magenta('🔍 [DENETİM]')} ${chalk.magenta(message)}`, meta);
  }


  public success(message: string, meta?: any): void {
    this.logger.info(`${chalk.bold.green('✅ [BAŞARILI]')} ${chalk.green(message)}`, meta);
  }

  public warning(message: string, meta?: any): void {
    this.logger.warn(`${chalk.bold.yellow('⚠️  [UYARI]')} ${chalk.yellow(message)}`, meta);
  }

  public critical(message: string, meta?: any): void {
    this.logger.error(`${chalk.bold.red('🚨 [KRİTİK]')} ${chalk.red(message)}`, meta);
  }

  public system(message: string, meta?: any): void {
    this.logger.info(`${chalk.bold.cyan('⚙️  [SİSTEM]')} ${chalk.cyan(message)}`, meta);
  }
} 