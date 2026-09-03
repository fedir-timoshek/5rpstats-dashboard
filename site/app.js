(() => {
  "use strict";

  const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
  const STALE_AFTER_MS = 150 * 60 * 1000;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const numberFormatter = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
  const compactFormatter = new Intl.NumberFormat("ru-RU", {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  const dateFormatter = new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short",
    timeZone: "Europe/Moscow",
  });
  const PROFIT_SERIES = [
    {
      key: "gas",
      containerId: "gas-profit-chart",
      tableId: "gas-profit-table",
      label: "АЗС №6",
      color: "#ff9e45",
    },
    {
      key: "barbershop",
      containerId: "barbershop-profit-chart",
      tableId: "barbershop-profit-table",
      label: "Барбершоп №5",
      color: "#5de0c3",
    },
    {
      key: "store13",
      containerId: "store-profit-chart",
      tableId: "store-profit-table",
      label: "Магазин 24/7 №13",
      color: "#ff8eb5",
    },
  ];
  const timestampFormatter = new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  });

  let currentPayload = null;
  let resizeTimer = null;

  const byId = (id) => document.getElementById(id);

  function svgElement(name, attributes = {}) {
    const element = document.createElementNS(SVG_NS, name);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
    return element;
  }

  function formatMoney(value) {
    return Number.isFinite(value) ? `${numberFormatter.format(value)} $` : "Недостаточно данных";
  }

  function formatDate(day) {
    return dateFormatter.format(new Date(`${day}T12:00:00Z`));
  }

  function validatePayload(payload) {
    if (!payload || payload.schemaVersion !== 2 || !Array.isArray(payload.days)) {
      throw new Error("Формат облачных данных не поддерживается");
    }
    for (const day of payload.days) {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(day.date) ||
        !day.profits ||
        !day.online ||
        !day.profitSamples
      ) {
        throw new Error("Облачные данные не прошли проверку структуры");
      }
    }
    return payload;
  }

  function setCloudState(state, label) {
    const badge = byId("cloud-badge");
    badge.dataset.state = state;
    byId("cloud-status").textContent = label;
  }

  function setMessage(text, state = "warning") {
    const message = byId("global-message");
    message.hidden = !text;
    message.textContent = text || "";
    message.dataset.state = state;
  }

  function metricValue(id, value, unavailable = false) {
    const element = byId(id);
    element.textContent = value;
    element.title = unavailable ? "Нужен минимум ещё один успешный снимок" : "";
  }

  function renderMetrics(payload) {
    let latest = null;
    for (let index = payload.days.length - 1; index >= 0; index -= 1) {
      if (payload.days[index].isPartial) {
        latest = payload.days[index];
        break;
      }
    }
    metricValue(
      "gas-profit",
      latest ? formatMoney(latest.profits.gas) : "—",
      !latest || !Number.isFinite(latest.profits.gas),
    );
    metricValue(
      "barbershop-profit",
      latest ? formatMoney(latest.profits.barbershop) : "—",
      !latest || !Number.isFinite(latest.profits.barbershop),
    );
    metricValue(
      "store-profit",
      latest ? formatMoney(latest.profits.store13) : "—",
      !latest || !Number.isFinite(latest.profits.store13),
    );
    const onlineAvailable = latest && Number.isFinite(latest.online.min) && Number.isFinite(latest.online.max);
    metricValue(
      "online-range",
      onlineAvailable
        ? `${numberFormatter.format(latest.online.min)} — ${numberFormatter.format(latest.online.max)}`
        : "Недостаточно данных",
      !onlineAvailable,
    );
    metricValue("coverage-days", numberFormatter.format(payload.days.length));
  }

  function chartDimensions(container) {
    const width = Math.max(320, Math.round(container.getBoundingClientRect().width || 760));
    const height = width < 520 ? 280 : 340;
    return {
      width,
      height,
      // Compact currency labels such as "-19,9 тыс." still need more room than
      // a plain online count. Keep the shared plot margin wide enough that the
      // first characters are never clipped on narrow mobile cards.
      margin: { top: 24, right: 18, bottom: 46, left: width < 520 ? 70 : 76 },
    };
  }

  function linearScale(domainMin, domainMax, rangeMin, rangeMax) {
    const span = domainMax - domainMin || 1;
    return (value) => rangeMin + ((value - domainMin) / span) * (rangeMax - rangeMin);
  }

  function niceDomain(values, includeZero = false) {
    const finite = values.filter(Number.isFinite);
    if (!finite.length) return [-1, 1];
    let minimum = Math.min(...finite);
    let maximum = Math.max(...finite);
    if (includeZero) {
      minimum = Math.min(0, minimum);
      maximum = Math.max(0, maximum);
    }
    if (minimum === maximum) {
      const padding = Math.max(Math.abs(minimum) * 0.2, 1);
      minimum -= padding;
      maximum += padding;
    }
    const padding = (maximum - minimum) * 0.12;
    return [minimum - padding, maximum + padding];
  }

  function addGrid(svg, dimensions, domain, yScale, labelFormatter) {
    const { width, height, margin } = dimensions;
    const plotRight = width - margin.right;
    const plotBottom = height - margin.bottom;
    for (let index = 0; index <= 4; index += 1) {
      const value = domain[0] + ((domain[1] - domain[0]) * index) / 4;
      const y = yScale(value);
      svg.appendChild(svgElement("line", {
        x1: margin.left,
        x2: plotRight,
        y1: y,
        y2: y,
        class: "chart-grid-line",
      }));
      const label = svgElement("text", {
        x: margin.left - 10,
        y: y + 4,
        "text-anchor": "end",
        class: "chart-axis-label",
      });
      label.textContent = labelFormatter(value);
      svg.appendChild(label);
    }
    return plotBottom;
  }

  function addXAxisLabels(svg, days, dimensions, xForIndex) {
    const { height, margin } = dimensions;
    const step = Math.max(1, Math.ceil(days.length / (dimensions.width < 520 ? 5 : 9)));
    days.forEach((day, index) => {
      if (index % step !== 0 && index !== days.length - 1) return;
      const label = svgElement("text", {
        x: xForIndex(index),
        y: height - margin.bottom + 25,
        "text-anchor": "middle",
        class: "chart-axis-label",
      });
      label.textContent = formatDate(day.date);
      svg.appendChild(label);
    });
  }

  function renderEmpty(container, text) {
    container.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "chart-empty";
    empty.textContent = text;
    container.appendChild(empty);
    container.setAttribute("aria-busy", "false");
  }

  function renderProfitChart(days, series) {
    const container = byId(series.containerId);
    const values = days.map((day) => day.profits[series.key]);
    if (!values.some(Number.isFinite)) {
      renderEmpty(container, `${series.label}: прибыль появится после второго успешного снимка бизнеса.`);
      return;
    }
    const dimensions = chartDimensions(container);
    const { width, height, margin } = dimensions;
    const plotWidth = width - margin.left - margin.right;
    const plotBottom = height - margin.bottom;
    const [domainMin, domainMax] = niceDomain(values, true);
    const yScale = linearScale(domainMin, domainMax, plotBottom, margin.top);
    const groupWidth = plotWidth / Math.max(days.length, 1);
    const barWidth = Math.max(5, Math.min(38, groupWidth * 0.56));
    const xForIndex = (index) => margin.left + groupWidth * index + groupWidth / 2;
    const zeroY = yScale(0);
    const svg = svgElement("svg", {
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
      "aria-label": `Столбчатый график дневной прибыли ${series.label}`,
    });
    addGrid(svg, dimensions, [domainMin, domainMax], yScale, (value) => compactFormatter.format(value));
    svg.appendChild(svgElement("line", {
      x1: margin.left,
      x2: width - margin.right,
      y1: zeroY,
      y2: zeroY,
      class: "chart-zero-line",
    }));

    days.forEach((day, index) => {
      const value = day.profits[series.key];
      if (!Number.isFinite(value)) return;
      const valueY = yScale(value);
      const accessibleLabel = `${series.label}, ${formatDate(day.date)}: ${formatMoney(value)}${day.isPartial ? ", день ещё не завершён" : ""}`;
      const rect = svgElement("rect", {
        x: xForIndex(index) - barWidth / 2,
        y: Math.min(valueY, zeroY),
        width: barWidth,
        height: Math.max(2, Math.abs(zeroY - valueY)),
        rx: Math.min(5, barWidth / 3),
        fill: series.color,
        opacity: day.isPartial ? 0.7 : 0.9,
        class: "profit-bar",
        tabindex: "0",
        "aria-label": accessibleLabel,
      });
      const title = svgElement("title");
      title.textContent = accessibleLabel;
      rect.appendChild(title);
      svg.appendChild(rect);
    });
    addXAxisLabels(svg, days, dimensions, xForIndex);
    container.replaceChildren(svg);
    container.setAttribute("aria-busy", "false");
  }

  function linePath(points) {
    return points.map((point, index) => `${index ? "L" : "M"}${point[0].toFixed(1)},${point[1].toFixed(1)}`).join(" ");
  }

  function renderOnlineChart(days) {
    const container = byId("online-chart");
    const usableDays = days.filter((day) => Number.isFinite(day.online.min) && Number.isFinite(day.online.max));
    if (!usableDays.length) {
      renderEmpty(container, "Online появится после первого успешного наблюдения сервера.");
      return;
    }
    const dimensions = chartDimensions(container);
    const { width, height, margin } = dimensions;
    const plotWidth = width - margin.left - margin.right;
    const plotBottom = height - margin.bottom;
    const values = usableDays.flatMap((day) => [day.online.min, day.online.max]);
    const [domainMin, domainMax] = niceDomain(values, false);
    const yScale = linearScale(Math.max(0, domainMin), domainMax, plotBottom, margin.top);
    const xForIndex = (index) => {
      if (usableDays.length === 1) return margin.left + plotWidth / 2;
      return margin.left + (plotWidth * index) / (usableDays.length - 1);
    };
    const maxPoints = usableDays.map((day, index) => [xForIndex(index), yScale(day.online.max)]);
    const minPoints = usableDays.map((day, index) => [xForIndex(index), yScale(day.online.min)]);
    const svg = svgElement("svg", {
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
      "aria-label": "Линейный график минимального и максимального онлайна Chiliad по дням",
    });
    addGrid(
      svg,
      dimensions,
      [Math.max(0, domainMin), domainMax],
      yScale,
      (value) => numberFormatter.format(Math.round(value)),
    );
    if (usableDays.length > 1) {
      const bandPoints = [...maxPoints, ...minPoints.slice().reverse()]
        .map((point) => point.join(","))
        .join(" ");
      svg.appendChild(svgElement("polygon", { points: bandPoints, class: "online-band" }));
    }
    svg.appendChild(svgElement("path", { d: linePath(maxPoints), class: "online-line-max" }));
    svg.appendChild(svgElement("path", { d: linePath(minPoints), class: "online-line-min" }));
    [
      { points: maxPoints, key: "max", fill: "#9a8cff", label: "максимум" },
      { points: minPoints, key: "min", fill: "#5db7ff", label: "минимум" },
    ].forEach((series) => {
      series.points.forEach((point, index) => {
        const accessibleLabel = `${formatDate(usableDays[index].date)}, ${series.label}: ${numberFormatter.format(usableDays[index].online[series.key])}`;
        const circle = svgElement("circle", {
          cx: point[0],
          cy: point[1],
          r: 4,
          fill: series.fill,
          class: "online-point",
          tabindex: "0",
          "aria-label": accessibleLabel,
        });
        const title = svgElement("title");
        title.textContent = accessibleLabel;
        circle.appendChild(title);
        svg.appendChild(circle);
      });
    });
    addXAxisLabels(svg, usableDays, dimensions, xForIndex);
    container.replaceChildren(svg);
    container.setAttribute("aria-busy", "false");
  }

  function renderTable(id, headers, rows) {
    const table = byId(id);
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    headers.forEach((header) => {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = header;
      headRow.appendChild(cell);
    });
    head.appendChild(headRow);
    const body = document.createElement("tbody");
    rows.forEach((row) => {
      const tableRow = document.createElement("tr");
      row.forEach((value, index) => {
        const cell = document.createElement(index === 0 ? "th" : "td");
        if (index === 0) cell.scope = "row";
        cell.textContent = value;
        tableRow.appendChild(cell);
      });
      body.appendChild(tableRow);
    });
    table.replaceChildren(head, body);
  }

  function renderTables(days) {
    PROFIT_SERIES.forEach((series) => {
      renderTable(
        series.tableId,
        ["Дата", "Прибыль", "Статус"],
        days.map((day) => [
          formatDate(day.date),
          formatMoney(day.profits[series.key]),
          day.isPartial ? "Текущий день" : "Завершён",
        ]),
      );
    });
    renderTable(
      "online-table",
      ["Дата", "Минимум", "Максимум", "Наблюдений"],
      days.map((day) => [
        formatDate(day.date),
        Number.isFinite(day.online.min) ? numberFormatter.format(day.online.min) : "—",
        Number.isFinite(day.online.max) ? numberFormatter.format(day.online.max) : "—",
        numberFormatter.format(day.online.samples || 0),
      ]),
    );
  }

  function render(payload) {
    currentPayload = payload;
    const generatedAt = new Date(payload.generatedAt);
    const buildAge = Date.now() - generatedAt.getTime();
    const sourceTimes = Object.values(payload.sourceStatus || {})
      .map((status) => new Date(status?.lastObservedAt).getTime());
    const sourcesStale =
      sourceTimes.length !== PROFIT_SERIES.length ||
      sourceTimes.some((timestamp) => !Number.isFinite(timestamp) || Date.now() - timestamp > STALE_AFTER_MS);
    const stale = !Number.isFinite(buildAge) || buildAge > STALE_AFTER_MS || sourcesStale;
    byId("updated-at").textContent = Number.isNaN(generatedAt.getTime())
      ? "Неизвестно"
      : timestampFormatter.format(generatedAt);
    byId("timezone-label").textContent = `Дни: ${payload.timezoneLabel || "время источника"}`;
    setCloudState(stale ? "stale" : "fresh", stale ? "Данные задерживаются" : "GitHub cloud · актуально");
    setMessage(
      stale
        ? "Публикация или один из трёх источников старше 2,5 часов. Графики сохранены, а GitHub health-check проверяет collector runs."
        : "",
    );
    renderMetrics(payload);
    if (!payload.days.length) {
      PROFIT_SERIES.forEach((series) => {
        renderEmpty(
          byId(series.containerId),
          "История пока пуста. График появится после успешных часовых снимков.",
        );
      });
      renderEmpty(byId("online-chart"), "Online пока не получен.");
      renderTables([]);
      return;
    }
    PROFIT_SERIES.forEach((series) => renderProfitChart(payload.days, series));
    renderOnlineChart(payload.days);
    renderTables(payload.days);
  }

  async function loadData() {
    try {
      const response = await fetch(`./data/stats.json?ts=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      render(validatePayload(await response.json()));
    } catch (error) {
      console.error("Dashboard aggregate load failed", error);
      setCloudState("error", "Ошибка обновления");
      setMessage(
        "Не удалось загрузить облачный агрегат. Новая попытка произойдёт автоматически; сырые данные и секреты на странице не используются.",
        "error",
      );
      if (!currentPayload) {
        PROFIT_SERIES.forEach((series) => {
          renderEmpty(byId(series.containerId), "Данные временно недоступны.");
        });
        renderEmpty(byId("online-chart"), "Данные временно недоступны.");
      }
    }
  }

  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (currentPayload) render(currentPayload);
    }, 120);
  });

  loadData();
  window.setInterval(loadData, REFRESH_INTERVAL_MS);
})();
