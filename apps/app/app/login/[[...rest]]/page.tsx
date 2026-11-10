import { cookies } from "next/headers";
import { AuthBScreen } from "@/components/athena/AuthBScreen";
import { themeFromCookies } from "@/lib/theme";

export default async function LoginPage() {
  // Lets Clerk's server-rendered steps (factor-one, sso-callback) start on the
  // right sheet instead of flashing light before hydration.
  const jar = await cookies();
  return <AuthBScreen serverTheme={themeFromCookies((n) => jar.get(n)?.value)} />;
}
