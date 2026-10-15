import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/server/env";
import { readFakeData } from "@/server/google/fake";

/**
 * Local review only (GOOGLE_MODE=fake): stands in for Google's consent screen
 * so the whole connect flow can be tried and tested without a Google account.
 */
export async function GET(req: NextRequest) {
  if (env().GOOGLE_MODE !== "fake") return new NextResponse("Not found", { status: 404 });
  const state = req.nextUrl.searchParams.get("state") ?? "";
  const accounts = Object.keys(readFakeData(env().FAKE_GOOGLE_FILE).accounts);
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const link = (email: string) => `/api/google/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(`fake-code:${email}`)}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Simulated Google sign-in</title>
<style>body{font-family:system-ui,sans-serif;background:#f1f3f4;margin:0;display:grid;place-items:center;min-height:100vh;color:#202124}
.card{background:#fff;border-radius:12px;padding:32px;max-width:420px;width:calc(100% - 32px);box-shadow:0 1px 3px rgba(0,0,0,.2)}
.tag{display:inline-block;background:#fff4e5;color:#8a4b00;border-radius:6px;padding:4px 8px;font-size:12px;margin-bottom:12px}
ul{padding-left:18px;font-size:14px;line-height:1.6}a.btn{display:block;text-align:center;background:#1a73e8;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;margin-top:8px}
a.cancel{display:block;text-align:center;margin-top:12px;color:#1a73e8;font-size:14px}</style></head>
<body><main class="card"><span class="tag">Simulated for local review — not the real Google</span>
<h1 style="font-size:20px;margin:0 0 8px">Ammar Academy CRM wants to access your Google Account</h1>
<p style="font-size:14px">This will allow the CRM to:</p>
<ul><li>See your email address</li><li>See, edit, create and delete only the specific Google Drive files you use with this app</li></ul>
${accounts.map((a) => `<a class="btn" href="${esc(link(a))}">Allow as ${esc(a)}</a>`).join("")}
<a class="cancel" href="/api/google/callback?state=${encodeURIComponent(state)}&error=access_denied">Cancel</a></main></body></html>`;
  return new NextResponse(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
