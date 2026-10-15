import { OverviewPage } from "@/features/manager/overview-page";
import { pageFor } from "@/server/pages";

export default async function Page() {
  await pageFor("manager");
  return <OverviewPage />;
}
