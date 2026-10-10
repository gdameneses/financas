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

  // --- collapsible cards remember their state on this device ---
  document.querySelectorAll("details.fold[id]").forEach(function (d) {
    try {
      var saved = localStorage.getItem(d.id);
      if (saved === "closed") d.open = false;
      d.addEventListener("toggle", function () {
        localStorage.setItem(d.id, d.open ? "open" : "closed");
        window.dispatchEvent(new Event("resize")); // let Chart.js lay out a chart revealed after load
      });
    } catch (e) { /* storage unavailable: just stay open */ }
  });

  // --- charts ---
  function data(id) {
    var el = document.getElementById(id);
    return el ? JSON.parse(el.textContent) : null;
  }
  function brl(v) { return (v / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
  // Compressed (log) value axis: R$ 1.000 → 10.000 → 100.000 are equal steps, so one big
  // value never flattens the others. Only round ticks (1, 5 × 10^n) get a label.
  // Axis labels are illustration, not a report: whole reais, compact, powers of ten only, no grid.
  function compact(cents) {
    var r = cents / 100;
    if (r >= 1e6) return (r / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " mi";
    if (r >= 1e3) return (r / 1e3).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " mil";
    return r.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
  }
  function logAxis(extra) {
    return Object.assign({
      type: "logarithmic",
      min: 100, // R$ 1
      grid: { display: false },
      border: { display: false },
      afterBuildTicks: function (axis) {
        axis.ticks = axis.ticks.filter(function (t) {
          var v = t.value;
          return v >= 100 && Math.abs(Math.log10(v) - Math.round(Math.log10(v))) < 1e-9;
        });
      },
      ticks: { callback: function (v) { return compact(v); } },
    }, extra || {});
  }
  function charts() {
    if (!window.Chart) return;
    var css = getComputedStyle(document.documentElement);
    Chart.defaults.color = css.getPropertyValue("--fg-dim").trim() || "#8d8872";
    Chart.defaults.borderColor = "rgba(128,128,128,.15)";
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
          scales: { x: logAxis(), y: { grid: { display: false } } },
        },
      });
    }
    var week = document.getElementById("week");
    var w = week && data(week.dataset.src);
    if (w) {
      new Chart(week, {
        type: "bar",
        data: {
          labels: w.labels,
          datasets: [{ label: "Saídas", data: w.expense, backgroundColor: "rgba(196,127,122,.85)", borderRadius: 5 }],
        },
        options: {
          maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (c) { return " " + c.dataset.label + ": " + brl(c.parsed.y); } } } },
          scales: { y: logAxis(), x: { grid: { display: false } } },
        },
      });
    }
    var plan = document.getElementById("plan");
    var p = plan && data(plan.dataset.src);
    if (p) {
      var faded = p.colors.map(function (c) { return c + "40"; }); // same hue, 25% alpha = "planejado"
      new Chart(plan, {
        type: "bar",
        data: {
          labels: p.labels,
          datasets: [
            { label: "Planejado", data: p.planned, backgroundColor: faded, borderRadius: 6, barPercentage: 0.9, categoryPercentage: 0.9, grouped: false, order: 2 },
            { label: "Gasto", data: p.actual, backgroundColor: p.colors, borderRadius: 6, barPercentage: 0.55, categoryPercentage: 0.9, grouped: false, order: 1 },
          ],
        },
        options: {
          indexAxis: "y",
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: function (c) { return " " + c.dataset.label + ": " + brl(c.parsed.x); } } },
          },
          scales: { x: logAxis(), y: { grid: { display: false } } },
        },
        plugins: [{
          id: "pace",
          afterDatasetsDraw: function (chart) {
            // where a category should be today: a tick at elapsed% of its planned amount
            var ctx = chart.ctx, x = chart.scales.x, y = chart.scales.y;
            ctx.save(); ctx.strokeStyle = "rgba(217,210,180,.9)"; ctx.lineWidth = 2;
            p.planned.forEach(function (cap, i) {
              if (!cap) return;
              var px = x.getPixelForValue(cap * p.elapsedPct / 100), py = y.getPixelForValue(i);
              ctx.beginPath(); ctx.moveTo(px, py - 10); ctx.lineTo(px, py + 10); ctx.stroke();
            });
            ctx.restore();
          },
        }],
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
