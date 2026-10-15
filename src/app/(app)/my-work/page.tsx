import { SalesMyWork } from "@/features/my-work/sales-my-work";
import { SupportMyWork } from "@/features/support/support-pages";
import { pageFor } from "@/server/pages";

export default async function MyWorkPage() {
  const staff = await pageFor("sales", "support");
  return staff.role === "support" ? <SupportMyWork /> : <SalesMyWork />;
}
