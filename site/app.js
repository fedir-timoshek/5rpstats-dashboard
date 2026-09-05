(() => {
  "use strict";

  const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
  const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const numberFormatter = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
  const dateFormatter = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "Europe/Moscow" });
  const monthFormatter = new Intl.DateTimeFormat("ru-RU", { month: "short", year: "2-digit", timeZone: "Europe/Moscow" });
  const PROFIT_SERIES = [
    { key: "gas", id: "gas", containerId: "gas-profit-chart", tableId: "gas-profit-table", label: "АЗС №6", color: "#b45fff" },
    { key: "barbershop", id: "barbershop", containerId: "barbershop-profit-chart", tableId: "barbershop-profit-table", label: "Барбершоп №5", color: "#63ddbc" },
    { key: "store13", id: "store", containerId: "store-profit-chart", tableId: "store-profit-table", label: "Магазин 24/7 №13", color: "#f3bb64" },
  ];
  const byId = (id) => document.getElementById(id);
  let currentPayload = null;
  let activePeriod = "7";
  let resizeTimer = null;
  let loadFailed = false;

  function moscowDay(now) {
    return new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  function formatElapsed(timestamp, now = Date.now()) {
    if (!timestamp || !Number.isFinite(new Date(timestamp).getTime())) return "—";
    const minutes = Math.max(0, Math.floor((now - new Date(timestamp).getTime()) / 60000));
    if (minutes < 1) return "только что";
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    const hourWord = hours % 100 >= 11 && hours % 100 <= 14 ? "часов" : hours % 10 === 1 ? "час" : hours % 10 >= 2 && hours % 10 <= 4 ? "часа" : "часов";
    return `${hours ? `${hours} ${hourWord}` : ""}${hours && rest ? " " : ""}${rest ? `${rest} мин` : ""} назад`;
  }

  function emptyDay(date, isPartial) {
    return { date, isPartial, profits: { gas: null, barbershop: null, store13: null }, profitSamples: { gas: 0, barbershop: 0, store13: 0 }, online: { min: null, max: null, samples: 0 } };
  }

  function selectDays(payload, period = activePeriod, now = new Date()) {
    const today = moscowDay(now);
    const end = new Date(`${today}T12:00:00Z`);
    const byDate = new Map(payload.days.map((day) => [day.date, day]));
    if (period !== "year") {
      const count = period === "30" ? 30 : 7;
      return Array.from({ length: count }, (_, index) => {
        const date = new Date(end);
        date.setUTCDate(date.getUTCDate() - count + index + 1);
        const key = date.toISOString().slice(0, 10);
        return { ...(byDate.get(key) || emptyDay(key, key === today)), isPartial: key === today };
      });
    }
    return Array.from({ length: 12 }, (_, index) => {
      const date = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 11 + index, 1, 12));
      const key = date.toISOString().slice(0, 7);
      const month = emptyDay(`${key}-01`, index === 11);
      month.isMonthly = true;
      month.missing = {};
      const days = payload.days.filter((day) => day.date.startsWith(key) && day.date <= today);
      const expectedDays = index === 11 ? end.getUTCDate() : new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
      PROFIT_SERIES.forEach((series) => {
        const values = days.map((day) => day.profits[series.key]).filter(Number.isFinite);
        month.profits[series.key] = values.length ? values.reduce((sum, value) => sum + value, 0) : null;
        month.profitSamples[series.key] = days.reduce((sum, day) => sum + day.profitSamples[series.key], 0);
        month.missing[series.key] = values.length < expectedDays;
      });
      const online = days.filter((day) => Number.isFinite(day.online.min) && Number.isFinite(day.online.max));
      if (online.length) {
        month.online = { min: Math.min(...online.map((day) => day.online.min)), max: Math.max(...online.map((day) => day.online.max)), samples: online.reduce((sum, day) => sum + day.online.samples, 0) };
      }
      return month;
    });
  }

  function formatMoney(value) {
    return Number.isFinite(value) ? `${numberFormatter.format(value)} $` : "—";
  }

  function formatDate(day) {
    return (day.isMonthly ? monthFormatter : dateFormatter).format(new Date(`${day.date}T12:00:00Z`));
  }

  function pointStatus(day, key) {
    const labels = [];
    if (day.isPartial) labels.push(day.isMonthly ? "текущий месяц" : "сегодня");
    if (day.missing?.[key]) labels.push("неполные данные");
    return labels.length ? ` · ${labels.join(" · ")}` : "";
  }

  function validatePayload(payload) {
    if (!payload || payload.schemaVersion !== 2 || !Array.isArray(payload.days) || payload.days.length > 366) throw new Error("Invalid aggregate");
    for (const day of payload.days) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date) || !day.profits || !day.online || !day.profitSamples) throw new Error("Invalid day");
      if (!PROFIT_SERIES.every(({ key }) => day.profits[key] === null || Number.isFinite(day.profits[key]))) throw new Error("Invalid profit");
    }
    return payload;
  }

  function setMessage(text, state = "warning") {
    const message = byId("global-message");
    message.hidden = !text;
    message.textContent = text || "";
    message.dataset.state = state;
  }

  function renderFreshness() {
    if (!currentPayload) return;
    const payload = currentPayload;
    const delayed = PROFIT_SERIES.filter(({ key }) => {
      const value = payload.sourceStatus?.[key]?.lastObservedAt;
      return !value || !Number.isFinite(Date.parse(value)) || Date.now() - Date.parse(value) >= STALE_AFTER_MS;
    });
    const sourceTimes = PROFIT_SERIES.map(({ key }) => payload.sourceStatus?.[key]?.lastObservedAt).filter((value) => value && Number.isFinite(Date.parse(value)));
    const oldest = sourceTimes.length === PROFIT_SERIES.length ? sourceTimes.reduce((a, b) => Date.parse(a) < Date.parse(b) ? a : b) : null;
    byId("updated-at").textContent = formatElapsed(oldest);
    if (oldest) byId("updated-at").setAttribute("datetime", oldest);
    else byId("updated-at").removeAttribute("datetime");
    byId("updated-at").parentElement.dataset.stale = String(delayed.length > 0);
    if (!loadFailed) setMessage(delayed.length ? `Нет свежих данных: ${delayed.map(({ label }) => label).join(", ")}.` : "");
  }

  function svgElement(name, attributes = {}) {
    const element = document.createElementNS(SVG_NS, name);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
    return element;
  }

  function chartDimensions(container) {
    const width = Math.max(240, Math.round(container.getBoundingClientRect().width || 1000));
    return { width, height: width < 520 ? 280 : width < 1000 ? 360 : 400, margin: { top: 22, right: 22, bottom: 40, left: width < 520 ? 55 : 72 } };
  }

  function chartAxis(values) {
    const finite = values.filter(Number.isFinite);
    const minimum = Math.min(0, ...finite);
    const maximum = Math.max(0, ...finite);
    // Aim for five intervals, using only 1 / 2 / 5 times a power of ten.
    const roughStep = Math.max(1, (maximum - minimum) / 5);
    const magnitude = 10 ** Math.floor(Math.log10(roughStep));
    const step = [1, 2, 5, 10].find((factor) => factor * magnitude >= roughStep) * magnitude;
    const min = Math.floor(minimum / step) * step;
    const max = Math.ceil(maximum / step) * step;
    const count = Math.max(1, Math.round((max - min) / step));
    const ticks = Array.from({ length: count + 1 }, (_, index) => min + index * step);
    return { min, max: ticks[ticks.length - 1], ticks };
  }

  function formatAxisValue(value, money) {
    return `${money ? "$" : ""}${numberFormatter.format(value)}`;
  }

  function chartScales(axis, dimensions) {
    const { width, height, margin } = dimensions;
    return { ...axis, y: (value) => height - margin.bottom - (value - axis.min) / (axis.max - axis.min) * (height - margin.bottom - margin.top), x: (index, count) => margin.left + (width - margin.left - margin.right) * index / Math.max(1, count - 1) };
  }

  function addAxes(svg, days, dimensions, scale, money) {
    const { width, height, margin } = dimensions;
    for (const value of scale.ticks) {
      const y = scale.y(value);
      svg.appendChild(svgElement("line", { x1: margin.left, x2: width - margin.right, y1: y, y2: y, class: "chart-grid-line" }));
      const label = svgElement("text", { x: margin.left - 12, y: y + 4, "text-anchor": "end", class: "chart-axis-label" });
      label.textContent = formatAxisValue(value, money);
      svg.appendChild(label);
    }
    const ticks = Math.min(days.length, width < 520 ? 4 : 8);
    for (let index = 0; index < ticks; index += 1) {
      const dayIndex = Math.round(index * (days.length - 1) / Math.max(1, ticks - 1));
      const label = svgElement("text", { x: scale.x(dayIndex, days.length), y: height - 10, "text-anchor": index === 0 ? "start" : index === ticks - 1 ? "end" : "middle", class: "chart-axis-label" });
      label.textContent = formatDate(days[dayIndex]);
      svg.appendChild(label);
    }
  }

  // Each segment stays within its two observations; gaps remain gaps.
  function linePath(points) {
    return points.map(([x, y], index) => {
      if (!index) return `M${x},${y}`;
      const [previousX, previousY] = points[index - 1];
      const middle = (previousX + x) / 2;
      return `C${middle},${previousY} ${middle},${y} ${x},${y}`;
    }).join(" ");
  }

  function renderEmpty(container, text) {
    const empty = document.createElement("div");
    empty.className = "chart-empty";
    empty.textContent = text;
    container.replaceChildren(empty);
    container.setAttribute("aria-busy", "false");
  }

  function renderLines(days, container, series, label, money) {
    const values = days.flatMap((day) => series.map((line) => line.value(day))).filter(Number.isFinite);
    if (!values.length) { renderEmpty(container, "Нет данных за этот период"); return; }
    const dimensions = chartDimensions(container);
    const axis = chartAxis(values);
    // Reserve room for exact numbers, including negatives and monthly totals.
    const labelLength = Math.max(...axis.ticks.map((value) => formatAxisValue(value, money).length));
    dimensions.margin.left = Math.max(dimensions.margin.left, labelLength * (dimensions.width < 520 ? 6 : 7) + 16);
    const { width, height, margin } = dimensions;
    const scale = chartScales(axis, dimensions);
    const svg = svgElement("svg", { viewBox: `0 0 ${width} ${height}`, role: "group", "aria-label": label });
    addAxes(svg, days, dimensions, scale, money);
    const tooltip = document.createElement("div");
    tooltip.className = "chart-tooltip";
    tooltip.hidden = true;
    const crosshair = svgElement("line", { y1: margin.top, y2: height - margin.bottom, class: "chart-crosshair", visibility: "hidden" });
    const focusPoints = [];
    const show = (index) => {
      const day = days[index];
      const x = scale.x(index, days.length);
      tooltip.textContent = `${formatDate(day)}${pointStatus(day, series[0].key)}\n${series.map((line) => `${money ? "" : `${line.label}: `}${Number.isFinite(line.value(day)) ? (money ? formatMoney(line.value(day)) : numberFormatter.format(line.value(day))) : "Нет данных"}`).join("\n")}`;
      tooltip.hidden = false;
      tooltip.style.left = `${Math.max(0, Math.min(x + 12, width - tooltip.offsetWidth))}px`;
      tooltip.style.top = "4px";
      crosshair.setAttribute("x1", x);
      crosshair.setAttribute("x2", x);
      crosshair.setAttribute("visibility", "visible");
      focusPoints.forEach((point) => { point.dataset.active = String(Number(point.dataset.index) === index); });
    };
    const hide = () => { tooltip.hidden = true; crosshair.setAttribute("visibility", "hidden"); focusPoints.forEach((point) => { point.dataset.active = "false"; }); };
    series.forEach((line) => {
      const segments = [];
      let segment = [];
      days.forEach((day, index) => {
        const value = line.value(day);
        if (!Number.isFinite(value)) { if (segment.length) segments.push(segment); segment = []; return; }
        segment.push([scale.x(index, days.length), scale.y(value)]);
      });
      if (segment.length) segments.push(segment);
      const gradientId = `${container.id}-${line.key}-fill`;
      const defs = svgElement("defs");
      const gradient = svgElement("linearGradient", { id: gradientId, x1: "0", y1: "0", x2: "0", y2: "1" });
      gradient.append(svgElement("stop", { offset: "0%", "stop-color": line.color, "stop-opacity": 0.1 }), svgElement("stop", { offset: "100%", "stop-color": line.color, "stop-opacity": 0 }));
      defs.appendChild(gradient); svg.appendChild(defs);
      segments.forEach((points) => {
        if (money && points.length > 1) svg.appendChild(svgElement("path", { d: `${linePath(points)} L${points[points.length - 1][0]},${scale.y(0)} L${points[0][0]},${scale.y(0)} Z`, fill: `url(#${gradientId})` }));
        svg.appendChild(svgElement("path", { d: linePath(points), stroke: line.color, class: "chart-line" }));
      });
      days.forEach((day, index) => {
        const value = line.value(day);
        if (!Number.isFinite(value)) return;
        const point = svgElement("circle", { cx: scale.x(index, days.length), cy: scale.y(value), r: day.isPartial ? 5 : 4, fill: line.color, class: money ? "profit-point" : "online-point", role: "img", tabindex: focusPoints.length ? -1 : 0, "data-index": index, "data-date": day.date, "data-series": line.key, "aria-label": `${formatDate(day)}, ${line.label}: ${money ? formatMoney(value) : numberFormatter.format(value)}${pointStatus(day, line.key)}` });
        point.addEventListener("focus", () => show(index));
        point.addEventListener("click", () => { focusPoints.forEach((other) => other.setAttribute("tabindex", other === point ? "0" : "-1")); point.focus(); });
        focusPoints.push(point); svg.appendChild(point);
      });
    });
    svg.appendChild(crosshair);
    const inspectPointer = (event) => {
      const x = (event.clientX - svg.getBoundingClientRect().left) * width / svg.getBoundingClientRect().width;
      const index = Math.max(0, Math.min(days.length - 1, Math.round((x - margin.left) / (width - margin.left - margin.right) * (days.length - 1))));
      show(index);
    };
    svg.addEventListener("pointermove", inspectPointer);
    svg.addEventListener("pointerdown", inspectPointer);
    svg.addEventListener("pointerleave", () => { if (!svg.contains(document.activeElement)) hide(); });
    svg.addEventListener("focusout", (event) => { if (!svg.contains(event.relatedTarget)) hide(); });
    svg.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { hide(); return; }
      const index = focusPoints.indexOf(document.activeElement);
      if (index < 0 || !["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? focusPoints.length - 1 : Math.max(0, Math.min(focusPoints.length - 1, index + (event.key === "ArrowRight" ? 1 : -1)));
      focusPoints.forEach((point, pointIndex) => point.setAttribute("tabindex", pointIndex === next ? "0" : "-1"));
      focusPoints[next].focus();
    });
    container.replaceChildren(svg, tooltip);
    container.setAttribute("aria-busy", "false");
  }

  function renderProfitChart(days, series) {
    renderLines(days, byId(series.containerId), [{ ...series, value: (day) => day.profits[series.key] }], `Прибыль ${series.label}. Стрелки влево и вправо — значения.`, true);
  }

  function renderTable(id, headers, rows) {
    const head = document.createElement("thead");
    const headerRow = document.createElement("tr");
    headers.forEach((text) => { const cell = document.createElement("th"); cell.scope = "col"; cell.textContent = text; headerRow.appendChild(cell); });
    head.appendChild(headerRow);
    const body = document.createElement("tbody");
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      row.forEach((text, index) => { const cell = document.createElement(index ? "td" : "th"); if (!index) cell.scope = "row"; cell.textContent = text; tr.appendChild(cell); });
      body.appendChild(tr);
    });
    byId(id).replaceChildren(head, body);
  }

  function render(payload) {
    const focused = document.activeElement;
    const chartFocus = focused?.closest?.(".chart-shell");
    const focusedDate = focused?.dataset?.date;
    const focusedSeries = focused?.dataset?.series;
    currentPayload = payload;
    renderFreshness();
    const days = selectDays(payload);
    const today = payload.days.find((day) => day.date === moscowDay(new Date()));
    PROFIT_SERIES.forEach((series) => {
      const values = days.map((day) => day.profits[series.key]).filter(Number.isFinite);
      byId(`${series.id}-profit`).textContent = formatMoney(values.length ? values.reduce((sum, value) => sum + value, 0) : null);
      byId(`${series.id}-today`).textContent = formatMoney(today?.profits[series.key]);
      const missing = days.some((day) => !Number.isFinite(day.profits[series.key]) || day.missing?.[series.key]);
      const period = activePeriod === "year" ? "12 месяцев" : `${activePeriod} дней`;
      byId(`${series.id}-profit`).nextElementSibling.textContent = `Прибыль за ${period}${missing && values.length ? " · неполные данные" : ""}`;
      renderProfitChart(days, series);
      renderTable(series.tableId, [activePeriod === "year" ? "Месяц" : "Дата", "Прибыль"], days.map((day) => [`${formatDate(day)}${pointStatus(day, series.key)}`, formatMoney(day.profits[series.key])]));
    });
    byId("online-range").textContent = Number.isFinite(today?.online.min) && Number.isFinite(today?.online.max) ? `${numberFormatter.format(today.online.min)} — ${numberFormatter.format(today.online.max)}` : "—";
    renderLines(days, byId("online-chart"), [{ key: "max", label: "Максимум", color: "#ad8aff", value: (day) => day.online.max }, { key: "min", label: "Минимум", color: "#63baff", value: (day) => day.online.min }], "Онлайн Chiliad. Стрелки влево и вправо — значения.", false);
    renderTable("online-table", [activePeriod === "year" ? "Месяц" : "Дата", "Минимум", "Максимум"], days.map((day) => [formatDate(day), Number.isFinite(day.online.min) ? numberFormatter.format(day.online.min) : "—", Number.isFinite(day.online.max) ? numberFormatter.format(day.online.max) : "—"]));
    document.querySelectorAll(".period-dates").forEach((element) => { element.textContent = `${formatDate(days[0])} — ${formatDate(days[days.length - 1])}`; });
    byId("gas-profit-table").dataset.day = moscowDay(new Date());
    if (chartFocus && focusedDate) {
      const points = [...chartFocus.querySelectorAll("[data-date]")];
      const restored = points.find((point) => point.dataset.date === focusedDate && point.dataset.series === focusedSeries) || points[0];
      if (restored) { points.forEach((point) => point.setAttribute("tabindex", point === restored ? "0" : "-1")); restored.focus({ preventScroll: true }); }
    }
  }

  async function loadData() {
    try {
      const response = await fetch(`./data/stats.json?ts=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = validatePayload(await response.json());
      loadFailed = false;
      render(payload);
    } catch (error) {
      console.error("Dashboard aggregate load failed", error);
      loadFailed = true;
      setMessage("Не удалось обновить данные. Повторим автоматически.", "error");
      if (!currentPayload) [...PROFIT_SERIES.map((series) => series.containerId), "online-chart"].forEach((id) => renderEmpty(byId(id), "Данные временно недоступны"));
    }
  }

  document.querySelectorAll("[data-period]").forEach((button) => {
    button.addEventListener("click", () => {
      activePeriod = button.dataset.period;
      document.querySelectorAll("[data-period]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
      if (currentPayload) render(currentPayload);
    });
  });
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => { if (currentPayload) render(currentPayload); }, 120);
  });
  loadData();
  window.setInterval(loadData, REFRESH_INTERVAL_MS);
  window.setInterval(() => {
    renderFreshness();
    // Advance rolling windows if an open tab crosses midnight in Moscow.
    if (currentPayload && byId("gas-profit-table").dataset.day !== moscowDay(new Date())) {
      byId("gas-profit-table").dataset.day = moscowDay(new Date());
      render(currentPayload);
    }
  }, 60 * 1000);
})();
