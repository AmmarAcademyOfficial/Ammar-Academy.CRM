import { CustomersPage } from "@/features/support/support-pages";
import { pageFor } from "@/server/pages";

export default async function Page() {
  await pageFor("manager", "support", "accountant");
  return <CustomersPage />;
}
