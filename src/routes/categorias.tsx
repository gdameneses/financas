import { Hono } from "hono";
import type { AppEnv } from "../env";
import { Layout } from "../pages/layout";
import { parseId } from "../middleware";
import { CatIcon, Icon } from "../pages/bits";
import { CATEGORY_ICONS } from "../icons";
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

const PALETTE = ["#7a6f9a", "#6f8f6a", "#a67a52", "#5f8296", "#a06060", "#8a6f93", "#a0677f", "#5d8d87", "#a39358", "#7f9358", "#9c5f6c", "#6f7682", "#7d7d7d"];
const isIcon = (s: string): s is (typeof CATEGORY_ICONS)[number] => (CATEGORY_ICONS as readonly string[]).includes(s);

const CatFields = ({ cat }: { cat?: Category }) => {
  const color = cat?.color ?? PALETTE[Math.floor(Math.random() * PALETTE.length)];
  const icon = cat?.icon ?? "tag";
  return (
    <>
      <div class="row">
        <label>
          Nome
          <input name="name" value={cat?.name ?? ""} required maxlength={40} />
        </label>
        <label>
          Cor
          <input type="color" name="color" value={color} />
        </label>
      </div>
      <label>
        Como avisa no planejamento
        <select name="pace">
          <option value="continuo" selected={(cat?.pace ?? "continuo") === "continuo"}>Contínua: gasto espalhado no mês (mercado, transporte)</option>
          <option value="fixo" selected={cat?.pace === "fixo"}>Fixa: paga de uma vez (aluguel, assinaturas)</option>
          <option value="livre" selected={cat?.pace === "livre"}>Livre: em surtos (lazer, presentes)</option>
        </select>
      </label>
      <div class="iconpick">
        {CATEGORY_ICONS.map((name) => (
          <label class={`chip ${icon === name ? "on any" : ""}`}>
            <input type="radio" name="icon" value={name} checked={icon === name} />
            <span class="ico">
              <Icon name={name} />
            </span>
          </label>
        ))}
      </div>
    </>
  );
};

const Group = ({ title, cats }: { title: string; cats: Category[] }) => (
  <section>
    <h2>{title}</h2>
    {cats.length ? (
      <ul class="catlist">
        {cats.map((cat) => (
          <li>
            <a href={`/categorias/${cat.id}`}>
              <CatIcon icon={cat.icon} color={cat.color} />
              {cat.name}
              {cat.is_preset ? <small class="badge">padrão</small> : null}
            </a>
          </li>
        ))}
      </ul>
    ) : (
      <p class="muted">Nenhuma categoria ainda.</p>
    )}
  </section>
);

function readFields(form: Record<string, unknown>) {
  return {
    name: String(form.name ?? "").trim().slice(0, 40),
    icon: isIcon(String(form.icon)) ? String(form.icon) : "tag",
    color: /^#[0-9a-f]{6}$/i.test(String(form.color)) ? String(form.color) : "#7d7d7d",
    pace: (["continuo", "fixo", "livre"] as const).find((p) => p === String(form.pace)) ?? "continuo",
  };
}

categorias.get("/", async (c) => {
  const cats = await listCategories(c.env.DB, c.get("nucleo").id);
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
          <button type="submit" class="btn primary">
            Criar categoria
          </button>
        </form>
      </section>
    </Layout>,
  );
});

categorias.post("/", async (c) => {
  const form = await c.req.parseBody();
  const f = readFields(form);
  if (!f.name) return c.redirect("/categorias");
  await createCategory(c.env.DB, c.get("nucleo").id, { ...f, kind: form.kind === "in" ? "in" : "out" });
  return c.redirect(`/categorias?ok=${encodeURIComponent("Categoria criada")}`);
});

categorias.get("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.notFound();
  const cat = await getCategory(c.env.DB, c.get("nucleo").id, id);
  if (!cat) return c.notFound();
  const n = await countCategoryTransactions(c.env.DB, c.get("nucleo").id, id);
  const warn =
    n === 0
      ? "Excluir esta categoria?"
      : `Excluir esta categoria? ${n} lançamento(s) passarão a ficar "Sem categoria" (nenhum valor é apagado).`;
  return c.html(
    <Layout title={cat.name} bare>
      <h1>
        <CatIcon icon={cat.icon} color={cat.color} /> {cat.name}
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
          <button type="submit" class="btn primary">
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
  const id = parseId(c.req.param("id"));
  if (id === null) return c.notFound();
  const n = c.get("nucleo").id;
  if (!(await getCategory(c.env.DB, n, id))) return c.notFound();
  const f = readFields(await c.req.parseBody());
  if (f.name) await renameCategory(c.env.DB, n, id, f.name, f.icon, f.color, f.pace);
  return c.redirect(`/categorias?ok=${encodeURIComponent("Categoria salva")}`);
});

categorias.post("/:id/excluir", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.notFound();
  const n = c.get("nucleo").id;
  if (!(await getCategory(c.env.DB, n, id))) return c.notFound();
  await deleteCategory(c.env.DB, n, id);
  return c.redirect(`/categorias?ok=${encodeURIComponent("Categoria excluída")}`);
});
