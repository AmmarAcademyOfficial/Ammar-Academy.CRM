import { ReportsPage } from "@/features/manager/reports-page";
import { pageFor } from "@/server/pages";

export default async function Page() {
  await pageFor("manager", "accountant");
  return <ReportsPage />;
}
