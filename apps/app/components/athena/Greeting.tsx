"use client";

import { useEffect, useState } from "react";

/** "Good morning, Sean." in the viewer's local time (computed after mount). */
export function Greeting({ name }: { name?: string | null }) {
  const [part, setPart] = useState<string | null>(null);
  useEffect(() => {
    const h = new Date().getHours();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPart(h < 12 ? "morning" : h < 18 ? "afternoon" : "evening");
  }, []);
  const who = name ? `, ${name}` : "";
  return <>{part ? `Good ${part}${who}.` : `Hello${who}.`}</>;
}
