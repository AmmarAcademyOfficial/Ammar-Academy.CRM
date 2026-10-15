"use client";

/** Last-resort error page if the whole app shell fails to load. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", background: "#f5f6fa", color: "#0e0f3b", display: "grid", placeItems: "center", minHeight: "100dvh", margin: 0, textAlign: "center", padding: 24 }}>
        <div>
          <h1 style={{ fontSize: 20 }}>The CRM could not load</h1>
          <p style={{ color: "#5b5f7a", fontSize: 14 }}>Please try again in a moment.{error.digest ? ` Reference: ${error.digest}` : ""}</p>
          <button onClick={reset} style={{ marginTop: 16, height: 40, padding: "0 16px", borderRadius: 8, border: 0, background: "#0e0f3b", color: "#fff", fontWeight: 600, cursor: "pointer" }}>Try again</button>
        </div>
      </body>
    </html>
  );
}
