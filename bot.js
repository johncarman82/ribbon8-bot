const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ─────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────
const CONFIG = {
  API_KEY:    "da7257b7b80b0d24624f88215b564466",
  SECRET_KEY: "d7edd407a5ed819a2c17612a7abbcd8d",
  SYMBOL:     "BTCUSDT",
  USDT_SIZE:  100,
  LEVERAGE:   5,
  SL_PCT:     0.02,
  TP_PCT:     0.20,
  PORT:       process.env.PORT || 3000,
};

// ─────────────────────────────────────────────
// RUNTIME STATE
// ─────────────────────────────────────────────
let ACTIVE    = true;   // bot on/off switch
let lastTrade = null;   // last trade for dashboard polling

// ─────────────────────────────────────────────
// BITUNIX API
// ─────────────────────────────────────────────
function sign(params, secretKey) {
  const sorted = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join("&");
  return crypto.createHmac("sha256", secretKey).update(sorted).digest("hex");
}

function bitunixRequest(method, path, body = {}) {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now().toString();
    const nonce = Math.random().toString(36).substring(2, 18);
    const signParams = { ...body, timestamp, nonce };
    const signature = sign(signParams, CONFIG.SECRET_KEY);
    const payload = JSON.stringify(body);
    const options = {
      hostname: "fapi.bitunix.com",
      path, method,
      headers: {
        "Content-Type": "application/json",
        "api-key": CONFIG.API_KEY,
        "sign": signature,
        "timestamp": timestamp,
        "nonce": nonce,
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on("error", reject);
    if (method === "POST") req.write(payload);
    req.end();
  });
}

async function setLeverage(side) {
  const positionSide = side === "BUY" ? "LONG" : "SHORT";
  try {
    await bitunixRequest("POST", "/api/v1/futures/leverage", {
      symbol: CONFIG.SYMBOL, leverage: CONFIG.LEVERAGE, positionSide,
    });
    console.log(`✅ Leverage set to ${CONFIG.LEVERAGE}x`);
  } catch(e) { console.error("⚠️ Leverage failed:", e.message); }
}

async function closePosition(side) {
  const closeSide    = side === "BUY" ? "SELL" : "BUY";
  const positionSide = side === "BUY" ? "SHORT" : "LONG";
  try {
    await bitunixRequest("POST", "/api/v1/futures/order", {
      symbol: CONFIG.SYMBOL, side: closeSide, positionSide,
      orderType: "MARKET", qty: "0", reduceOnly: true,
    });
    console.log(`✅ Closed ${positionSide} position`);
  } catch(e) { console.error("⚠️ Close failed:", e.message); }
}

async function placeTrade(side, price) {
  if (!ACTIVE) {
    console.log("⏸ Bot is paused — signal ignored");
    return;
  }
  const positionSide = side === "BUY" ? "LONG" : "SHORT";
  const slPrice = side === "BUY"
    ? (price * (1 - CONFIG.SL_PCT)).toFixed(2)
    : (price * (1 + CONFIG.SL_PCT)).toFixed(2);
  const tpPrice = side === "BUY"
    ? (price * (1 + CONFIG.TP_PCT)).toFixed(2)
    : (price * (1 - CONFIG.TP_PCT)).toFixed(2);
  const qty = ((CONFIG.USDT_SIZE * CONFIG.LEVERAGE) / price).toFixed(4);

  console.log(`\n📡 ${side} @ $${price} | TP $${tpPrice} | SL $${slPrice} | Qty ${qty}`);

  // Store for dashboard
  lastTrade = {
    side, price, tp: tpPrice, sl: slPrice,
    time: new Date().toLocaleTimeString()
  };

  try {
    await setLeverage(side);
    await closePosition(side);
    const result = await bitunixRequest("POST", "/api/v1/futures/order", {
      symbol: CONFIG.SYMBOL, side, positionSide,
      orderType: "MARKET", qty,
      tpPrice, slPrice,
      tpStopType: "MARK_PRICE", slStopType: "MARK_PRICE",
    });
    if (result.code === 0) {
      console.log(`✅ Order placed! ID: ${result.data?.orderId}`);
    } else {
      console.error(`❌ Order failed: ${result.msg}`);
    }
  } catch(e) { console.error("❌ Trade error:", e.message); }
}
function getBTCPrice() {
  return new Promise((resolve) => {
    https.get("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", (btcRes) => {
      let data = "";
      btcRes.on("data", chunk => data += chunk);
      btcRes.on("end", () => {
        try { resolve(parseFloat(JSON.parse(data).price)); }
        catch(e) { resolve(0); }
      });
    }).on("error", () => resolve(0));
  });
}
// ─────────────────────────────────────────────

// HTTP SERVER
// ─────────────────────────────────────────────
const server = http.createServer(async (req, res) => {

  // Serve dashboard
  if (req.method === "GET" && (req.url === "/" || req.url === "/dashboard")) {
    try {
      const html = fs.readFileSync(path.join(__dirname, "dashboard.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } catch(e) {
      res.writeHead(404);
      res.end("Dashboard not found");
    }
    return;
  }

  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "running", active: ACTIVE, time: new Date().toISOString() }));
    return;
  }

  // Latest trade for dashboard polling
  if (req.method === "GET" && req.url === "/latest") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(lastTrade || {}));
    return;
  }

  // Parse POST body helper
  const getBody = () => new Promise((resolve) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => { try { resolve(JSON.parse(body)); } catch(e) { resolve({}); } });
  });

  // Webhook from TradingView
  if (req.method === "POST" && req.url === "/webhook") {
    const signal = await getBody();
    console.log("\n🔔 Webhook:", signal);
    const side  = signal.side;
    const price = parseFloat(signal.price);
    if (!side || !price || (side !== "BUY" && side !== "SELL")) {
      res.writeHead(400); res.end("Invalid signal"); return;
    }
    await placeTrade(side, price);
    res.writeHead(200); res.end("OK");
    return;
  }

  // Settings update from dashboard
  if (req.method === "POST" && req.url === "/settings") {
    const body = await getBody();
    if (body.usdt_size) CONFIG.USDT_SIZE = body.usdt_size;
    if (body.leverage)  CONFIG.LEVERAGE  = body.leverage;
    if (body.sl_pct)    CONFIG.SL_PCT    = body.sl_pct;
    if (body.tp_pct)    CONFIG.TP_PCT    = body.tp_pct;
    console.log(`⚙️  Settings updated: $${CONFIG.USDT_SIZE} | ${CONFIG.LEVERAGE}x | SL ${CONFIG.SL_PCT*100}% | TP ${CONFIG.TP_PCT*100}%`);
    res.writeHead(200); res.end("OK");
    return;
  }

  // Bot toggle from dashboard
  if (req.method === "POST" && req.url === "/toggle") {
    const body = await getBody();
    ACTIVE = body.active !== false;
    console.log(`🔄 Bot ${ACTIVE ? "ACTIVATED" : "PAUSED"}`);
    res.writeHead(200); res.end("OK");
    return;
  }

      // Manual trade from dashboard
      if (req.method === "POST" && req.url === "/manual") {
              const body = await getBody();
              const side = body.side;
              if (side !== "BUY" && side !== "SELL") {
                        res.writeHead(400); res.end("Invalid side"); return;
              }
              try {
                        const ticker = await bitunixRequest("GET", `/api/v1/futures/ticker?symbol=${CONFIG.SYMBOL}`);
                        const price = parseFloat(ticker?.data?.close || ticker?.data?.lastPrice || 0);
                        if (!price) { res.writeHead(500); res.end("Could not fetch price"); return; }
                        console.log(`\n🖱️ Manual ${side} @ $${price}`);
                        await placeTrade(side, price);
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ ok: true, side, price }));
              } catch(e) {
                        console.error("Manual trade error:", e.message);
                        res.writeHead(500); res.end("Trade failed");
              }
              return;
      }
 // Manual trade from dashboard
  if (req.method === "POST" && req.url === "/manual") {
    const body = await getBody();
    const side  = body.side;
    const price = await getBTCPrice();
    if (!side || (side !== "BUY" && side !== "SELL")) {
      res.writeHead(400); res.end("Invalid side"); return;
    }
    console.log(`\n🖐️ Manual trade fired: ${side} @ $${price}`);
    await placeTrade(side, price);
    res.writeHead(200); res.end("OK");
    return;
  }
    if (req.method === "POST" && req.url === "/manual") {
    const body = await getBody();
    const side  = body.side;
    const price = await getBTCPrice();
    if (!side || (side !== "BUY" && side !== "SELL")) {
      res.writeHead(400); res.end("Invalid side"); return;
    }
    console.log(`\n🖐️ Manual trade fired: ${side} @ $${price}`);
    await placeTrade(side, price);
    res.writeHead(200); res.end("OK");
    return;
  }
  res.writeHead(404); res.end("Not found");
});

server.listen(CONFIG.PORT, () => {
  console.log("╔════════════════════════════════════════╗");
  console.log("║   McGinley Ribbon 8 Bot — LIVE         ║");
  console.log("╠════════════════════════════════════════╣");
  console.log(`║   Dashboard: /dashboard                ║`);
  console.log(`║   Symbol:    ${CONFIG.SYMBOL}                    ║`);
  console.log(`║   Size:      $${CONFIG.USDT_SIZE} USDT                ║`);
  console.log(`║   Leverage:  ${CONFIG.LEVERAGE}x                           ║`);
  console.log(`║   SL:        ${CONFIG.SL_PCT*100}%                         ║`);
  console.log(`║   TP:        ${CONFIG.TP_PCT*100}%                        ║`);
  console.log(`║   Port:      ${CONFIG.PORT}                          ║`);
  console.log("╚════════════════════════════════════════╝");
});
