import { useEffect, useState } from "react";

/**
 * Reads the Static Web Apps client principal from `/.auth/me`.
 *
 * The portal is gated at the SWA edge (staticwebapp.config.json requires the
 * `portal` role for `/*`), so by the time this runs the user is already
 * authorised — this is for DISPLAY only, never for access control. Anything
 * that actually matters is enforced by the route rules and the API.
 *
 * Locally under `swa start`, the emulator serves a fake principal, so the chip
 * renders without a real Google handshake.
 */

export interface ClientPrincipal {
  identityProvider: string;
  userId: string;
  userDetails: string;
  userRoles: string[];
}

export function useAuth(): { user: ClientPrincipal | null; loading: boolean } {
  const [user, setUser] = useState<ClientPrincipal | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    fetch("/.auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        setUser(data?.clientPrincipal ?? null);
      })
      .catch(() => {
        // Running under bare `vite dev` there is no /.auth endpoint at all.
        // That is not an error worth surfacing — just render without the chip.
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { user, loading };
}
