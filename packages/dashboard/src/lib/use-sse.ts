'use client';

import { useEffect, useRef, useState } from 'react';

interface SSEEvent {
  id: string;
  type: string;
  message: string;
  detail?: string;
  timestamp: string;
  sequence: number;
}

export function useSSE(url: string | null) {
  const [events, setEvents] = useState<SSEEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!url) return;

    const source = new EventSource(url);
    sourceRef.current = source;
    setConnected(true);

    source.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as SSEEvent;
        if (event.type === 'stream_end') {
          setConnected(false);
          source.close();
          return;
        }
        setEvents(prev => [...prev, event]);
      } catch {
        // ignore malformed events
      }
    };

    source.onerror = () => {
      setConnected(false);
      source.close();
      sourceRef.current = null;
    };

    return () => {
      source.close();
      sourceRef.current = null;
      setConnected(false);
    };
  }, [url]);

  return { events, connected };
}
