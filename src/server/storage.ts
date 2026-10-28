import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { supabaseAdmin } from "@/lib/supabase/server";
import { signValue, verifySignature } from "./crypto";
import { asSystem } from "./db";
import { env } from "./env";

/**
 * Private file storage for payment receipts.
 *  - local review: files in RECEIPTS_DIR on this computer;
 *  - production: the private Supabase Storage bucket "receipts", reached only with the server key.
 * Files are never public. They are opened through /api/receipts/<payment id>, which checks
 * that the signed-in person may see that payment.
 */

export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
const TYPES = [
  { mime: "image/jpeg", ext: "jpg", test: (b: Buffer) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/png", ext: "png", test: (b: Buffer) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/webp", ext: "webp", test: (b: Buffer) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
  { mime: "application/pdf", ext: "pdf", test: (b: Buffer) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
] as const;

/** Identifies a receipt by its content (not its name or the browser's claim). */
export function sniffReceipt(bytes: Buffer): { mime: string; ext: string } | null {
  const t = TYPES.find((x) => x.test(bytes));
  return t ? { mime: t.mime, ext: t.ext } : null;
}

function mode(): "local" | "supabase" {
  const e = env();
  return e.STORAGE_MODE ?? (e.AUTH_MODE === "local" ? "local" : "supabase");
}

function localPath(path: string): string {
  const base = resolve(env().RECEIPTS_DIR);
  const full = resolve(base, path.replace(/^receipts\//, ""));
  if (!full.startsWith(base)) throw new Error("Invalid path");
  return full;
}

export async function putReceipt(bytes: Buffer, ext: string, mime: string): Promise<string> {
  const path = `receipts/${randomUUID()}.${ext}`;
  if (mode() === "local") {
    await mkdir(resolve(env().RECEIPTS_DIR), { recursive: true });
    await writeFile(localPath(path), bytes, { mode: 0o600 });
  } else {
    const { error } = await supabaseAdmin().storage.from("receipts").upload(path.replace(/^receipts\//, ""), bytes, { contentType: mime, upsert: false });
    if (error) throw new Error(`Could not store the receipt: ${error.message}`);
  }
  return path;
}

export async function getReceipt(path: string): Promise<Buffer> {
  if (mode() === "local") return readFile(localPath(path));
  const { data, error } = await supabaseAdmin().storage.from("receipts").download(path.replace(/^receipts\//, ""));
  if (error || !data) throw new Error("Receipt not found");
  return Buffer.from(await data.arrayBuffer());
}

// ── Upload tokens ────────────────────────────────────────────────────────
// After an upload the browser gets a signed token describing the stored file. Submitting a
// payment sends the token back; the server checks the signature, the uploader and the age, so
// nobody can attach a file path they did not upload themselves.

export interface ReceiptRef {
  path: string;
  name: string;
  mime: string;
  size: number;
}

export function receiptToken(ref: ReceiptRef, userId: string): string {
  const body = Buffer.from(JSON.stringify({ ...ref, uid: userId, exp: Date.now() + 6 * 3600_000 })).toString("base64url");
  return `${body}.${signValue(body)}`;
}

export function readReceiptToken(token: string, userId: string): ReceiptRef | null {
  const [body, sig] = token.split(".");
  if (!body || !sig || !verifySignature(body, sig)) return null;
  const v = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ReceiptRef & { uid: string; exp: number };
  if (v.uid !== userId || v.exp < Date.now()) return null;
  return { path: v.path, name: v.name, mime: v.mime, size: v.size };
}


// ── Clean-up ─────────────────────────────────────────────────────────────
// A receipt uploaded in the payment dialog but never submitted is not linked to any payment.
// A day after upload (long after its 6-hour upload token expired) nobody can attach it, so it is deleted.
// Linked receipts (including those of deleted payments that can still be restored) are never touched. Runs from the scheduler about once an hour.

const ORPHAN_AFTER_MS = 24 * 3600_000;

export async function cleanupOrphanReceipts(now = Date.now()): Promise<{ checked: number; deleted: number }> {
  const linked = new Set(
    // Receipts of deleted payments stay until the deleted record is removed for good (30 days), so a restore keeps them.
    (await asSystem((tx) => tx<{ p: string }[]>`select receipt_path as p from public.payments where receipt_path is not null
                                               union select private.deleted_receipts()`)).map((r) => r.p),
  );
  let checked = 0;
  let deleted = 0;
  if (mode() === "local") {
    const dir = resolve(env().RECEIPTS_DIR);
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      return { checked, deleted };
    }
    for (const name of names) {
      if (!/^[0-9a-f-]{36}\.(jpg|png|webp|pdf)$/.test(name)) continue;
      checked++;
      const path = `receipts/${name}`;
      if (linked.has(path)) continue;
      const s = await stat(localPath(path));
      if (now - s.mtimeMs > ORPHAN_AFTER_MS) {
        await unlink(localPath(path));
        deleted++;
      }
    }
    return { checked, deleted };
  }
  const bucket = supabaseAdmin().storage.from("receipts");
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await bucket.list("", { limit: 1000, offset, sortBy: { column: "created_at", order: "asc" } });
    if (error) throw new Error(`Could not list receipts: ${error.message}`);
    if (!data?.length) break;
    const stale = data.filter((f) => {
      checked++;
      return !linked.has(`receipts/${f.name}`) && f.created_at && now - new Date(f.created_at).getTime() > ORPHAN_AFTER_MS;
    }).map((f) => f.name);
    if (stale.length) {
      const { error: delError } = await bucket.remove(stale);
      if (delError) throw new Error(`Could not delete unused receipts: ${delError.message}`);
      deleted += stale.length;
    }
    if (data.length < 1000) break;
  }
  return { checked, deleted };
}
