import { clerkClient, currentUser } from "@clerk/nextjs/server";

export type Member = {
  id: string;
  role: string;
  email: string;
  name: string;
  joinedAt: string;
  /** Profile photo when the person uploaded one; null means show the seeded orb. */
  imageUrl: string | null;
};

export type PendingInvitation = {
  id: string;
  email: string;
  role: string;
  invitedAt: string;
};

function formatDate(iso: string | number): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Shared by the staff page's initial server render and the /api/admin/staff
// poll endpoint, so both return identically-shaped data.
export async function loadStaff(orgId: string) {
  try {
    const client = await clerkClient();
    const [memberships, invitations, self] = await Promise.all([
      client.organizations.getOrganizationMembershipList({ organizationId: orgId, limit: 100 }),
      client.organizations.getOrganizationInvitationList({ organizationId: orgId, status: ["pending"] }),
      currentUser(),
    ]);

    const members: Member[] = memberships.data.map((m) => ({
      id: m.id,
      role: m.role,
      email: m.publicUserData?.identifier ?? "",
      name: [m.publicUserData?.firstName, m.publicUserData?.lastName].filter(Boolean).join(" "),
      joinedAt: formatDate(m.createdAt),
      imageUrl: m.publicUserData?.hasImage ? m.publicUserData.imageUrl : null,
    }));

    const pendingInvitations: PendingInvitation[] = invitations.data.map((i) => ({
      id: i.id,
      email: i.emailAddress,
      role: i.role,
      invitedAt: formatDate(i.createdAt),
    }));

    const currentUserEmails = (self?.emailAddresses ?? []).map((e) => e.emailAddress.toLowerCase());

    return { members, pendingInvitations, currentUserEmails };
  } catch {
    return { members: [], pendingInvitations: [], currentUserEmails: [] };
  }
}
