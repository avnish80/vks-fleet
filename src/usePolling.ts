import React from 'react';

/**
 * Runs `load` now and every `seconds`, keeping the latest result. `key`
 * decides when to start over (e.g. a different machine); pass null to pause.
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
    const run = async () => {
      if (running) return;
      running = true;
      try {
        const v = await loadRef.current();
        if (!cancelled) setValue(v);
      } finally {
        running = false;
      }
    };
    run();
    const timer = window.setInterval(run, seconds * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [key, seconds]);

  return value;
}
