"use client";

import {
  EMPTY_SESSION,
  type AssistantSession,
  type ChatMessage,
  type ToolEvent,
} from "@/services/assistant/session";
import Link from "next/link";
import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";

const STORAGE_KEY = "medicare-assistant-chat";
const HISTORY_SENT = 30;

const STARTERS = [
  "Compare these for ZIP 60601:\nDORZOLAMIDE HCL 2% EYE DROPS INSTILL 1 DROP INTO BOTH EYES TWICE A DAY\nfreestyle\nmetformin 500 mg twice daily",
  "What strengths does Eliquis come in?",
  "Remember: always include mail order when comparing.",
  "What have you learned so far?",
];

interface Saved {
  messages: ChatMessage[];
  session: AssistantSession;
}

export function AssistantChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [session, setSession] = useState<AssistantSession>(EMPTY_SESSION);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void Promise.resolve().then(() => {
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Saved | null;
        if (saved?.messages) setMessages(saved.messages);
        if (saved?.session) setSession({ ...EMPTY_SESSION, ...saved.session });
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (!loaded) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ messages, session } satisfies Saved));
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, session, loaded]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    const next = [...messages, { role: "user" as const, text: trimmed }];
    setMessages(next);
    setInput("");
    setError("");
    setBusy(true);
    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next.slice(-HISTORY_SENT), session }),
      });
      const data = (await response.json()) as {
        reply?: string;
        events?: ToolEvent[];
        session?: AssistantSession;
        error?: string;
      };
      if (data.session) setSession(data.session);
      if (!response.ok || !data.reply) {
        setError(data.error ?? "The assistant could not answer. Try again.");
        return;
      }
      setMessages([...next, { role: "assistant", text: data.reply, events: data.events ?? [] }]);
    } catch {
      setError("The assistant could not be reached. Check that the app is still running.");
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void send(input);
  }

  function newChat() {
    setMessages([]);
    setSession(EMPTY_SESSION);
    setError("");
  }

  return (
    <main className="mx-auto grid max-w-[1200px] gap-6 px-4 py-8 sm:px-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <section className="flex min-h-[80vh] flex-col">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <header>
            <p className="text-sm font-medium tracking-wide text-[var(--accent)]">Licensed agent planning tool</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">Medicare assistant</h1>
            <p className="mt-2 text-sm text-stone-700">
              Paste a medication list, give a ZIP code, ask questions, or teach it how you work.
            </p>
          </header>
          <div className="flex gap-2">
            <Link href="/" className="rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm font-medium">
              Comparison form
            </Link>
            <button
              type="button"
              onClick={newChat}
              className="rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm font-medium"
            >
              New chat
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-4 rounded-2xl border border-[var(--line)] bg-[var(--card)] p-4 shadow-sm">
          {messages.length === 0 ? (
            <div className="space-y-2">
              <p className="text-sm text-stone-600">Try one of these:</p>
              {STARTERS.map((starter) => (
                <button
                  key={starter}
                  type="button"
                  onClick={() => setInput(starter)}
                  className="block w-full whitespace-pre-line rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-left text-sm hover:border-[var(--accent)]"
                >
                  {starter}
                </button>
              ))}
            </div>
          ) : null}
          {messages.map((message, index) => (
            <Bubble key={index} message={message} />
          ))}
          {busy ? (
            <p className="text-sm text-stone-500">
              Working… Medicare.gov proofs take one to three minutes.
            </p>
          ) : null}
          {error ? <p className="text-sm text-[var(--warn)]">{error}</p> : null}
          <div ref={bottom} />
        </div>

        <form onSubmit={onSubmit} className="mt-4 flex gap-2">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send(input);
              }
            }}
            rows={3}
            placeholder="Type a message. Shift+Enter for a new line."
            className="flex-1 rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={busy || input.trim().length === 0}
            className="self-end rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            Send
          </button>
        </form>
      </section>

      <SessionPanel session={session} />
    </main>
  );
}

function Bubble({ message }: { message: ChatMessage }) {
  const mine = message.role === "user";
  return (
    <div className={mine ? "flex justify-end" : "space-y-2"}>
      <div
        className={
          mine
            ? "max-w-[85%] whitespace-pre-wrap rounded-xl bg-[var(--accent)] px-3 py-2 text-sm text-white"
            : "max-w-[95%] whitespace-pre-wrap text-sm leading-6"
        }
      >
        {mine ? message.text : <Formatted text={message.text} />}
      </div>
      {message.events && message.events.length > 0 ? <Events events={message.events} /> : null}
    </div>
  );
}

/** Renders the small slice of markdown Gemini uses: headings, bullets, rules and bold. */
function Formatted({ text }: { text: string }) {
  const lines = text.split("\n");
  return lines.map((line, index) => {
    const end = index < lines.length - 1 ? "\n" : "";
    if (/^\s*(?:\*\s*){3,}$|^\s*-{3,}\s*$/.test(line)) return <hr key={index} className="my-2 border-[var(--line)]" />;
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      return (
        <strong key={index} className="block pt-1">
          {inline(heading[1])}
        </strong>
      );
    }
    const bullet = line.match(/^(\s*)[*-]\s+(.*)$/);
    if (bullet) {
      return (
        <Fragment key={index}>
          {bullet[1]}• {inline(bullet[2])}
          {end}
        </Fragment>
      );
    }
    return (
      <Fragment key={index}>
        {inline(line)}
        {end}
      </Fragment>
    );
  });
}

function inline(text: string) {
  return text.split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g).map((piece, index) => {
    if (piece.startsWith("**") && piece.endsWith("**")) return <strong key={index}>{piece.slice(2, -2)}</strong>;
    if (piece.length > 2 && piece.startsWith("*") && piece.endsWith("*")) return <em key={index}>{piece.slice(1, -1)}</em>;
    return <Fragment key={index}>{piece}</Fragment>;
  });
}

function Events({ events }: { events: ToolEvent[] }) {
  const images = events.flatMap((event) => event.images ?? []);
  const link = events.find((event) => event.link)?.link;
  return (
    <div className="space-y-2">
      <details className="rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-xs text-stone-600">
        <summary className="cursor-pointer">
          {events.length} step{events.length === 1 ? "" : "s"}
        </summary>
        <ul className="mt-2 space-y-1">
          {events.map((event, index) => (
            <li key={index} className={event.ok ? "" : "text-[var(--warn)]"}>
              {event.summary}
            </li>
          ))}
        </ul>
      </details>
      {images.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {images.map((image) => (
            <a key={image.src} href={image.src} target="_blank" rel="noreferrer" className="block">
              {/* eslint-disable-next-line @next/next/no-img-element -- proof screenshots are local files of unknown size */}
              <img src={image.src} alt={image.label} className="rounded-lg border border-[var(--line)]" />
              <span className="text-xs text-stone-600">{image.label}</span>
            </a>
          ))}
        </div>
      ) : null}
      {link ? (
        <a href={link} target="_blank" rel="noreferrer" className="text-xs text-[var(--accent)] underline">
          Open on Medicare.gov
        </a>
      ) : null}
    </div>
  );
}

function SessionPanel({ session }: { session: AssistantSession }) {
  return (
    <aside className="h-fit space-y-4 rounded-2xl border border-[var(--line)] bg-[var(--card)] p-4 text-sm shadow-sm lg:sticky lg:top-6">
      <div>
        <p className="font-semibold">Location</p>
        <p className="text-stone-700">
          {session.county ? `${session.county.name}, ${session.county.state} · ${session.zipCode}` : "Not set"}
        </p>
      </div>
      <div>
        <p className="font-semibold">Medications</p>
        {session.medications.length === 0 ? (
          <p className="text-stone-700">None yet</p>
        ) : (
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-stone-700">
            {session.medications.map((item) => (
              <li key={item.drug.id}>
                {item.drug.name} {item.drug.strength}
                <span className="block text-xs text-stone-500">
                  {item.drug.dosageFormLabel ?? item.drug.dosageForm} · qty {item.drug.quantityPerFill}
                  {item.drug.rxcui || item.drug.isSupply ? "" : " · needs a choice"}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div>
        <p className="font-semibold">Options</p>
        <p className="text-stone-700">
          {session.pharmacyIds.join(", ")} · {session.contractYear} · {session.planType}
          {session.lisLevel !== "LIS_NONE" ? ` · ${session.lisLevel}` : ""}
        </p>
      </div>
    </aside>
  );
}
