'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useSSE } from '@/lib/use-sse';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

interface Screenshot {
  id: string;
  turn_number: number;
  file_path: string;
  captured_at: string;
  page_url: string | null;
  page_title: string | null;
}

interface RunEvent {
  id: string;
  type: string;
  message: string;
  timestamp: string;
  sequence: number;
}

interface TurnToken {
  id: string;
  turn_number: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  api_latency_ms: number;
  cumulative_input: number;
  cumulative_output: number;
  cumulative_reasoning: number;
  timestamp: string;
}

interface RunDetail {
  id: string;
  test_id: string;
  test_name: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  turn_count: number;
  screenshot_count: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  model_verdict: string | null;
  error: string | null;
  screenshots: Screenshot[];
  events: RunEvent[];
  turnTokens: TurnToken[];
}

export default function RunDetailPage() {
  const params = useParams();
  const runId = params.runId as string;
  const [run, setRun] = useState<RunDetail | null>(null);
  const [selectedScreenshot, setSelectedScreenshot] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [aborting, setAborting] = useState(false);
  const [viewMode, setViewMode] = useState<'screenshots' | 'video'>('screenshots');
  const [hasVideo, setHasVideo] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [rerunning, setRerunning] = useState(false);
  const [showTokens, setShowTokens] = useState(false);

  // SSE for live updates when the run is active
  const isActive = run?.status === 'running' || run?.status === 'queued';
  const { events: liveEvents } = useSSE(isActive ? `${API}/api/runs/${runId}/events` : null);

  // Live elapsed timer while running
  useEffect(() => {
    if (!isActive || !run?.started_at) return;
    const startTime = new Date(run.started_at).getTime();
    const tick = () => setElapsed(Math.floor((Date.now() - startTime) / 1000));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [isActive, run?.started_at]);

  // Load run data
  useEffect(() => {
    const load = async () => {
      const res = await fetch(`${API}/api/runs/${runId}`);
      if (res.ok) {
        setRun(await res.json());
      }
      setLoading(false);
      // Check if video is available
      const videoRes = await fetch(`${API}/api/runs/${runId}/video`, { method: 'HEAD' });
      setHasVideo(videoRes.ok);
    };
    load();
  }, [runId]);

  // Refresh when live events come in
  useEffect(() => {
    if (liveEvents.length > 0) {
      fetch(`${API}/api/runs/${runId}`).then(r => r.json()).then(setRun);
    }
  }, [liveEvents.length, runId]);

  // Poll while active, check for video when completed
  useEffect(() => {
    if (!isActive) return;
    const interval = setInterval(async () => {
      const res = await fetch(`${API}/api/runs/${runId}`);
      if (res.ok) {
        const data = await res.json();
        setRun(data);
        // When run just completed, check for video after a short delay (FFmpeg needs time)
        if (data.status !== 'running' && data.status !== 'queued') {
          setTimeout(async () => {
            const videoRes = await fetch(`${API}/api/runs/${runId}/video`, { method: 'HEAD' });
            setHasVideo(videoRes.ok);
          }, 3000);
        }
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [isActive, runId]);

  if (loading) return <div className="text-gray-500 text-center py-20">Loading...</div>;
  if (!run) return <div className="text-gray-500 text-center py-20">Run not found</div>;

  const screenshots = run.screenshots ?? [];
  const events = run.events ?? [];
  const currentScreenshot = screenshots[selectedScreenshot];
  const screenshotFilename = currentScreenshot?.file_path.split(/[\\\/]/).pop();

  // Categorize each screenshot
  const getScreenshotCategory = (index: number, total: number) => {
    if (index === 0) return { label: 'Initial State', color: 'bg-blue-50 text-blue-600 dark:bg-blue-500/20 dark:text-blue-400' };
    if (index === total - 1) {
      if (run.status === 'passed') return { label: 'Final - Passed', color: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400' };
      if (run.status === 'failed') return { label: 'Failure Point', color: 'bg-red-50 text-red-600 dark:bg-red-500/20 dark:text-red-400' };
      if (run.status === 'error') return { label: 'Error State', color: 'bg-orange-50 text-orange-600 dark:bg-orange-500/20 dark:text-orange-400' };
      if (run.status === 'timeout') return { label: 'Timeout State', color: 'bg-yellow-50 text-yellow-600 dark:bg-yellow-500/20 dark:text-yellow-400' };
      return { label: 'Final State', color: 'bg-gray-100 text-gray-600 dark:bg-gray-500/20 dark:text-gray-400' };
    }
    return { label: `Turn ${screenshots[index]?.turn_number ?? index}`, color: 'bg-gray-100 text-gray-600 dark:bg-gray-500/20 dark:text-gray-400' };
  };

  const currentCategory = getScreenshotCategory(selectedScreenshot, screenshots.length);

  const statusColor: Record<string, string> = {
    passed: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400',
    failed: 'bg-red-50 text-red-600 dark:bg-red-500/20 dark:text-red-400',
    running: 'bg-blue-50 text-blue-600 dark:bg-blue-500/20 dark:text-blue-400 animate-pulse',
    error: 'bg-orange-50 text-orange-600 dark:bg-orange-500/20 dark:text-orange-400',
    timeout: 'bg-yellow-50 text-yellow-600 dark:bg-yellow-500/20 dark:text-yellow-400',
    queued: 'bg-gray-100 text-gray-600 dark:bg-gray-500/20 dark:text-gray-400',
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <a href="/" className="text-gray-500 hover:text-gray-300 text-sm">&larr; Back</a>
          <h2 className="text-xl font-bold text-gray-50">{run.test_name}</h2>
          <span className={`text-xs px-3 py-1 rounded-full ${statusColor[run.status] ?? 'bg-gray-700'}`}>
            {run.status.toUpperCase()}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {!isActive && run.status !== 'queued' && (
            <>
              <button
                onClick={async () => {
                  setRerunning(true);
                  try {
                    const res = await fetch(`${API}/api/tests/${run.test_id}/run`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ headless: true }),
                    });
                    const data = await res.json();
                    // Navigate to the new run's detail page
                    if (data.testRunId) {
                      window.location.href = `/runs/${data.testRunId}`;
                    } else if (data.suiteRunId) {
                      // Fallback: reload current page after a delay
                      window.location.href = '/';
                    }
                  } catch (err) {
                    console.error('Failed to re-run:', err);
                    setRerunning(false);
                  }
                }}
                disabled={rerunning}
                className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium rounded-lg text-sm transition-colors"
              >
                {rerunning ? 'Starting...' : 'Re-Test'}
              </button>
              <a
                href={`${API}/api/runs/${runId}/report`}
                download
                className="px-5 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium rounded-lg text-sm transition-colors"
              >
                Export Report
              </a>
            </>
          )}
          {isActive && (
            <button
              onClick={async () => {
                setAborting(true);
                try {
                  await fetch(`${API}/api/runs/${runId}/abort`, { method: 'POST' });
                  const res = await fetch(`${API}/api/runs/${runId}`);
                  if (res.ok) setRun(await res.json());
                } catch (err) {
                  console.error('Failed to abort:', err);
                } finally {
                  setAborting(false);
                }
              }}
              disabled={aborting}
              className="px-5 py-2 bg-red-600 hover:bg-red-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium rounded-lg text-sm transition-colors"
            >
              {aborting ? 'Stopping...' : 'Stop Test'}
            </button>
          )}
        </div>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-6 gap-3">
        <MiniStat label="Duration" value={run.duration_ms ? `${(run.duration_ms / 1000).toFixed(1)}s` : isActive ? `${elapsed}s` : '...'} />
        <MiniStat label="Turns" value={String(run.turn_count)} />
        <MiniStat label="Screenshots" value={String(screenshots.length)} />
        <MiniStat label="Input Tokens" value={run.input_tokens.toLocaleString()} />
        <MiniStat label="Output Tokens" value={run.output_tokens.toLocaleString()} />
        <MiniStat label="Reasoning" value={run.reasoning_tokens.toLocaleString()} />
      </div>

      {/* ── Token Usage Breakdown ─────────────────────────────── */}
      {(run.turnTokens?.length > 0 || run.input_tokens > 0) && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <button
            onClick={() => setShowTokens(!showTokens)}
            className="w-full flex items-center justify-between px-5 py-3 hover:bg-gray-800 transition-colors"
          >
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-semibold text-gray-50">Token Usage Breakdown</h3>
              <span className="text-xs text-gray-500">
                Total: {((run.input_tokens + run.output_tokens) / 1000).toFixed(1)}k tokens
              </span>
            </div>
            <svg className={`w-4 h-4 text-gray-500 transition-transform ${showTokens ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {showTokens && (
            <div className="border-t border-gray-800">
              {/* Summary bar */}
              <div className="grid grid-cols-4 gap-4 px-5 py-3 bg-gray-800/50">
                <div>
                  <div className="text-xs text-gray-500">Total Input</div>
                  <div className="text-sm font-semibold text-blue-400">{(run.input_tokens / 1000).toFixed(1)}k</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">Total Output</div>
                  <div className="text-sm font-semibold text-emerald-400">{(run.output_tokens / 1000).toFixed(1)}k</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">Reasoning</div>
                  <div className="text-sm font-semibold text-amber-400">{(run.reasoning_tokens / 1000).toFixed(1)}k</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">Avg per Turn</div>
                  <div className="text-sm font-semibold text-gray-300">
                    {run.turn_count > 0 ? ((run.input_tokens + run.output_tokens) / run.turn_count / 1000).toFixed(1) + 'k' : '--'}
                  </div>
                </div>
              </div>
              {/* Per-turn table */}
              {run.turnTokens?.length > 0 && (
                <div className="max-h-[300px] overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-gray-900">
                      <tr className="text-gray-500 border-b border-gray-800">
                        <th className="text-left py-2 px-4 font-medium">Turn</th>
                        <th className="text-right py-2 px-4 font-medium">Input</th>
                        <th className="text-right py-2 px-4 font-medium">Output</th>
                        <th className="text-right py-2 px-4 font-medium">Reasoning</th>
                        <th className="text-right py-2 px-4 font-medium">Total</th>
                        <th className="text-right py-2 px-4 font-medium">API Latency</th>
                        <th className="text-right py-2 px-4 font-medium">Cumulative</th>
                      </tr>
                    </thead>
                    <tbody>
                      {run.turnTokens.map((tt) => {
                        const turnTotal = tt.input_tokens + tt.output_tokens;
                        const cumTotal = tt.cumulative_input + tt.cumulative_output;
                        // Highlight expensive turns (> 2x average)
                        const avgPerTurn = run.turn_count > 0 ? (run.input_tokens + run.output_tokens) / run.turn_count : 0;
                        const isExpensive = turnTotal > avgPerTurn * 2;
                        return (
                          <tr key={tt.id} className={`border-b border-gray-800/50 ${isExpensive ? 'bg-amber-500/5' : 'hover:bg-gray-800/30'}`}>
                            <td className="py-2 px-4 text-gray-300 font-mono">T{tt.turn_number}</td>
                            <td className="py-2 px-4 text-right text-blue-400 font-mono">{(tt.input_tokens / 1000).toFixed(1)}k</td>
                            <td className="py-2 px-4 text-right text-emerald-400 font-mono">{(tt.output_tokens / 1000).toFixed(1)}k</td>
                            <td className="py-2 px-4 text-right text-amber-400 font-mono">{tt.reasoning_tokens > 0 ? (tt.reasoning_tokens / 1000).toFixed(1) + 'k' : '-'}</td>
                            <td className="py-2 px-4 text-right text-gray-300 font-mono font-semibold">{(turnTotal / 1000).toFixed(1)}k</td>
                            <td className="py-2 px-4 text-right text-gray-500 font-mono">{(tt.api_latency_ms / 1000).toFixed(1)}s</td>
                            <td className="py-2 px-4 text-right text-gray-500 font-mono">{(cumTotal / 1000).toFixed(1)}k</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Main Content: Screenshots + Events */}
      <div className="grid grid-cols-3 gap-6">
        {/* Screenshot / Video Viewer */}
        <div className="col-span-2 space-y-4">
          {/* View Mode Toggle */}
          {hasVideo && (
            <div className="flex gap-2">
              <button
                onClick={() => setViewMode('screenshots')}
                className={`px-4 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                  viewMode === 'screenshots'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:text-gray-200'
                }`}
              >
                Screenshots
              </button>
              <button
                onClick={() => setViewMode('video')}
                className={`px-4 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                  viewMode === 'video'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:text-gray-200'
                }`}
              >
                Replay Video
              </button>
            </div>
          )}

          {/* Video Player */}
          {viewMode === 'video' && hasVideo && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <video
                src={`${API}/api/runs/${runId}/video`}
                controls
                className="w-full"
                autoPlay
              />
            </div>
          )}

          {/* Full-size screenshot */}
          {viewMode === 'screenshots' && (<>
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            {currentScreenshot && screenshotFilename ? (
              <>
                <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${currentCategory.color}`}>
                      {currentCategory.label}
                    </span>
                    <span className="text-xs text-gray-500">
                      Turn {currentScreenshot.turn_number} of {screenshots.length - 1}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-500">
                    {currentScreenshot.page_title && <span>{currentScreenshot.page_title}</span>}
                    {currentScreenshot.page_url && (
                      <span className="text-gray-600 truncate max-w-xs">{currentScreenshot.page_url}</span>
                    )}
                  </div>
                </div>
                <img
                  src={`${API}/api/runs/${runId}/screenshots/${screenshotFilename}`}
                  alt={`Turn ${currentScreenshot.turn_number}`}
                  className="w-full max-h-[500px] object-contain bg-black"
                />
              </>
            ) : (
              <div className="h-64 flex items-center justify-center text-gray-600">
                {isActive ? 'Waiting for screenshots...' : 'No screenshots'}
              </div>
            )}
          </div>

          {/* Thumbnail strip */}
          {screenshots.length > 0 && (
            <div className="flex gap-2 overflow-x-auto pb-2">
              {screenshots.map((ss, i) => {
                const fname = ss.file_path.split(/[\\\/]/).pop();
                const cat = getScreenshotCategory(i, screenshots.length);
                const isFailure = i === screenshots.length - 1 && (run.status === 'failed' || run.status === 'error');
                return (
                  <button
                    key={ss.id}
                    onClick={() => setSelectedScreenshot(i)}
                    className={`flex-shrink-0 w-28 rounded-lg overflow-hidden border-2 transition-colors ${
                      i === selectedScreenshot ? 'border-indigo-500'
                        : isFailure ? 'border-red-300 hover:border-red-400 dark:border-red-500/50 dark:hover:border-red-400'
                        : 'border-gray-200 hover:border-gray-400 dark:border-gray-800 dark:hover:border-gray-600'
                    }`}
                  >
                    <img
                      src={`${API}/api/runs/${runId}/screenshots/${fname}`}
                      alt={`Turn ${ss.turn_number}`}
                      className="w-full h-16 object-cover"
                    />
                    <div className="px-1 py-0.5 text-center bg-gray-800">
                      <span className={`text-[10px] ${isFailure ? 'text-red-400' : i === 0 ? 'text-blue-400' : 'text-gray-500'}`}>
                        {i === 0 ? 'Initial' : i === screenshots.length - 1 ? cat.label.split(' - ')[0] : `T${ss.turn_number}`}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          </>)}

          {/* Model Verdict */}
          {run.model_verdict && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-gray-400 mb-3">Model Verdict</h3>
              <pre className="text-sm text-gray-300 whitespace-pre-wrap font-mono leading-relaxed">
                {run.model_verdict}
              </pre>
            </div>
          )}

          {/* Error */}
          {run.error && (
            <div className="bg-red-100 dark:bg-red-950/30 border border-red-300 dark:border-red-800/30 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-red-700 dark:text-red-400 mb-2">Error</h3>
              <pre className="text-sm text-red-600 dark:text-red-300 whitespace-pre-wrap font-mono">{run.error}</pre>
            </div>
          )}
        </div>

        {/* Event Log */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 max-h-[360px] overflow-y-auto">
          <h3 className="text-sm font-semibold text-gray-400 mb-4">Event Log</h3>
          <div className="space-y-3">
            {events.map(event => (
              <div key={event.id} className="text-xs">
                <div className="text-gray-600 font-mono">
                  {new Date(event.timestamp).toLocaleTimeString()}
                </div>
                <div className="text-gray-300 mt-0.5">{event.message}</div>
              </div>
            ))}
            {isActive && (
              <div className="text-xs text-blue-400 animate-pulse">Waiting for events...</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 text-center">
      <div className="text-sm font-bold text-gray-50">{value}</div>
      <div className="text-xs text-gray-500 mt-0.5">{label}</div>
    </div>
  );
}
