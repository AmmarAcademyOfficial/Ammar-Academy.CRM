import { AccountingPage } from "@/features/accounting/accounting-page";
import { pageFor } from "@/server/pages";

export default async function Page() {
  await pageFor("manager", "accountant");
  return <AccountingPage />;
}
