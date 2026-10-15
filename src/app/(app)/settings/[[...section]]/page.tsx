import { SettingsPage } from "@/features/settings/settings-page";
import { pageFor } from "@/server/pages";

export default async function Page({ params }: PageProps<"/settings/[[...section]]">) {
  await pageFor("manager");
  const { section } = await params;
  return <SettingsPage section={section?.[0]} />;
}
