import { ReviewPage } from "@/features/manager/review-page";
import { pageFor } from "@/server/pages";

export default async function Page() {
  await pageFor("manager");
  return <ReviewPage />;
}
