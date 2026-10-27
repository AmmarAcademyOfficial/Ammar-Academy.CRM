import { SessionsPage } from "@/features/sessions/sessions-page";
import { pageFor } from "@/server/pages";

export default async function Page() {
  await pageFor("manager", "support", "accountant");
  return <SessionsPage />;
}
