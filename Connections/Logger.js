import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

// Configure the log rotation
const fileRotateTransport = new DailyRotateFile({
  // The %DATE% placeholder will be replaced by the datePattern
  filename: 'logs/app-%DATE%.log', 
  
  // Rotates daily. To rotate differently, adjust this (see explanation below)
  datePattern: 'YYYY-MM-DD', 
  
  // Compress old log files to save space (optional)
  zippedArchive: true, 
  
  // Optional: Also rotate if a single file gets larger than 20MB
  maxSize: '20m', 
  
  // Automatically delete logs older than X days (e.g., '14d' for 14 days)
  maxFiles: '14d' 
});

// Create the actual logger instance
const logger = winston.createLogger({
  level: 'info', // Minimum log level to record (info, warn, error)
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    })
  ),
  transports: [
    fileRotateTransport,
    // It's helpful to also output logs to the console during development
    new winston.transports.Console() 
  ]
});

export default logger;