/* =====================================================================
 * 宝くじシミュレータ（年末ジャンボ）
 * - 各くじを独立に抽選する近似モデルで連続購入をシミュレート
 * - 使った金額 / 当選総額 / 収支 / 回収率 をリアルタイム更新
 * ===================================================================== */
(function () {
  "use strict";

  /* ---------- くじの定義（年末ジャンボ・1ユニット2,000万枚） ---------- */
  const TICKET_PRICE = 300; // 1枚の値段（円）
  const UNIT = 20000000; // 1ユニットの枚数

  // amount: 当選金, count: 1ユニットあたりの本数, big: 高額演出の対象
  const PRIZES = [
    { name: "1等", amount: 700000000, count: 1, big: true },
    { name: "1等前後賞", amount: 150000000, count: 2, big: true },
    { name: "1等組違い賞", amount: 100000, count: 199, big: false },
    { name: "2等", amount: 10000000, count: 3, big: true },
    { name: "3等", amount: 1000000, count: 100, big: true },
    { name: "4等", amount: 100000, count: 2000, big: false },
    { name: "5等", amount: 10000, count: 20000, big: false },
    { name: "6等", amount: 3000, count: 200000, big: false },
    { name: "7等", amount: 300, count: 2000000, big: false },
  ];

  // 1枚あたりの理論期待値・還元率
  const EV = PRIZES.reduce((s, p) => s + (p.amount * p.count) / UNIT, 0);
  const THEORY_RATE = (EV / TICKET_PRICE) * 100; // 約45.83%

  // 抽選テーブル：はずれ + 各等級を確率降順に並べ、累積確率を持たせる
  // （ホットループでよく出る順に判定して比較回数を減らす）
  const DRAW_TABLE = (function () {
    const pSum = PRIZES.reduce((s, p) => s + p.count / UNIT, 0);
    const entries = [{ idx: -1, p: 1 - pSum }]; // はずれ
    PRIZES.forEach((p, i) => entries.push({ idx: i, p: p.count / UNIT }));
    entries.sort((a, b) => b.p - a.p);
    let cum = 0;
    const table = entries.map((e) => {
      cum += e.p;
      return { idx: e.idx, cum: cum };
    });
    table[table.length - 1].cum = 1; // 浮動小数の誤差対策
    return table;
  })();

  // 1枚抽選して当選等級のindexを返す（-1 = はずれ）
  function drawOne() {
    const r = Math.random();
    for (let i = 0; i < DRAW_TABLE.length; i++) {
      if (r < DRAW_TABLE[i].cum) return DRAW_TABLE[i].idx;
    }
    return -1;
  }

  /* ---------- 速度プリセット（枚/秒） ---------- */
  const SPEEDS = [
    { label: "スロー", rate: 2 },
    { label: "標準", rate: 30 },
    { label: "高速", rate: 1000 },
    { label: "超高速", rate: 50000 },
    { label: "爆速", rate: 2000000 },
  ];
  const DEFAULT_SPEED_INDEX = 1;
  const MAX_PER_FRAME = 250000; // 1フレームの最大抽選数（フリーズ防止）

  const LOG_FLOOR = 3000; // この金額以上の当選を履歴に記録（6等以上）
  const LOG_CAP = 500; // 履歴バッファの上限
  const LOG_VIEW = 200; // 表示する最大件数
  const CHART_CAP = 1000; // グラフの最大点数

  /* ---------- 状態 ---------- */
  const state = {
    running: false,
    rate: SPEEDS[DEFAULT_SPEED_INDEX].rate,
    spent: 0,
    won: 0,
    count: 0,
    hits: 0,
    tierCounts: new Array(PRIZES.length).fill(0),
    log: [], // { n, idx, amount }
    chart: [], // { n, rate }
    budget: null,
    carry: 0, // 端数の繰り越し
    lastTime: 0,
    dirtyLog: true,
  };

  /* ---------- DOM参照 ---------- */
  const $ = (id) => document.getElementById(id);
  const el = {
    toggle: $("toggle"),
    reset: $("reset"),
    speedButtons: $("speedButtons"),
    budget: $("budget"),
    ticketCard: $("ticketCard"),
    ticketStatus: $("ticketStatus"),
    ticketNumber: $("ticketNumber"),
    ticketResult: $("ticketResult"),
    statSpent: $("statSpent"),
    statCount: $("statCount"),
    statWon: $("statWon"),
    statHits: $("statHits"),
    statBalance: $("statBalance"),
    statRate: $("statRate"),
    theoryRate: $("theoryRate"),
    breakdownBody: $("breakdownBody"),
    logList: $("logList"),
    logFilter: $("logFilter"),
    chart: $("chart"),
    chartNote: $("chartNote"),
  };

  /* ---------- 数値フォーマット ---------- */
  // 億/万を使った読みやすい表記（賞金向け）
  function formatJP(n) {
    if (n < 10000) return n.toLocaleString() + "円";
    const oku = Math.floor(n / 1e8);
    const man = Math.floor((n % 1e8) / 1e4);
    const rest = Math.round(n % 1e4);
    let s = "";
    if (oku > 0) s += oku + "億";
    if (man > 0) s += man.toLocaleString() + "万";
    if (rest > 0) s += rest.toLocaleString();
    return s + "円";
  }
  // ¥ + カンマ区切り（合計金額向け・正確）
  function formatYen(n) {
    const sign = n < 0 ? "-" : "";
    return sign + "¥" + Math.abs(Math.round(n)).toLocaleString();
  }
  // 枚数の概算表記（X枚 / X万枚 / X億枚）
  function formatCount(n) {
    if (n < 10000) return n.toLocaleString() + " 枚";
    if (n < 1e8) return (n / 1e4).toFixed(n % 1e4 === 0 ? 0 : 1) + " 万枚";
    return (n / 1e8).toFixed(2) + " 億枚";
  }
  // ランダムなくじ番号（組 + 6桁番号）
  function randomTicketNo() {
    const kumi = String(1 + Math.floor(Math.random() * 100)).padStart(2, "0");
    const num = String(100000 + Math.floor(Math.random() * 100000));
    return kumi + " 組 " + num;
  }

  /* ---------- 速度ボタン生成 ---------- */
  function buildSpeedButtons() {
    SPEEDS.forEach((s, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "speed-btn" + (i === DEFAULT_SPEED_INDEX ? " active" : "");
      b.textContent = s.label;
      b.dataset.index = String(i);
      b.addEventListener("click", () => setSpeed(i));
      el.speedButtons.appendChild(b);
    });
  }
  function setSpeed(i) {
    state.rate = SPEEDS[i].rate;
    [...el.speedButtons.children].forEach((b, idx) =>
      b.classList.toggle("active", idx === i)
    );
  }

  /* ---------- 開始 / 停止 / リセット ---------- */
  function start() {
    if (state.running) return;
    // 予算上限の読み取り
    const v = parseInt(el.budget.value, 10);
    state.budget = Number.isFinite(v) && v > 0 ? v : null;
    if (state.budget != null && state.spent >= state.budget) {
      // すでに使い切っている場合はリセットを促す
      el.ticketResult.textContent = "予算に達しています。リセットしてください。";
      return;
    }
    state.running = true;
    state.lastTime = performance.now();
    state.carry = 0;
    el.toggle.textContent = "■ 停止";
    el.toggle.classList.add("running");
    el.ticketStatus.textContent = "購入中…";
  }
  function stop() {
    state.running = false;
    el.toggle.textContent = "▶ 開始";
    el.toggle.classList.remove("running");
    el.ticketStatus.textContent = "停止中";
  }
  function reset() {
    stop();
    state.spent = 0;
    state.won = 0;
    state.count = 0;
    state.hits = 0;
    state.tierCounts.fill(0);
    state.log.length = 0;
    state.chart.length = 0;
    state.carry = 0;
    state.dirtyLog = true;
    el.ticketStatus.textContent = "待機中";
    el.ticketNumber.textContent = "— 組 ——————";
    el.ticketResult.textContent = "開始ボタンを押してください";
    el.ticketResult.className = "ticket-result";
    el.ticketCard.classList.remove("flash", "flash-big");
    renderStats();
    renderBreakdown();
    renderLog();
    renderChart();
  }

  /* ---------- 履歴記録 ---------- */
  function pushLog(n, idx, amount) {
    state.log.push({ n: n, idx: idx, amount: amount });
    if (state.log.length > LOG_CAP) state.log.shift();
    state.dirtyLog = true;
  }

  /* ---------- メインループ ---------- */
  let flashTimer = null;
  function tick(now) {
    requestAnimationFrame(tick);
    if (!state.running) {
      state.lastTime = now;
      return;
    }

    const dt = (now - state.lastTime) / 1000;
    state.lastTime = now;

    let toDraw = state.rate * dt + state.carry;
    let whole = Math.floor(toDraw);
    state.carry = toDraw - whole;
    if (whole <= 0) return;
    if (whole > MAX_PER_FRAME) {
      whole = MAX_PER_FRAME;
      state.carry = 0; // 追いつかない分は捨てる
    }

    // 予算上限で頭打ち
    let reachedBudget = false;
    if (state.budget != null) {
      const affordable = Math.max(
        0,
        Math.floor((state.budget - state.spent) / TICKET_PRICE)
      );
      if (whole >= affordable) {
        whole = affordable;
        reachedBudget = true;
      }
    }

    // --- 抽選（ホットループ） ---
    let frameBestIdx = -2; // -2:無し, -1:はずれ, >=0:当選
    let frameBestAmount = -1;
    let lastIdx = -1;
    for (let i = 0; i < whole; i++) {
      const idx = drawOne();
      state.count++;
      state.spent += TICKET_PRICE;
      lastIdx = idx;
      if (idx >= 0) {
        const amt = PRIZES[idx].amount;
        state.won += amt;
        state.hits++;
        state.tierCounts[idx]++;
        if (amt >= LOG_FLOOR) pushLog(state.count, idx, amt);
        if (amt > frameBestAmount) {
          frameBestAmount = amt;
          frameBestIdx = idx;
        }
      } else if (frameBestIdx === -2) {
        frameBestIdx = -1;
      }
    }

    updateTicketCard(frameBestIdx, lastIdx);
    recordChart();

    // 描画
    renderStats();
    renderBreakdown();
    renderChart();
    maybeRenderLog(now);

    if (reachedBudget) {
      stop();
      el.ticketResult.textContent = "予算を使い切りました";
    }
  }

  /* ---------- 購入中のくじカード ---------- */
  function updateTicketCard(frameBestIdx, lastIdx) {
    el.ticketNumber.textContent = randomTicketNo();
    // そのフレームで一番高い当選を優先表示。無ければ最後の抽選結果。
    const showIdx = frameBestIdx >= 0 ? frameBestIdx : lastIdx;
    if (showIdx >= 0) {
      const p = PRIZES[showIdx];
      el.ticketResult.textContent = "🎉 " + p.name + " " + formatJP(p.amount) + " 当選！";
      el.ticketResult.className = "ticket-result win";
      if (frameBestIdx >= 0) flashCard(PRIZES[frameBestIdx]);
    } else {
      el.ticketResult.textContent = "はずれ";
      el.ticketResult.className = "ticket-result lose";
    }
  }
  function flashCard(prize) {
    const cls = prize.big ? "flash-big" : "flash";
    el.ticketCard.classList.remove("flash", "flash-big");
    // reflowを挟んでアニメを確実に再発火
    void el.ticketCard.offsetWidth;
    el.ticketCard.classList.add(cls);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      el.ticketCard.classList.remove("flash", "flash-big");
    }, prize.big ? 900 : 450);
  }

  /* ---------- 主要指標 ---------- */
  function renderStats() {
    const balance = state.won - state.spent;
    const rate = state.spent > 0 ? (state.won / state.spent) * 100 : 0;
    el.statSpent.textContent = formatYen(state.spent);
    el.statCount.textContent = formatCount(state.count);
    el.statWon.textContent = formatYen(state.won);
    el.statHits.textContent = "当選 " + state.hits.toLocaleString() + " 回";
    el.statBalance.textContent = formatYen(balance);
    el.statBalance.className =
      "stat-value " + (balance > 0 ? "pos" : balance < 0 ? "neg" : "");
    el.statRate.textContent =
      state.spent > 0 ? "回収率 " + rate.toFixed(1) + "%" : "回収率 —";
  }

  /* ---------- 等級別内訳 ---------- */
  function renderBreakdown() {
    const rows = PRIZES.map((p, i) => {
      const c = state.tierCounts[i];
      const odds = "1/" + Math.round(UNIT / p.count).toLocaleString();
      const total = c * p.amount;
      return (
        '<tr class="' + (c > 0 ? "hit" : "") + '">' +
        '<td class="tier-name">' + p.name + "</td>" +
        '<td class="num">' + formatJP(p.amount) + "</td>" +
        '<td class="num">' + odds + "</td>" +
        '<td class="num">' + c.toLocaleString() + "</td>" +
        '<td class="num">' + (total > 0 ? formatYen(total) : "—") + "</td>" +
        "</tr>"
      );
    });
    el.breakdownBody.innerHTML = rows.join("");
  }

  /* ---------- 当選履歴 ---------- */
  let lastLogRender = 0;
  function maybeRenderLog(now) {
    if (!state.dirtyLog) return;
    if (now - lastLogRender < 120) return; // 描画は最大~8fpsに間引き
    lastLogRender = now;
    renderLog();
    state.dirtyLog = false;
  }
  function renderLog() {
    const min = parseInt(el.logFilter.value, 10) || 0;
    const items = [];
    for (let i = state.log.length - 1; i >= 0 && items.length < LOG_VIEW; i--) {
      const e = state.log[i];
      if (e.amount < min) continue;
      const p = PRIZES[e.idx];
      const cls = p.amount >= 100000000 ? "tier-top" : p.amount >= 1000000 ? "tier-high" : "";
      items.push(
        '<li class="' + cls + '">' +
        '<span class="log-when">' + e.n.toLocaleString() + " 枚目</span>" +
        '<span class="log-tier">' + p.name + "</span>" +
        '<span class="log-amount">' + formatJP(e.amount) + "</span>" +
        "</li>"
      );
    }
    if (items.length === 0) {
      el.logList.innerHTML =
        '<li class="log-empty">該当する当選はまだありません</li>';
    } else {
      el.logList.innerHTML = items.join("");
    }
  }

  /* ---------- グラフ（回収率の推移） ---------- */
  function recordChart() {
    const rate = state.spent > 0 ? (state.won / state.spent) * 100 : 0;
    state.chart.push({ n: state.count, rate: rate });
    if (state.chart.length > CHART_CAP) {
      // 一様に間引いて全区間の形を保つ
      const next = [];
      for (let i = 0; i < state.chart.length; i += 2) next.push(state.chart[i]);
      state.chart = next;
    }
  }

  function renderChart() {
    const canvas = el.chart;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
      canvas.width = cssW * dpr;
      canvas.height = cssH * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const padL = 44, padR = 12, padT = 14, padB = 24;
    const w = cssW - padL - padR;
    const h = cssH - padT - padB;
    const data = state.chart;

    // Y軸スケール：理論線(45.83%)と100%、実測の最大値を見渡せるように
    let maxRate = THEORY_RATE * 1.2;
    for (let i = 0; i < data.length; i++) if (data[i].rate > maxRate) maxRate = data[i].rate;
    const yMax = Math.max(60, Math.min(maxRate * 1.05, 100000));
    const xMax = data.length > 0 ? data[data.length - 1].n : 1;

    const yToPx = (v) => padT + h - (v / yMax) * h;
    const xToPx = (v) => padL + (xMax > 0 ? (v / xMax) * w : 0);

    // グリッド + Y軸ラベル
    ctx.font = "11px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.strokeStyle = "#2c344f";
    ctx.fillStyle = "#9aa3bd";
    ctx.lineWidth = 1;
    const ticks = niceTicks(yMax, 4);
    ctx.textAlign = "right";
    ticks.forEach((t) => {
      const y = yToPx(t);
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + w, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(t + "%", padL - 6, y);
    });

    // 理論還元率の線
    const yTheory = yToPx(THEORY_RATE);
    ctx.strokeStyle = "#ffce54";
    ctx.globalAlpha = 0.85;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, yTheory);
    ctx.lineTo(padL + w, yTheory);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // 実測の回収率
    if (data.length >= 2) {
      ctx.strokeStyle = "#5b8cff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < data.length; i++) {
        const x = xToPx(data[i].n);
        const y = yToPx(Math.min(data[i].rate, yMax));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // X軸ラベル（枚数）
    ctx.fillStyle = "#9aa3bd";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillText("0", padL, padT + h + 6);
    ctx.textAlign = "right";
    ctx.fillText(formatCount(xMax), padL + w, padT + h + 6);
  }

  // 見やすい目盛りを作る
  function niceTicks(max, count) {
    const raw = max / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
    const ticks = [];
    for (let v = 0; v <= max + 1e-9; v += step) {
      ticks.push(Math.round(v * 100) / 100);
    }
    return ticks;
  }

  /* ---------- イベント ---------- */
  el.toggle.addEventListener("click", () => (state.running ? stop() : start()));
  el.reset.addEventListener("click", reset);
  el.logFilter.addEventListener("change", () => {
    state.dirtyLog = true;
    renderLog();
  });
  window.addEventListener("resize", renderChart);

  /* ---------- 初期化 ---------- */
  buildSpeedButtons();
  el.theoryRate.textContent = THEORY_RATE.toFixed(2) + "%";
  renderStats();
  renderBreakdown();
  renderChart();
  requestAnimationFrame(tick);
})();
