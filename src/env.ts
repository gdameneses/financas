export type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  REQUIRE_ACCESS: string;
  ENROLL_SECRET?: string;
};

export type Device = {
  id: number;
  name: string;
  user_agent: string;
  created_at: string;
  last_seen_at: string;
  revoked_at: string | null;
};

export type User = { id: number; email: string };

export type Variables = {
  device: Device;
  user: User;
  sessionId: number;
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };
