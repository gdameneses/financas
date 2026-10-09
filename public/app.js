// Progressive enhancement only: everything works without this file.
(function () {
  // --- kind toggle + category filtering on the transaction form ---
  var form = document.getElementById("txform");
  if (form) {
    var kinds = form.querySelectorAll(".kind label");
    var chips = form.querySelectorAll(".chip");
    function applyKind() {
      var kind = form.querySelector('input[name=kind]:checked').value;
      form.classList.toggle("out", kind === "out");
      form.classList.toggle("in", kind === "in");
      kinds.forEach(function (l) { l.classList.toggle("on", l.querySelector("input").value === kind); });
      chips.forEach(function (ch) {
        var k = ch.dataset.kind;
        var show = k === "any" || k === kind;
        ch.hidden = !show;
        if (!show && ch.querySelector("input").checked) ch.querySelector("input").checked = false;
      });
      syncChips();
    }
    function syncChips() {
      chips.forEach(function (ch) { ch.classList.toggle("on", ch.querySelector("input").checked); });
    }
    form.querySelectorAll('input[name=kind]').forEach(function (r) { r.addEventListener("change", applyKind); });
    chips.forEach(function (ch) { ch.addEventListener("change", syncChips); });
    applyKind();

    // Live BRL mask: digits typed are centavos.
    var amount = form.querySelector('input[name=amount]');
    amount.addEventListener("input", function () {
      var digits = amount.value.replace(/\D/g, "");
      if (!digits) { amount.value = ""; return; }
      var n = parseInt(digits, 10);
      amount.value = (n / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    });

    // Enter never submits from a text field: payee → amount → (keyboard away, categories visible).
    var payee = form.querySelector('input[name=payee]');
    payee.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); amount.focus(); }
    });
    amount.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        amount.blur();
        var cats = form.querySelector(".cats");
        if (cats) cats.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    });
    form.querySelectorAll('input[name=note], input[name=date]').forEach(function (el) {
      el.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); el.blur(); } });
    });
  }

  // kind toggle on the category create form (no filtering needed)
  document.querySelectorAll("form:not(#txform) .kind").forEach(function (box) {
    box.querySelectorAll("input").forEach(function (r) {
      r.addEventListener("change", function () {
        box.querySelectorAll("label").forEach(function (l) { l.classList.toggle("on", l.querySelector("input").checked); });
      });
    });
  });

  // --- charts ---
  function data(id) {
    var el = document.getElementById(id);
    return el ? JSON.parse(el.textContent) : null;
  }
  function brl(v) { return (v / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
  function charts() {
    if (!window.Chart) return;
    var fg = getComputedStyle(document.documentElement).getPropertyValue("--muted").trim();
    Chart.defaults.color = fg;
    Chart.defaults.font.family = "system-ui, sans-serif";

    var donut = document.getElementById("donut");
    var d = donut && data(donut.dataset.src);
    if (d) {
      new Chart(donut, {
        type: "doughnut",
        data: { labels: d.labels, datasets: [{ data: d.values, backgroundColor: d.colors, borderWidth: 0 }] },
        options: { cutout: "68%", plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (c) { return " " + brl(c.parsed); } } } } },
      });
    }
    var bars = document.getElementById("bars");
    var b = bars && data(bars.dataset.src);
    if (b) {
      new Chart(bars, {
        type: "bar",
        data: { labels: b.labels, datasets: [{ data: b.values, backgroundColor: b.colors, borderRadius: 6 }] },
        options: {
          indexAxis: "y",
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (c) { return " " + brl(c.parsed.x); } } } },
          scales: { x: { ticks: { callback: function (v) { return brl(v); }, maxTicksLimit: 4 }, grid: { color: "rgba(128,128,128,.15)" } }, y: { grid: { display: false } } },
        },
      });
    }
    var trend = document.getElementById("trend");
    var t = trend && data(trend.dataset.src);
    if (t) {
      new Chart(trend, {
        data: {
          labels: t.labels,
          datasets: [
            { type: "bar", label: "Entradas", data: t.income, backgroundColor: "rgba(34,197,94,.7)", borderRadius: 4 },
            { type: "bar", label: "Saídas", data: t.expense, backgroundColor: "rgba(239,68,68,.7)", borderRadius: 4 },
            { type: "line", label: "Saldo", data: t.net, borderColor: "#6366f1", backgroundColor: "#6366f1", tension: .3, pointRadius: 2 },
          ],
        },
        options: {
          plugins: { tooltip: { callbacks: { label: function (c) { return " " + c.dataset.label + ": " + brl(c.parsed.y); } } } },
          scales: { y: { ticks: { callback: function (v) { return brl(v); }, maxTicksLimit: 5 }, grid: { color: "rgba(128,128,128,.15)" } }, x: { grid: { display: false } } },
        },
      });
    }
  }
  if (window.Chart) charts();
  else {
    var s = document.querySelector('script[src*="chart.umd"]');
    if (s) s.addEventListener("load", charts);
  }
})();
