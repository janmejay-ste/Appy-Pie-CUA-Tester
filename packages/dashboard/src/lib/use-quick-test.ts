'use client';
import { useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL || '';

export function useQuickTest() {
  const [promptText, setPromptText] = useState('');
  const [promptUrl, setPromptUrl] = useState('');
  const [promptRunning, setPromptRunning] = useState(false);

  const runPromptTest = async (opts?: { headless?: boolean }): Promise<string | null> => {
    if (!promptText.trim()) return null;
    setPromptRunning(true);
    try {
      const res = await fetch(`${API}/api/tests/prompt-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: promptText.trim(),
          url: promptUrl.trim() || undefined,
          headless: opts?.headless,
        }),
      });
      if (!res.ok) throw new Error('Failed to start test');
      const data = await res.json();
      return data.testRunId;
    } finally {
      setPromptRunning(false);
    }
  };

  return { promptText, setPromptText, promptUrl, setPromptUrl, promptRunning, runPromptTest };
}
