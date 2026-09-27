import React from 'react';

/**
 * Runs `load` now and every `seconds`, keeping the latest result. `key`
 * decides when to start over (e.g. a different machine); pass null to pause.
 *
 * At scale: refreshes pause while the browser tab is hidden (and catch up
 * when it's shown again), a failed refresh keeps the last good value instead
 * of throwing, and a little jitter keeps many pollers from firing together.
 */
export function usePolling<T>(key: string | null, load: () => Promise<T>, seconds: number): T | null {
  const [value, setValue] = React.useState<T | null>(null);
  const loadRef = React.useRef(load);
  loadRef.current = load;

  React.useEffect(() => {
    setValue(null);
    if (key === null) return;
    let cancelled = false;
    let running = false;
    let lastRun = 0;
    const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const run = async (force = false) => {
      if (running || (!force && hidden())) return;
      running = true;
      lastRun = Date.now();
      try {
        const v = await loadRef.current();
        if (!cancelled) setValue(v);
      } catch (err) {
        // Keep showing the last good value; the loaders report their own errors in their results.
        console.warn('vks-fleet: refresh failed', err);
      } finally {
        running = false;
      }
    };
    run(true);
    const jitter = Math.floor(Math.random() * Math.min(5, seconds * 0.1) * 1000);
    const timer = window.setInterval(() => run(), seconds * 1000 + jitter);
    const onVisible = () => {
      if (!hidden() && Date.now() - lastRun > seconds * 1000) run();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    };
  }, [key, seconds]);

  return value;
}
