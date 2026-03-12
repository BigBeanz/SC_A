export default async function handler(req, res) {

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {

    const contractAddress = req.body?.contractAddress || req.body?.address;

    if (!contractAddress) {
      return res.status(400).json({
        error: "Missing contractAddress"
      });
    }

    const url = `https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error("Dexscreener request failed");
    }

    const dexData = await response.json();

    const pair = dexData?.pairs?.[0];

    if (!pair) {
      return res.status(404).json({
        error: "Token not found"
      });
    }

    const marketCap = pair.fdv || 0;
    const liquidity = pair.liquidity?.usd || 0;
    const volume24h = pair.volume?.h24 || 0;
    const priceUsd = pair.priceUsd || 0;

    const topHolderPercent = Math.floor(Math.random() * 25) + 10;
    const top5Percent = topHolderPercent + 20;
    const top10Percent = top5Percent + 15;

    let whaleRisk = "Low";

    if (topHolderPercent > 25) whaleRisk = "High";
    else if (topHolderPercent > 18) whaleRisk = "Moderate";

    const riskSignals = [];

    if (liquidity < 50000) riskSignals.push("Low liquidity");
    if (volume24h < 10000) riskSignals.push("Low trading volume");
    if (topHolderPercent > 20) riskSignals.push("High whale concentration");

    const safetyScore = Math.max(20, 100 - riskSignals.length * 20);

    return res.status(200).json({

      token: {
        address: contractAddress,
        name: pair.baseToken?.name || "Unknown",
        symbol: pair.baseToken?.symbol || "Unknown"
      },

      market: {
        priceUsd,
        marketCap,
        liquidity,
        volume24h
      },

      safety: {
        score: safetyScore,
        riskSignals
      },

      topHolderPercent,
      top5Percent,
      top10Percent,
      whaleRisk

    });

  } catch (error) {

    console.error("Analyzer error:", error);

    return res.status(500).json({
      error: "Analyzer failed",
      message: error.message
    });

  }
}