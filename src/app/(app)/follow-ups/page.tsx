import { FollowUpsPage } from "@/features/follow-ups/follow-ups-page";
import { SupportFollowUps } from "@/features/support/support-pages";
import { pageFor } from "@/server/pages";

export default async function Page() {
  const staff = await pageFor("manager", "sales", "support");
  return staff.role === "support" ? <SupportFollowUps /> : <FollowUpsPage />;
}
