// Importar extrato. Progressive enhancement: pasting a CSV or an OFX works without this file;
// reading a PDF does not, because the PDF is turned into text here, in the browser.
import { textoDoPdf } from "/extrato-pdf.mjs";

// ---- step 1: files → CSV ----
const files = document.getElementById("impfiles");
if (files) {
  const csv = document.getElementById("impcsv");
  const status = document.getElementById("impstatus");
  const download = document.getElementById("impdownload");
  const say = (text, bad) => {
    status.textContent = text;
    status.classList.toggle("neg", !!bad);
  };
  const isPdf = (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
  let pdfjs = null;
  async function read(file) {
    if (!isPdf(file)) return file.text();
    if (!pdfjs) {
      pdfjs = await import("/vendor/pdfjs/pdf.min.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
    }
    return textoDoPdf(pdfjs, new Uint8Array(await file.arrayBuffer()));
  }
  function offer() {
    const has = csv.value.trim() !== "";
    download.hidden = !has;
    if (has) {
      URL.revokeObjectURL(download.href);
      download.href = URL.createObjectURL(new Blob([csv.value], { type: "text/csv" }));
      download.download = "extrato.csv";
    }
  }
  csv.addEventListener("input", offer);
  offer();
  files.addEventListener("change", async () => {
    if (!files.files.length) return;
    say("Lendo " + files.files.length + (files.files.length === 1 ? " arquivo…" : " arquivos…"));
    try {
      const arquivos = [];
      for (const f of files.files) arquivos.push({ nome: f.name, conteudo: await read(f) });
      const r = await fetch("/importar/converter", {
        method: "POST",
        headers: { "content-type": "application/json", "x-fetch": "1" },
        credentials: "same-origin",
        body: JSON.stringify({ arquivos }),
      });
      if (r.redirected) throw new Error("sessão expirou, entre de novo");
      const j = await r.json().catch(() => { throw new Error("erro " + r.status); });
      if (!r.ok) throw new Error(j.error || "erro " + r.status);
      csv.value = j.csv;
      offer();
      say(j.fontes.map((s) => s.nome + ": " + s.formato + ", " + s.linhas + " linhas").join(" · ") + ". Total sem repetidas: " + j.linhas + ".");
      // straight to the review; the CSV stays in the box for whoever comes back to look at it
      document.getElementById("impstart").submit();
    } catch (e) {
      say("Não consegui ler: " + (e.message || "sem conexão"), true);
    }
  });
}

// ---- step 2: the review table ----
const form = document.getElementById("impform");
if (form) {
  const rows = Array.from(form.querySelectorAll(".imp"));
  const submit = document.getElementById("impsubmit");
  const on = (row) => row.querySelector(".imp-on");
  const nossa = (row) => row.querySelector(".imp-nossa");
  function sync() {
    let n = 0;
    rows.forEach((row) => { if (on(row) && on(row).checked) n++; });
    submit.textContent = "Salvar (" + n + (n === 1 ? " lançamento)" : " lançamentos)");
  }
  const same = (row) => rows.filter((r) => r !== row && r.dataset.chave === row.dataset.chave);
  const picked = (row) => row.querySelector(".catpick input:checked");

  // a second click on the chosen category clears it (a radio cannot do that by itself)
  form.addEventListener("click", (e) => {
    const radio = e.target.closest(".catpick input");
    if (!radio) return;
    if (radio.dataset.was === "1") {
      radio.checked = false;
      radio.dataset.was = "";
    } else {
      radio.closest(".catpick").querySelectorAll("input").forEach((r) => { r.dataset.was = ""; });
      radio.dataset.was = "1";
      // one answer for every row from the same place that has no category yet
      same(radio.closest(".imp")).forEach((r) => {
        if (r.dataset.kind !== radio.closest(".imp").dataset.kind || picked(r)) return;
        const twin = r.querySelector('.catpick input[value="' + radio.value + '"]');
        if (twin) twin.checked = true;
      });
    }
  });
  form.querySelectorAll(".catpick input:checked").forEach((r) => { r.dataset.was = "1"; });

  form.addEventListener("change", (e) => {
    const row = e.target.closest(".imp");
    if (!row) return;
    if (e.target.classList.contains("imp-payee")) {
      const before = e.target.defaultValue;
      same(row).forEach((r) => {
        const inp = r.querySelector(".imp-payee");
        if (inp && inp.value === before) { inp.value = e.target.value; inp.defaultValue = e.target.value; }
      });
      e.target.defaultValue = e.target.value;
    }
    // "between our accounts" names a person: it holds for every row of that person, and none of them is an entry
    if (e.target.classList.contains("imp-nossa")) {
      [row].concat(same(row)).forEach((r) => {
        if (!nossa(r)) return;
        nossa(r).checked = e.target.checked;
        if (e.target.checked) on(r).checked = false;
      });
    }
    if (e.target.classList.contains("imp-on") && e.target.checked && nossa(row)) nossa(row).checked = false;
    sync();
  });
  sync();

  const download = document.getElementById("impdownload");
  const csv = document.getElementById("impcsv");
  if (download && csv) {
    download.href = URL.createObjectURL(new Blob([csv.value], { type: "text/csv" }));
    download.download = "extrato.csv";
    download.hidden = false;
  }
}
