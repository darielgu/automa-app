import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEvent {
  ts: string;
  level: LogLevel;
  event: string;
  data?: Record<string, unknown>;
}

export class AppLogger {
  private readonly logFile: string;

  constructor(outputDir: string) {
    fs.mkdirSync(outputDir, { recursive: true });
    this.logFile = path.join(outputDir, "run.ndjson");
  }

  debug(event: string, data?: Record<string, unknown>): void {
    this.write("debug", event, data);
  }

  info(event: string, data?: Record<string, unknown>): void {
    this.write("info", event, data);
  }

  warn(event: string, data?: Record<string, unknown>): void {
    this.write("warn", event, data);
  }

  error(event: string, data?: Record<string, unknown>): void {
    this.write("error", event, data);
  }

  private write(level: LogLevel, event: string, data?: Record<string, unknown>): void {
    const payload: LogEvent = {
      ts: new Date().toISOString(),
      level,
      event,
      data
    };

    const line = JSON.stringify(payload);
    fs.appendFileSync(this.logFile, `${line}\n`, "utf8");
    if (this.shouldPrintToStdout(level, event)) {
      const printer = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
      printer(line);
    }
  }

  private shouldPrintToStdout(level: LogLevel, event: string): boolean {
    if (level === "error" || level === "warn") return true;
    if (process.env.WORKDAY_VERBOSE_WIDGET_STDOUT === "1") return true;
    if (/^workday_widget_(?:extracted|resolved|execution_attempt|execution_applied|execution_verify|state|committed_state|unresolved)$/.test(event)) {
      return false;
    }
    return true;
  }
}
