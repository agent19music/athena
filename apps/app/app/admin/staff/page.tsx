import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import StaffClient from "./StaffClient";
import DashboardShell, { AppPage } from "../../../components/DashboardShell";
import { PageHeader } from "../../../components/athena/ui";
import { loadStaff } from "@/lib/staff";

export default async function StaffPage() {
  const { userId, orgId, orgRole } = await auth();

  if (!userId) redirect("/login");
  if (!orgId) redirect("/onboarding");
  if (orgRole !== "org:admin") redirect("/dashboard");

  const { members, pendingInvitations, currentUserEmails } = await loadStaff(orgId);

  return (
    <DashboardShell>
      <AppPage>
        <PageHeader
          title="Team"
          sub="Invite people and manage who can use Athena in your organisation."
          subMobile="Invite people and manage who can use Athena."
        />
        <StaffClient
          members={members}
          pendingInvitations={pendingInvitations}
          currentUserEmails={currentUserEmails}
        />
      </AppPage>
    </DashboardShell>
  );
}
