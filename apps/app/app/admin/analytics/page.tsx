import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { CaretDown } from "@phosphor-icons/react/dist/ssr";
import AnalyticsClient from "./AnalyticsClient";
import DashboardShell, { AppPage } from "../../../components/DashboardShell";
import { PageHeader } from "../../../components/athena/ui";

export default async function AnalyticsPage() {
  const { userId, orgId, orgRole } = await auth();

  if (!userId) redirect("/login");
  if (!orgId) redirect("/onboarding");
  if (orgRole !== "org:admin") redirect("/dashboard");

  return (
    <DashboardShell>
      <AppPage>
        <PageHeader
          title="Analytics"
          sub="What your team is asking. Only totals are shown here, so individual conversations stay private."
          subMobile="What your team is asking. Only totals are shown, so individual conversations stay private."
          hideActionsOnMobile
          actions={
            // The analytics API returns a fixed 14-day window, so the range is shown, not chosen.
            <span className="a-btn a-btn-secondary" aria-label="Range: last 14 days" style={{ cursor: "default" }}>
              Range · Last 14 days
              <CaretDown size={12} />
            </span>
          }
        />
        <AnalyticsClient />
      </AppPage>
    </DashboardShell>
  );
}
