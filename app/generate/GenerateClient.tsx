"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import GuideView from "@/components/GuideView";
import type { Guide } from "@/lib/schema";
import type { ProgressEvent } from "@/lib/agent/types";

type Line = { kind: "stage" | "fetch" | "warning"; text: string; ok?: boolean };

export default function GenerateClient({ query }: { query: string }) {
  const router = useRouter();
  const [lines, setLines] = useState<Line[]>([]);
  const [guide, setGuide] = useState<Guide | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(true);
  const started = useRef(false);

  // No AbortController here on purpose: Strict Mode runs effects twice in dev, and
  // aborting on the simulated unmount would kill the single run the ref guard allows.
  // Letting it finish also avoids paying for a generation that gets thrown away.
  useEffect(() => {
    if (started.current) return;
    started.current = true;

    (async () => {
      try {
        const response = await fetch(`/api/generate?q=${encodeURIComponent(query)}`);
        if (!response.ok || !response.body) {
          setError((await response.text()) || `Request failed (${response.status})`);
          setRunning(false);
          return;
        }

        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += value;

          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            const payload = frame.replace(/^data: /, "").trim();
            if (!payload) continue;

            const event = JSON.parse(payload) as ProgressEvent;
            if (event.type === "done") {
              setGuide(event.guide);
              // Only hand off to the guide page when the guide is actually there.
              // Redirecting to an unsaved slug lands the reader on a 404 right
              // after watching it work.
              if (event.saved !== false) {
                router.replace(`/guides/${event.guide.slug}`);
              }
            } else if (event.type === "error") {
              setError(event.message);
            } else if (event.type === "fetch") {
              setLines((prev) => [
                ...prev,
                { kind: "fetch", text: event.url, ok: event.ok },
              ]);
            } else {
              setLines((prev) => [...prev, { kind: event.type, text: event.message }]);
            }
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Generation failed.");
      } finally {
        setRunning(false);
      }
    })();
  }, [query, router]);

  return (
    <main className="mx-auto max-w-2xl px-5 py-16">
      {!guide && (
        <>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-3">
            Researching
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink">
            {query}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-2">
            Reading official documentation and labelling each claim with its
            evidence. Usually under two minutes.
          </p>
          <ol className="mt-6 space-y-2 border-l border-edge pl-4 text-sm">
            {lines.map((line, i) => (
              <li key={i} className="relative flex gap-2.5">
                <span
                  aria-hidden
                  className={`absolute -left-[21px] top-1.5 size-1.5 rounded-full ${
                    line.kind === "warning"
                      ? "bg-warn"
                      : line.kind === "fetch"
                        ? line.ok === false
                          ? "bg-risk"
                          : line.ok
                            ? "bg-ok"
                            : "bg-edge-strong"
                        : "bg-accent"
                  }`}
                />
                <span
                  className={
                    line.kind === "warning"
                      ? "text-warn"
                      : line.kind === "fetch"
                        ? `break-all font-mono text-xs ${line.ok === false ? "text-ink-3 line-through" : "text-ink-2"}`
                        : "text-ink-2"
                  }
                >
                  {line.text}
                </span>
              </li>
            ))}
          </ol>
          {running && (
            <p className="mt-5 flex items-center gap-2 text-sm text-ink-3">
              <span className="size-1.5 animate-pulse rounded-full bg-accent" />
              Working…
            </p>
          )}
        </>
      )}

      {error && (
        <div className="mt-6 rounded-lg border border-risk/30 bg-risk-soft p-4 text-sm leading-relaxed text-risk">
          {error}
        </div>
      )}

      {guide && (
        <section className="mt-8 border-t border-edge pt-8">
          <GuideView guide={guide} />
        </section>
      )}
    </main>
  );
}
