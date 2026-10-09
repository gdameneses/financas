export type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  REQUIRE_ACCESS: string;
  /** Comma-separated. These accounts can manage categories, users, IPs and read the access log. */
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
  approved_at: string | null;
  revoked_at: string | null;
};

export type User = { id: number; email: string; admin: boolean };

export type Variables = {
  ip: string;
  device: Device;
  user: User;
  sessionId: number;
  /** Set by a gate when it short-circuits, so the access log records why. */
  outcome: string;
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };
