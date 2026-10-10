// Preset categories every new núcleo starts with (pt-BR). `is_preset` only drives a badge; all deletable.
// Mirrors what migrations 0001/0002/0004 seeded for núcleo 1.
import type { Kind, Pace } from "./db";

export type Preset = { name: string; kind: Kind; icon: string; color: string; pace: Pace; sort: number };

export const PRESETS: Preset[] = [
  { name: "Moradia", kind: "out", icon: "house", color: "#7a6f9a", pace: "fixo", sort: 1 },
  { name: "Mercado", kind: "out", icon: "shopping-cart", color: "#6f8f6a", pace: "continuo", sort: 2 },
  { name: "Restaurantes", kind: "out", icon: "fork-knife", color: "#a67a52", pace: "continuo", sort: 3 },
  { name: "Transporte", kind: "out", icon: "car", color: "#5f8296", pace: "continuo", sort: 4 },
  { name: "Saúde", kind: "out", icon: "first-aid-kit", color: "#a06060", pace: "continuo", sort: 5 },
  { name: "Assinaturas", kind: "out", icon: "television", color: "#8a6f93", pace: "fixo", sort: 6 },
  { name: "Lazer", kind: "out", icon: "confetti", color: "#a0677f", pace: "livre", sort: 7 },
  { name: "Roupas", kind: "out", icon: "t-shirt", color: "#5d8d87", pace: "livre", sort: 8 },
  { name: "Educação", kind: "out", icon: "book-open", color: "#a39358", pace: "fixo", sort: 9 },
  { name: "Pets", kind: "out", icon: "paw-print", color: "#7f9358", pace: "continuo", sort: 10 },
  { name: "Presentes", kind: "out", icon: "gift", color: "#9c5f6c", pace: "livre", sort: 11 },
  { name: "Impostos", kind: "out", icon: "receipt", color: "#6f7682", pace: "fixo", sort: 12 },
  { name: "Outros", kind: "out", icon: "package", color: "#7d7d7d", pace: "continuo", sort: 13 },
  { name: "Salário", kind: "in", icon: "briefcase", color: "#5f8f68", pace: "continuo", sort: 1 },
  { name: "Freelance", kind: "in", icon: "laptop", color: "#5f7d9c", pace: "continuo", sort: 2 },
  { name: "Investimentos", kind: "in", icon: "trend-up", color: "#7c6f9c", pace: "continuo", sort: 3 },
  { name: "Reembolso", kind: "in", icon: "arrow-u-up-left", color: "#5a8c93", pace: "continuo", sort: 4 },
  { name: "Outros", kind: "in", icon: "package", color: "#7d7d7d", pace: "continuo", sort: 5 },
];

export async function seedPresets(db: D1Database, nucleoId: number): Promise<void> {
  const stmt = db.prepare("INSERT INTO categories (nucleo_id, name, kind, icon, color, is_preset, sort, pace) VALUES (?, ?, ?, ?, ?, 1, ?, ?)");
  await db.batch(PRESETS.map((p) => stmt.bind(nucleoId, p.name, p.kind, p.icon, p.color, p.sort, p.pace)));
}
