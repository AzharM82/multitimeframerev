import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";

/**
 * SWA `rolesSource` endpoint — the allowlist for portal sign-in.
 *
 * Static Web Apps calls this server-side after a successful Google login,
 * POSTing the authenticated identity. Whatever roles we return are attached to
 * the user's session and evaluated against `allowedRoles` in
 * staticwebapp.config.json.
 *
 * This exists because gating on the built-in `authenticated` role would admit
 * ANY Google account on the internet — a login prompt, not an access control.
 * Returning `["portal"]` only for allow-listed addresses means everyone else
 * completes the Google handshake and is still refused at the edge, before any
 * API code runs.
 *
 * Invoked by the SWA platform, never by the browser, and it must stay reachable
 * without a session (it runs *before* one exists) — hence the anonymous route
 * exemption in staticwebapp.config.json.
 *
 * Config: PORTAL_ALLOWED_EMAILS — comma-separated, case-insensitive.
 * If unset, NOBODY is granted the role (fail closed). A typo in the setting
 * locks you out rather than opening the portal up; recover by fixing the app
 * setting, not by redeploying code.
 */

interface RolesRequestBody {
  identityProvider?: string;
  userId?: string;
  userDetails?: string;
  claims?: Array<{ typ: string; val: string }>;
  accessToken?: string;
}

/** The role name gated on in staticwebapp.config.json. */
const PORTAL_ROLE = "portal";

function allowedEmails(): string[] {
  return (process.env.PORTAL_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * `userDetails` is the email for Google, but fall back to an email claim in
 * case the provider ever supplies it there instead.
 */
function extractEmail(body: RolesRequestBody): string | null {
  const direct = body.userDetails?.trim().toLowerCase();
  if (direct && direct.includes("@")) return direct;

  const claim = body.claims?.find(
    (c) =>
      c.typ === "email" ||
      c.typ === "emails" ||
      c.typ.endsWith("/emailaddress") ||
      c.typ.endsWith("/claims/email"),
  );
  const fromClaim = claim?.val?.trim().toLowerCase();
  return fromClaim && fromClaim.includes("@") ? fromClaim : null;
}

async function getRoles(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const body = (await req.json()) as RolesRequestBody;
    const email = extractEmail(body);
    const allowed = allowedEmails();

    if (allowed.length === 0) {
      // Fail closed and say so loudly — a silent empty allowlist looks
      // identical to a rejected user, which is painful to debug.
      ctx.warn("getRoles: PORTAL_ALLOWED_EMAILS is unset — denying all sign-ins");
      return { jsonBody: { roles: [] } };
    }

    if (email && allowed.includes(email)) {
      ctx.log(`getRoles: granted '${PORTAL_ROLE}' to ${email}`);
      return { jsonBody: { roles: [PORTAL_ROLE] } };
    }

    // Log the rejection — this is the only trace of someone reaching the portal.
    ctx.warn(`getRoles: denied ${email ?? "<no email>"} (provider: ${body.identityProvider ?? "unknown"})`);
    return { jsonBody: { roles: [] } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    ctx.error(`getRoles error: ${message}`);
    // Deny on error rather than 500 — a failure here must never accidentally
    // hand out a role.
    return { jsonBody: { roles: [] } };
  }
}

app.http("getRoles", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "get-roles",
  handler: getRoles,
});
