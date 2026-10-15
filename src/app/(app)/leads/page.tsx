import { LeadsPage } from "@/features/leads/leads-page";
import { pageFor } from "@/server/pages";

export default async function Page() {
  await pageFor("manager", "sales");
  return <LeadsPage />;
}
