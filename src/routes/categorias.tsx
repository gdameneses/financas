import { Hono } from "hono";
import type { AppEnv } from "../env";
import { Layout } from "../pages/layout";
import {
  countCategoryTransactions,
  createCategory,
  deleteCategory,
  getCategory,
  listCategories,
  renameCategory,
  type Category,
} from "../db";

export const categorias = new Hono<AppEnv>();

const PALETTE = ["#6366f1", "#22c55e", "#f97316", "#0ea5e9", "#ef4444", "#a855f7", "#ec4899", "#14b8a6", "#eab308", "#84cc16", "#f43f5e", "#64748b", "#9ca3af"];

const CatFields = ({ cat }: { cat?: Category }) => (
  <>
    <label>
      Nome
      <input name="name" value={cat?.name ?? ""} required maxlength={40} />
    </label>
    <div class="row">
      <label>
        Ícone
        <input name="icon" value={cat?.icon ?? "🏷️"} maxlength={8} class="emoji" />
      </label>
      <label>
        Cor
        <input type="color" name="color" value={cat?.color ?? PALETTE[Math.floor(Math.random() * PALETTE.length)]} />
      </label>
    </div>
  </>
);

const Group = ({ title, cats }: { title: string; cats: Category[] }) => (
  <section>
    <h2>{title}</h2>
    {cats.length ? (
      <ul class="catlist">
        {cats.map((cat) => (
          <li>
            <a href={`/categorias/${cat.id}`}>
              <span class="ico" style={`background:${cat.color}`}>
                {cat.icon}
              </span>
              {cat.name}
              {cat.is_preset ? <small class="badge">padrão</small> : null}
            </a>
          </li>
        ))}
      </ul>
    ) : (
      <p class="muted">Nenhuma.</p>
    )}
  </section>
);

categorias.get("/", async (c) => {
  const cats = await listCategories(c.env.DB);
  return c.html(
    <Layout title="Categorias" active="mais" toast={c.req.query("ok") ?? undefined}>
      <h1>Categorias</h1>
      <Group title="Saídas" cats={cats.filter((x) => x.kind === "out")} />
      <Group title="Entradas" cats={cats.filter((x) => x.kind === "in")} />
      <section class="card">
        <h2>Nova categoria</h2>
        <form method="post" action="/categorias" class="stack">
          <div class="kind">
            <label class="on">
              <input type="radio" name="kind" value="out" checked /> Saída
            </label>
            <label>
              <input type="radio" name="kind" value="in" /> Entrada
            </label>
          </div>
          <CatFields />
          <button type="submit" class="btn">
            Criar
          </button>
        </form>
      </section>
    </Layout>,
  );
});

categorias.post("/", async (c) => {
  const form = await c.req.parseBody();
  const name = String(form.name ?? "").trim().slice(0, 40);
  if (!name) return c.redirect("/categorias");
  await createCategory(c.env.DB, {
    name,
    kind: form.kind === "in" ? "in" : "out",
    icon: String(form.icon ?? "🏷️").trim().slice(0, 8) || "🏷️",
    color: /^#[0-9a-f]{6}$/i.test(String(form.color)) ? String(form.color) : "#9ca3af",
  });
  return c.redirect(`/categorias?ok=${encodeURIComponent("Categoria criada")}`);
});

categorias.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const cat = await getCategory(c.env.DB, id);
  if (!cat) return c.notFound();
  const n = await countCategoryTransactions(c.env.DB, id);
  const warn =
    n === 0
      ? "Excluir esta categoria?"
      : `Excluir esta categoria? ${n} lançamento(s) passarão a ficar "Sem categoria" (nenhum valor é apagado).`;
  return c.html(
    <Layout title={cat.name} bare>
      <h1>
        {cat.icon} {cat.name}
      </h1>
      <p class="muted">
        {cat.kind === "in" ? "Entrada" : "Saída"} · {n} lançamento(s){cat.is_preset ? " · categoria padrão" : ""}
      </p>
      <form method="post" action={`/categorias/${cat.id}`} class="stack">
        <CatFields cat={cat} />
        <div class="actions">
          <a href="/categorias" class="btn ghost">
            Voltar
          </a>
          <button type="submit" class="btn">
            Salvar
          </button>
        </div>
      </form>
      <form method="post" action={`/categorias/${cat.id}/excluir`} onsubmit={`return confirm(${JSON.stringify(warn)})`}>
        <button type="submit" class="btn danger">
          Excluir categoria
        </button>
      </form>
    </Layout>,
  );
});

categorias.post("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!(await getCategory(c.env.DB, id))) return c.notFound();
  const form = await c.req.parseBody();
  const name = String(form.name ?? "").trim().slice(0, 40);
  if (name) {
    await renameCategory(
      c.env.DB,
      id,
      name,
      String(form.icon ?? "").trim().slice(0, 8) || "🏷️",
      /^#[0-9a-f]{6}$/i.test(String(form.color)) ? String(form.color) : "#9ca3af",
    );
  }
  return c.redirect(`/categorias?ok=${encodeURIComponent("Categoria salva")}`);
});

categorias.post("/:id/excluir", async (c) => {
  const id = Number(c.req.param("id"));
  if (!(await getCategory(c.env.DB, id))) return c.notFound();
  await deleteCategory(c.env.DB, id);
  return c.redirect(`/categorias?ok=${encodeURIComponent("Categoria excluída")}`);
});
