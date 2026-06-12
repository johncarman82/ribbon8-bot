const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

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

let ACTIVE    = true;
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
          console.log(`BTC Price: $${price}`);
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
      leverage: CONFIG.LEVERAGE,
      positionSide,
    });
    console.log(`Leverage response: ${JSON.stringify(result)}`);
  } catch(e) { console.error("Leverage failed:", e.message); }
}

async function placeTrade(side, price, slFromSignal = null) {
  if (!ACTIVE) { console.log("Bot is paused"); return; }
  if (!price || price === 0) { console.error("Invalid price — trade cancelled"); return; }

  const positionSide = side === "BUY" ? "LONG" : "SHORT";

  let slPrice;
  if (slFromSignal && parseFloat(slFromSignal) > 0) {
    slPrice = parseFloat(slFromSignal).toFixed(2);
    console.log(`SL from MR8 line: $${slPrice}`);
  } else {
    slPrice = side === "BUY"
      ? (price * (1 - CONFIG.SL_PCT)).toFixed(2)
      : (price * (1 + CONFIG.SL_PCT)).toFixed(2);
    console.log(`SL from CONFIG: $${slPrice}`);
  }

  const tpPrice = side === "BUY"
    ? (price * (1 + CONFIG.TP_PCT)).toFixed(2)
    : (price * (1 - CONFIG.TP_PCT)).toFixed(2);
  const qty = ((CONFIG.USDT_SIZE * CONFIG.LEVERAGE) / price).toFixed(4);

  console.log(`TRADE: ${side} @ $${price} | TP $${tpPrice} | SL $${slPrice} | Qty ${qty}`);

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
    } else {
      console.error(`Order failed: ${result.msg}`);
    }
  } catch(e) { console.error("Trade error:", e.message); }
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

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "running", active: ACTIVE, time: new Date().toISOString() }));
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
    await placeTrade(side, price, sl);
    res.writeHead(200); res.end("OK");
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
    await placeTrade(side, price, null);
    res.writeHead(200); res.end("OK");
    return;
  }

  if (req.method === "POST" && req.url === "/settings") {
    const body = await getBody();
    if (body.usdt_size) CONFIG.USDT_SIZE = body.usdt_size;
    if (body.leverage)  CONFIG.LEVERAGE  = body.leverage;
    if (body.sl_pct)    CONFIG.SL_PCT    = body.sl_pct;
    if (body.tp_pct)    CONFIG.TP_PCT    = body.tp_pct;
    console.log(`Settings: $${CONFIG.USDT_SIZE} | ${CONFIG.LEVERAGE}x | SL ${CONFIG.SL_PCT*100}% | TP ${CONFIG.TP_PCT*100}%`);
    res.writeHead(200); res.end("OK");
    return;
  }

  if (req.method === "POST" && req.url === "/toggle") {
    const body = await getBody();
    ACTIVE = body.active !== false;
    console.log(`Bot ${ACTIVE ? "ACTIVATED" : "PAUSED"}`);
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
  console.log(`║   SL:        ${CONFIG.SL_PCT*100}% (from MR8 line)        ║`);
  console.log(`║   TP:        ${CONFIG.TP_PCT*100}%                        ║`);
  console.log(`║   Port:      ${CONFIG.PORT}                          ║`);
  console.log("╚════════════════════════════════════════╝");
});
