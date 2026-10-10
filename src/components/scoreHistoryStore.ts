import { ConfigStore } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import { dayOf, demoHistory, recordPoint, ScoreHistory, ScorePoint, trendPoints } from '../scoreHistory';
import { useRawSettings } from '../settings/store';

// Kept in this browser only. Demo mode keeps its own history, so a demo never draws a real fleet's trend (or the other way round).
const realStore = new ConfigStore<ScoreHistory>('vks-fleet-history');
const demoStore = new ConfigStore<ScoreHistory>('vks-fleet-history-demo');
const useReal = realStore.useConfig();
const useDemo = demoStore.useConfig();

/**
 * The score's history for one scope (Supervisor filter and org), and today's
 * point recorded into it once the page has everything the score depends on.
 * `points` are the trend's points, oldest first; `stored` is everything this
 * browser has for the scope (for "since your last visit").
 */
export function useScoreHistory(scope: string, ready: boolean, score: number | undefined, blocks: Record<string, number>): { today: string; points: ScorePoint[]; stored: ScorePoint[] } {
  const demo = useRawSettings().demo === true;
  const real = useReal();
  const made = useDemo();
  const store = demo ? demoStore : realStore;
  const history = ((demo ? made : real) ?? {}) as ScoreHistory;
  const today = dayOf(new Date());
  const numbers = JSON.stringify(blocks);

  React.useEffect(() => {
    if (!ready || score === undefined) return;
    const next = recordPoint(history, scope, { d: today, s: score, b: JSON.parse(numbers) });
    if (next !== history) store.set(next);
  }, [ready, score, scope, today, numbers, demo]);

  const stored = history[scope] ?? [];
  // The demo fleet comes with a month behind it, ending at today's score.
  const shown = demo && score !== undefined ? demoHistory(score, today, stored) : stored;
  return { today, points: trendPoints(shown, today), stored: shown };
}
