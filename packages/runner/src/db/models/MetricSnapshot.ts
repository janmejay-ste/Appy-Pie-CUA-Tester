import { getDb } from '../sqlite.js';

export interface IMetricSnapshot {
  _id: string;
  timestamp: Date;
  queueWaiting: number;
  queueActive: number;
  queueFailed: number;
  totalRuns: number;
  failureRate: number;
  avgLatencyMs: number;
  totalTokensUsed: number;
  alerts: string[];
}

interface MetricRow {
  id: string; timestamp: string; queue_waiting: number; queue_active: number;
  queue_failed: number; total_runs: number; failure_rate: number;
  avg_latency_ms: number; total_tokens_used: number; alerts: string;
}

function rowToDoc(r: MetricRow): IMetricSnapshot {
  return {
    _id: r.id, timestamp: new Date(r.timestamp),
    queueWaiting: r.queue_waiting, queueActive: r.queue_active, queueFailed: r.queue_failed,
    totalRuns: r.total_runs, failureRate: r.failure_rate, avgLatencyMs: r.avg_latency_ms,
    totalTokensUsed: r.total_tokens_used, alerts: JSON.parse(r.alerts || '[]'),
  };
}

export const MetricSnapshot = {
  create(data: Partial<IMetricSnapshot> & { _id: string; timestamp: Date }) {
    const ts = data.timestamp instanceof Date ? data.timestamp.toISOString() : String(data.timestamp);
    getDb().prepare(`INSERT INTO metric_snapshots (id, timestamp, queue_waiting, queue_active, queue_failed, total_runs, failure_rate, avg_latency_ms, total_tokens_used, alerts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(data._id, ts, data.queueWaiting ?? 0, data.queueActive ?? 0, data.queueFailed ?? 0, data.totalRuns ?? 0, data.failureRate ?? 0, data.avgLatencyMs ?? 0, data.totalTokensUsed ?? 0, JSON.stringify(data.alerts ?? []));
    return { ...data, timestamp: new Date(ts) } as IMetricSnapshot;
  },

  find(query: Record<string, any> = {}) {
    const params: any[] = [];
    const conds: string[] = [];
    if (query.timestamp?.$gte) { conds.push('timestamp >= ?'); params.push(query.timestamp.$gte instanceof Date ? query.timestamp.$gte.toISOString() : query.timestamp.$gte); }
    let sql = 'SELECT * FROM metric_snapshots' + (conds.length ? ' WHERE ' + conds.join(' AND ') : '');
    let orderBy = '';
    const chain: any = {
      sort(s: Record<string, number>) { orderBy = ' ORDER BY ' + Object.entries(s).map(([k, v]) => `${k === 'timestamp' ? 'timestamp' : k} ${v === -1 ? 'DESC' : 'ASC'}`).join(', '); return chain; },
      lean() { return chain; },
      then(resolve: Function, reject?: Function) {
        try { resolve(getDb().prepare(sql + orderBy).all(...params).map((r: any) => rowToDoc(r))); }
        catch (e) { reject?.(e); }
      },
    };
    return chain;
  },
};
