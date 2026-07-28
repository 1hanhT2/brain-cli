export interface PerformanceMeasurement {
  name: string;
  durationMs: number;
  recordedAt: number;
}

export interface PerformanceSummary {
  name: string;
  count: number;
  lastMs: number;
  averageMs: number;
  maximumMs: number;
}

const clock = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

export class PerformanceTracer {
  private readonly measurements: PerformanceMeasurement[] = [];

  constructor(private readonly capacity = 250) {}

  start(name: string): () => number {
    const startedAt = clock();
    let finished = false;
    return () => {
      if (finished) return 0;
      finished = true;
      return this.record(name, clock() - startedAt);
    };
  }

  async measure<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const finish = this.start(name);
    try {
      return await operation();
    } finally {
      finish();
    }
  }

  record(name: string, durationMs: number): number {
    const normalized = Math.max(0, durationMs);
    this.measurements.push({
      name,
      durationMs: normalized,
      recordedAt: Date.now()
    });
    if (this.measurements.length > this.capacity) {
      this.measurements.splice(0, this.measurements.length - this.capacity);
    }
    return normalized;
  }

  reset(): void {
    this.measurements.length = 0;
  }

  summaries(): PerformanceSummary[] {
    const groups = new Map<string, PerformanceMeasurement[]>();
    for (const measurement of this.measurements) {
      const group = groups.get(measurement.name) ?? [];
      group.push(measurement);
      groups.set(measurement.name, group);
    }
    return [...groups.entries()]
      .map(([name, rows]) => ({
        name,
        count: rows.length,
        lastMs: rows.at(-1)?.durationMs ?? 0,
        averageMs: rows.reduce((total, row) => total + row.durationMs, 0) / rows.length,
        maximumMs: Math.max(...rows.map((row) => row.durationMs))
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  report(): string {
    const rows = this.summaries();
    if (rows.length === 0) return "No performance measurements recorded yet.";
    const heading = "operation                       count    last     avg     max";
    const body = rows.map((row) => [
      row.name.slice(0, 31).padEnd(31),
      String(row.count).padStart(5),
      this.formatMs(row.lastMs).padStart(8),
      this.formatMs(row.averageMs).padStart(8),
      this.formatMs(row.maximumMs).padStart(8)
    ].join(" "));
    return [heading, ...body].join("\n");
  }

  private formatMs(value: number): string {
    if (value < 0.1) return "<0.1ms";
    return `${value.toFixed(value < 10 ? 1 : 0)}ms`;
  }
}
