export type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  REQUIRE_ACCESS: string;
  /** Comma-separated. App administrators: approve devices, manage IPs, users and read the access log. */
  ADMIN_EMAILS: string;
  /** "true" disables the IP + device gates: any browser is approved on first visit (dev only). */
  LIBERADO?: string;
  /** Optional: Brevo transactional API key + verified sender; without them codes are in-app only. */
  BREVO_API_KEY?: string;
  EMAIL_FROM?: string;
};

export type DeviceStatus = "pending" | "approved" | "denied" | "revoked";

export type Device = {
  id: number;
  name: string;
  user_agent: string;
  status: DeviceStatus;
  requested_email: string;
  requested_ip: string;
  created_at: string;
  last_seen_at: string;
  /** User id of the admin who approved it; NULL for bootstrap and code redemption. */
  approved_by: number | null;
  approved_at: string | null;
  revoked_at: string | null;
  /** Núcleo the account registered on this device joins at once (set by the approving admin). */
  join_nucleo_id: number | null;
};

/** `appAdmin` comes from ADMIN_EMAILS: access management for the whole app, not ledger rights. */
export type User = { id: number; email: string; appAdmin: boolean };

export type NucleoRole = "admin" | "membro";

/** The núcleo the current request works on, with the user's role in it. */
export type Nucleo = { id: number; name: string; role: NucleoRole };

export type Variables = {
  ip: string;
  device: Device;
  user: User;
  sessionId: number;
  nucleo: Nucleo;
  /** Set by a gate when it short-circuits, so the access log records why. */
  outcome: string;
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };
