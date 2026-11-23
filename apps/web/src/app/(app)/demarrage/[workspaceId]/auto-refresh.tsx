'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** Recharge l'étape pendant que la rédaction tourne en tâche de fond. */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(timer);
  }, [router, seconds]);
  return null;
}
