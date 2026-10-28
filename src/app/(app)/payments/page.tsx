import { PaymentsPage } from "@/features/manager/payments-page";
import { pageFor } from "@/server/pages";

export default async function Page() {
  await pageFor("manager", "accountant");
  return <PaymentsPage />;
}
