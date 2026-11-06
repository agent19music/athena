import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const isPublicRoute = createRouteMatcher([
  "/",
  "/migration",
  "/login(.*)",
  "/register(.*)",
  "/invite(.*)",
  "/robots.txt",
  "/dev/connections-preview",
  "/api/webhooks(.*)",
  "/api/auth/notion(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (isPublicRoute(req)) return;

  await auth.protect();

  const { orgId } = await auth();
  const path = req.nextUrl.pathname;

  // Authenticated but no active org — send to onboarding.
  // Exclude /onboarding itself and all API routes (they handle their own auth).
  if (!orgId && !path.startsWith("/onboarding") && !path.startsWith("/api")) {
    return NextResponse.redirect(new URL("/onboarding", req.url));
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
