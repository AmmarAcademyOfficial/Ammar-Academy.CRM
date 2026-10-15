import { redirect } from "next/navigation";
import { NewPasswordForm } from "@/features/auth/sign-in";
import { getAuthUserId } from "@/server/auth";

export const metadata = { title: "Choose a password · Ammar Academy CRM" };

/** Reached from an invitation or reset email, after /auth/confirm signed the person in. */
export default async function ResetPasswordPage() {
  if (!(await getAuthUserId())) redirect("/login");
  return <NewPasswordForm />;
}
