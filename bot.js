const http = require("http");
const https = require("https");
const crypto = require("crypto");

const CONFIG = {
  API_KEY:    "da7257b7b80b0d24624f88215b564466",
  SECRET_KEY: "d7edd407a5ed819a2c17612a7abbcd8d",
  SYMBOL:     "BTCUSDT",
  USDT_SIZE:  1000,
  LEVERAGE:   5,
  SL_PCT:     0.02,
  TP_PCT:     0.20,
  PORT:       process.env.PORT || 3000,
};

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
      path,
      method,
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
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
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
      symbol: CONFIG.SYMBOL,
      leverage: CONFIG.LEVERAGE,
      positionSide: positionSide,
    });
    console.log(`✅ Leverage set to ${CONFIG.LEVERAGE}x for ${positionSide}`);
  } catch (e) {
    console.error("⚠️ Leverage set failed:", e.message);
  }
}

async function closePosition(side) {
  const closeSide = side === "BUY" ? "SELL" : "BUY";
  const positionSide = side === "BUY" ? "SHORT" : "LONG";
  try {
    await bitunixRequest("POST", "/api/v1/futures/order", {
      symbol: CONFIG.SYMBOL,
      side: closeSide,
      positionSide: positionSide,
      orderType: "MARKET",
      qty: "0",
      reduceOnly: true,
    });
    console.log(`✅ Closed existing ${positionSide} position`);
  } catch (e) {
    console.error("⚠️ Close position failed:", e.message);
  }
}

async function placeTrade(side, price) {
  const positionSide = side === "BUY" ? "LONG" : "SHORT";
  const slPrice = side === "BUY"
    ? (price * (1 - CONFIG.SL_PCT)).toFixed(2)
    : (price * (1 + CONFIG.SL_PCT)).toFixed(2);
  const tpPrice = side === "BUY"
    ? (price * (1 + CONFIG.TP_PCT)).toFixed(2)
    : (price * (1 - CONFIG.TP_PCT)).toFixed(2);
  const notional = CONFIG.USDT_SIZE * CONFIG.LEVERAGE;
  const qty = (notional / price).toFixed(4);

  console.log(`\n📡 Signal received: ${side}`);
  console.log(`   Price:    $${price}`);
  console.log(`   Qty:      ${qty} BTC`);
  console.log(`   TP:       $${tpPrice}`);
  console.log(`   SL:       $${slPrice}`);

  try {
    await setLeverage(side);
    await closePosition(side);
    const result = await bitunixRequest("POST", "/api/v1/futures/order", {
      symbol: CONFIG.SYMBOL,
      side: side,
      positionSide: positionSide,
      orderType: "MARKET",
      qty: qty,
      tpPrice: tpPrice,
      slPrice: slPrice,
      tpStopType: "MARK_PRICE",
      slStopType: "MARK_PRICE",
    });
    if (result.code === 0) {
      console.log(`✅ Trade placed! Order ID: ${result.data?.orderId}`);
    } else {
      console.error(`❌ Trade failed: ${result.msg}`);
    }
    return result;
  } catch (e) {
    console.error("❌ Trade error:", e.message);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/webhook") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const signal = JSON.parse(body);
        console.log("\n🔔 Webhook received:", signal);
        const side = signal.side;
        const price = parseFloat(signal.price);
        if (!side || !price || (side !== "BUY" && side !== "SELL")) {
          res.writeHead(400);
          res.end("Invalid signal");
          return;
        }
        await placeTrade(side, price);
        res.writeHead(200);
        res.end("OK");
      } catch (e) {
        console.error("❌ Webhook error:", e.message);
        res.writeHead(400);
        res.end("Bad request");
      }
    });
  } else if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200);
    res.end(JSON.stringify({ status: "running", time: new Date().toISOString() }));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(CONFIG.PORT, () => {
  console.log("╔════════════════════════════════════════╗");
  console.log("║   McGinley Ribbon 8 Bot — LIVE         ║");
  console.log("╠════════════════════════════════════════╣");
  console.log(`║   Symbol:   ${CONFIG.SYMBOL}                    ║`);
  console.log(`║   Size:     $${CONFIG.USDT_SIZE} USDT               ║`);
  console.log(`║   Leverage: ${CONFIG.LEVERAGE}x                           ║`);
  console.log(`║   SL:       ${CONFIG.SL_PCT * 100}%                         ║`);
  console.log(`║   TP:       ${CONFIG.TP_PCT * 100}%                        ║`);
  console.log(`║   Port:     ${CONFIG.PORT}                          ║`);
  console.log("╚════════════════════════════════════════╝");
});

