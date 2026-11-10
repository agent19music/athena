import { auth, clerkClient } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import SettingsClient from "./SettingsClient";
import DashboardShell, { AppPage } from "../../../components/DashboardShell";
import { PageHeader } from "../../../components/athena/ui";

export default async function SettingsPage() {
  const { userId, orgId, orgRole, orgSlug } = await auth();

  if (!userId) redirect("/login");
  if (!orgId) redirect("/onboarding");
  if (orgRole !== "org:admin") redirect("/dashboard");

  let orgName = orgSlug?.replace(/-/g, " ") || "Organisation";
  let orgLogo: string | null = null;
  try {
    const client = await clerkClient();
    const org = await client.organizations.getOrganization({ organizationId: orgId });
    orgName = org.name;
    // Clerk always returns a generated imageUrl; only a real upload counts.
    orgLogo = org.hasImage ? org.imageUrl : null;
  } catch {
    // Clerk Backend API errors (bad secret, missing org, 5xx) used to crash
    // this page with an empty Server Components error. Dashboard already
    // fails open; match that.
  }

  return (
    <DashboardShell>
      <AppPage narrow>
        <PageHeader title="Settings" sub="Organisation details and where Athena gets its knowledge." />
        <SettingsClient orgName={orgName} orgLogo={orgLogo} orgId={orgId} />
      </AppPage>
    </DashboardShell>
  );
}
