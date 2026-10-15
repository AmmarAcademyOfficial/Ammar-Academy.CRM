import { getStaff } from "@/server/auth";
import { MAX_RECEIPT_BYTES, putReceipt, receiptToken, sniffReceipt } from "@/server/storage";

/** Upload a payment receipt (sales and managers). Returns a signed token used when submitting the payment. */
export async function POST(req: Request) {
  const staff = await getStaff();
  if (!staff) return Response.json({ error: "Sign in again." }, { status: 401 });
  if (staff.role === "support") return Response.json({ error: "Only sales and managers submit payments." }, { status: 403 });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "No file received." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return Response.json({ error: "Choose a photo or PDF of the receipt." }, { status: 400 });
  if (file.size > MAX_RECEIPT_BYTES) return Response.json({ error: "The file is larger than 10 MB. Take a smaller photo or a screenshot." }, { status: 400 });
  const bytes = Buffer.from(await file.arrayBuffer());
  const kind = sniffReceipt(bytes);
  if (!kind) return Response.json({ error: "Use a JPG, PNG, WebP photo or a PDF." }, { status: 400 });
  const path = await putReceipt(bytes, kind.ext, kind.mime);
  const name = (file.name || `receipt.${kind.ext}`).replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 120);
  return Response.json({ token: receiptToken({ path, name, mime: kind.mime, size: bytes.length }, staff.id), name, size: bytes.length });
}
