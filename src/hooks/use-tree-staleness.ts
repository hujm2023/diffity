import { isRemoteRepo } from '../lib/remote-repo';
import { getRepoPath } from '../lib/api';
import { useEffect, useRef, useState } from 'react';
import { fetchTreeFingerprint } from '../lib/api';
import { useRepoChange } from './use-repo';

export function useTreeStaleness() {
  const [isStale, setIsStale] = useState(false);
  const [generation, setGeneration] = useState(0);
  const baselineRef = useRef<string | null>(null);
  const tick = useRepoChange((state) => state.tick);

  function resetStaleness() {
    baselineRef.current = null;
    setIsStale(false);
    setGeneration((value) => value + 1);
  }

  useEffect(() => {
    if (isRemoteRepo(getRepoPath())) return;
    let cancelled = false;
    fetchTreeFingerprint().then((fingerprint) => {
      if (!cancelled) {
        baselineRef.current = fingerprint;
      }
    }, () => undefined);
    return () => {
      cancelled = true;
    };
  }, [generation]);

  useEffect(() => {
    if (isRemoteRepo(getRepoPath()) || tick === 0) {
      return;
    }
    let cancelled = false;
    fetchTreeFingerprint().then((fingerprint) => {
      if (cancelled || baselineRef.current === null) {
        return;
      }
      if (fingerprint !== baselineRef.current) {
        setIsStale(true);
      }
    }, () => undefined);
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { isStale, resetStaleness };
}
