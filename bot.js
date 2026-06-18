const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CONFIG = {
  API_KEY:    "da7257b7b80b0d24624f88215b564466",
  SECRET_KEY: "d7edd407a5ed819a2c17612a7abbcd8d",
  SYMBOL:     "BTCUSDT",
  PORT:       process.env.PORT || 3000,
};

// ─────────────────────────────────────────────
// PERSISTENT STATE
// Both the on/off toggle AND the trade settings
// now live in this same file on disk. This fixes
// the bug where changing Position Size or Leverage
// on the dashboard worked for the very next trade
// but reverted to hardcoded defaults (100 / 5x)
// the moment the page was reloaded - because the
// sliders were never told what the server actually
// had saved. Same root cause as the earlier toggle
// bug, just on different fields.
// ─────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, "state.json");

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      active:      parsed.active !== undefined ? parsed.active : true,
      lastChanged: parsed.lastChanged || new Date().toISOString(),
      usdt_size:   parsed.usdt_size   || 100,
      leverage:    parsed.leverage    || 5,
      sl_pct:      parsed.sl_pct      || 0.02,
      tp_pct:      parsed.tp_pct      || 0.20,
    };
  } catch (e) {
    return {
      active: true,
      lastChanged: new Date().toISOString(),
      usdt_size: 100,
      leverage: 5,
      sl_pct: 0.02,
      tp_pct: 0.20,
    };
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (e) {
    console.error("Could not save state file:", e.message);
  }
}

let STATE = loadState();
let lastTrade = null;

function sign(nonce, timestamp, apiKey, queryParams, body, secretKey) {
  const digestInput = nonce + timestamp + apiKey + queryParams + body;
  const digest = crypto.createHash("sha256").update(digestInput).digest("hex");
  const signInput = digest + secretKey;
  return crypto.createHash("sha256").update(signInput).digest("hex");
}

function bitunixRequest(method, endpoint, body = {}) {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now().toString();
    const nonce = crypto.randomBytes(16).toString("hex");
    const payload = method === "POST" ? JSON.stringify(body) : "";
    const queryParams = endpoint.includes("?") ? endpoint.split("?")[1] : "";
    const signature = sign(nonce, timestamp, CONFIG.API_KEY, queryParams, payload, CONFIG.SECRET_KEY);

    const options = {
      hostname: "fapi.bitunix.com",
      path: endpoint,
      method,
      headers: {
        "Content-Type": "application/json",
        "api-key": CONFIG.API_KEY,
        "sign": signature,
        "timestamp": timestamp,
        "nonce": nonce,
        "language": "en-US",
      },
    };

    const req = https.request(options, (r) => {
      let data = "";
      r.on("data", chunk => data += chunk);
      r.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on("error", reject);
    if (method === "POST") req.write(payload);
    req.end();
  });
}

function getBTCPrice() {
  return new Promise((resolve) => {
    const options = {
      hostname: "fapi.bitunix.com",
      path: "/api/v1/futures/market/tickers?symbols=BTCUSDT",
      method: "GET",
      headers: { "Content-Type": "application/json" }
    };
    const req = https.request(options, (r) => {
      let data = "";
      r.on("data", chunk => data += chunk);
      r.on("end", () => {
        try {
          const json = JSON.parse(data);
          const price = parseFloat(json.data?.[0]?.lastPrice || 0);
          resolve(price);
        } catch(e) { resolve(0); }
      });
    });
    req.on("error", () => resolve(0));
    req.end();
  });
}

async function setLeverage(side) {
  const positionSide = side === "BUY" ? "LONG" : "SHORT";
  try {
    const result = await bitunixRequest("POST", "/api/v1/futures/account/set_leverage", {
      symbol: CONFIG.SYMBOL,
      leverage: STATE.leverage,
      positionSide,
    });
    console.log(`Leverage response: ${JSON.stringify(result)}`);
  } catch(e) { console.error("Leverage failed:", e.message); }
}

async function placeTrade(side, price, slFromSignal = null) {
  if (!STATE.active) {
    console.log(`SKIPPED - bot is paused (paused since ${STATE.lastChanged})`);
    return { skipped: true, reason: "paused" };
  }
  if (!price || price === 0) {
    console.error("Invalid price - trade cancelled");
    return { skipped: true, reason: "invalid_price" };
  }

  const positionSide = side === "BUY" ? "LONG" : "SHORT";

  let slPrice;
  if (slFromSignal && parseFloat(slFromSignal) > 0) {
    slPrice = parseFloat(slFromSignal).toFixed(2);
  } else {
    slPrice = side === "BUY"
      ? (price * (1 - STATE.sl_pct)).toFixed(2)
      : (price * (1 + STATE.sl_pct)).toFixed(2);
  }

  const tpPrice = side === "BUY"
    ? (price * (1 + STATE.tp_pct)).toFixed(2)
    : (price * (1 - STATE.tp_pct)).toFixed(2);
  const qty = ((STATE.usdt_size * STATE.leverage) / price).toFixed(4);

  console.log(`TRADE: ${side} @ $${price} | TP $${tpPrice} | SL $${slPrice} | Qty ${qty} | Size $${STATE.usdt_size} | Lev ${STATE.leverage}x`);

  lastTrade = { side, price, tp: tpPrice, sl: slPrice, time: new Date().toLocaleTimeString() };

  try {
    await setLeverage(side);
    const result = await bitunixRequest("POST", "/api/v1/futures/trade/place_order", {
      symbol: CONFIG.SYMBOL,
      side: side,
      qty: qty,
      orderType: "MARKET",
      tradeSide: "OPEN",
      tpPrice: tpPrice,
      slPrice: slPrice,
      tpStopType: "MARK_PRICE",
      slStopType: "MARK_PRICE",
    });
    console.log(`Bitunix response: ${JSON.stringify(result)}`);
    if (result.code === 0) {
      console.log(`Order placed! ID: ${result.data?.orderId}`);
      return { success: true, orderId: result.data?.orderId };
    } else {
      console.error(`Order failed: ${result.msg}`);
      return { success: false, error: result.msg };
    }
  } catch(e) {
    console.error("Trade error:", e.message);
    return { success: false, error: e.message };
  }
}

const server = http.createServer(async (req, res) => {

  if (req.method === "GET" && (req.url === "/" || req.url === "/dashboard")) {
    try {
      const html = fs.readFileSync(path.join(__dirname, "dashboard.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } catch(e) { res.writeHead(404); res.end("Dashboard not found"); }
    return;
  }

  // /health is now the single source of truth for
  // EVERYTHING the dashboard displays on load: not
  // just active/paused, but size, leverage, SL%, TP%
  // too. This is the actual fix for the bug reported.
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "running",
      active: STATE.active,
      lastChanged: STATE.lastChanged,
      usdt_size: STATE.usdt_size,
      leverage: STATE.leverage,
      sl_pct: STATE.sl_pct,
      tp_pct: STATE.tp_pct,
      time: new Date().toISOString()
    }));
    return;
  }

  if (req.method === "GET" && req.url === "/latest") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(lastTrade || {}));
    return;
  }

  const getBody = () => new Promise((resolve) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => { try { resolve(JSON.parse(body)); } catch(e) { resolve({}); } });
  });

  if (req.method === "POST" && req.url === "/webhook") {
    const signal = await getBody();
    console.log("Webhook received:", signal);
    const side  = signal.side;
    const price = parseFloat(signal.price);
    const sl    = signal.sl || null;
    if (!side || !price || (side !== "BUY" && side !== "SELL")) {
      res.writeHead(400); res.end("Invalid signal"); return;
    }
    const result = await placeTrade(side, price, sl);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  if (req.method === "POST" && req.url === "/manual") {
    const body = await getBody();
    const side  = body.side;
    const price = await getBTCPrice();
    console.log(`Manual trade: ${side} @ $${price}`);
    if (!side || (side !== "BUY" && side !== "SELL")) {
      res.writeHead(400); res.end("Invalid side"); return;
    }
    const result = await placeTrade(side, price, null);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  // /settings now writes into STATE and saves to
  // disk - exactly like /toggle already did. This
  // is what makes the values survive a page reload.
  if (req.method === "POST" && req.url === "/settings") {
    const body = await getBody();
    if (body.usdt_size) STATE.usdt_size = body.usdt_size;
    if (body.leverage)  STATE.leverage  = body.leverage;
    if (body.sl_pct)    STATE.sl_pct    = body.sl_pct;
    if (body.tp_pct)    STATE.tp_pct    = body.tp_pct;
    saveState(STATE);
    console.log(`Settings saved: $${STATE.usdt_size} | ${STATE.leverage}x | SL ${STATE.sl_pct*100}% | TP ${STATE.tp_pct*100}%`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(STATE));
    return;
  }

  if (req.method === "POST" && req.url === "/toggle") {
    const body = await getBody();
    STATE.active = body.active !== false;
    STATE.lastChanged = new Date().toISOString();
    saveState(STATE);
    console.log(`Bot ${STATE.active ? "ACTIVATED" : "PAUSED"} at ${STATE.lastChanged}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(STATE));
    return;
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(CONFIG.PORT, () => {
  console.log("====================================");
  console.log("McGinley Ribbon 8 Bot - LIVE");
  console.log("====================================");
  console.log(`Dashboard: /dashboard`);
  console.log(`Symbol:    ${CONFIG.SYMBOL}`);
  console.log(`Size:      $${STATE.usdt_size} USDT`);
  console.log(`Leverage:  ${STATE.leverage}x`);
  console.log(`SL:        ${STATE.sl_pct*100}% (or from MR8 line if signal includes it)`);
  console.log(`TP:        ${STATE.tp_pct*100}%`);
  console.log(`Port:      ${CONFIG.PORT}`);
  console.log(`STATE ON STARTUP: active=${STATE.active}, loaded from disk, last changed ${STATE.lastChanged}`);
  console.log("====================================");
});
