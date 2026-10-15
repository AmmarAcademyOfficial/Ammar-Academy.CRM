import "server-only";
import { z } from "zod";

/**
 * Server configuration, validated once. Secrets never reach the browser:
 * only NEXT_PUBLIC_* values are bundled for the client.
 */
const schema = z.object({
  DATABASE_URL: z.string().url(),
  AUTH_MODE: z.enum(["supabase", "local"]).default("supabase"),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().optional(),
  SUPABASE_SECRET_KEY: z.string().optional(),
  LOCAL_AUTH_SECRET: z.string().min(16).default("local-development-only-secret"),
  APP_URL: z.string().url().optional(),
  // Google Sheets (Phase 3). "fake" = built-in simulated Google for local review and tests.
  GOOGLE_MODE: z.enum(["real", "fake", "off"]).default("off"),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_PICKER_API_KEY: z.string().optional(),
  GOOGLE_PROJECT_NUMBER: z.string().regex(/^\d+$/).optional(),
  // 32 random bytes, base64. Encrypts stored Google refresh tokens.
  TOKEN_ENCRYPTION_KEY: z.string().optional(),
  FAKE_GOOGLE_FILE: z.string().default(".local/fake-google.json"),
  // Where receipts are stored: "local" folder (review) or the private Supabase Storage bucket "receipts".
  STORAGE_MODE: z.enum(["local", "supabase"]).optional(),
  RECEIPTS_DIR: z.string().default(".local/receipts"),
  // Shared secret the scheduler sends to /api/cron/tick.
  CRON_SECRET: z.string().min(24).optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Server configuration is incomplete or invalid: ${missing}. See .env.example.`);
  }
  const e = parsed.data;
  if (e.AUTH_MODE === "supabase" && (!e.NEXT_PUBLIC_SUPABASE_URL || !e.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)) {
    throw new Error("AUTH_MODE=supabase needs NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.");
  }
  if (e.AUTH_MODE === "local" && !isLocalDatabase(e.DATABASE_URL)) {
    // Local sign-in skips passwords. It must never run against a real database.
    throw new Error("AUTH_MODE=local is only allowed when DATABASE_URL points at localhost.");
  }
  if (e.GOOGLE_MODE === "fake" && !isLocalDatabase(e.DATABASE_URL)) {
    throw new Error("GOOGLE_MODE=fake is only allowed when DATABASE_URL points at localhost.");
  }
  const storage = e.STORAGE_MODE ?? (e.AUTH_MODE === "local" ? "local" : "supabase");
  if (e.AUTH_MODE === "supabase" && storage === "local") {
    // Hosting platforms wipe local disks; receipts must live in the private Storage bucket.
    throw new Error("STORAGE_MODE=local is only for local review. Use STORAGE_MODE=supabase with real sign-in.");
  }
  if (storage === "supabase" && (!e.SUPABASE_SECRET_KEY || !e.NEXT_PUBLIC_SUPABASE_URL)) {
    throw new Error("STORAGE_MODE=supabase needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (server only).");
  }
  if (e.GOOGLE_MODE === "real") {
    const missing = (["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_PICKER_API_KEY", "GOOGLE_PROJECT_NUMBER", "TOKEN_ENCRYPTION_KEY", "APP_URL"] as const).filter((k) => !e[k]);
    if (missing.length) throw new Error(`GOOGLE_MODE=real needs ${missing.join(", ")}. See docs/GOOGLE_SHEETS_CONNECTION.md.`);
  }
  cached = e;
  return e;
}

export function isLocalDatabase(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}
