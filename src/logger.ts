/**
 * Structured JSON logger — machine-readable, one object per line to stdout,
 * picked up natively by Cloud Logging (aion-infra §28).
 *
 * It carries the observability-spine fields AION standardizes
 * (aion-docs/engineering/observability-standards.md): timestamp, level,
 * service, environment, git_sha, plus any correlation IDs a caller threads in.
 * It NEVER logs secrets or full payloads — callers pass references, not
 * sensitive values (aion-infra §28, §40).
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

export interface LoggerContext {
  service: string;
  environment: string;
  gitSha: string;
  serviceVersion: string;
}

export interface LogFields {
  request_id?: string;
  run_id?: string;
  mission_id?: string;
  correlation_id?: string;
  operation?: string;
  status?: string;
  latency_ms?: number;
  [key: string]: unknown;
}

export class Logger {
  private readonly threshold: number;

  constructor(
    private readonly ctx: LoggerContext,
    level: LogLevel = 'info',
  ) {
    this.threshold = LEVELS[level];
  }

  private emit(level: LogLevel, message: string, fields: LogFields = {}): void {
    if (LEVELS[level] < this.threshold) return;
    const line = {
      timestamp: new Date().toISOString(),
      level,
      service: this.ctx.service,
      environment: this.ctx.environment,
      git_sha: this.ctx.gitSha,
      service_version: this.ctx.serviceVersion,
      message,
      ...fields,
    };
    // Errors go to stderr, everything else to stdout (standard 12-factor).
    const sink = level === 'error' ? process.stderr : process.stdout;
    sink.write(`${JSON.stringify(line)}\n`);
  }

  debug(message: string, fields?: LogFields): void {
    this.emit('debug', message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.emit('info', message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.emit('warn', message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.emit('error', message, fields);
  }
}
