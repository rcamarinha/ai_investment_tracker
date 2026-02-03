const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!ANTHROPIC_API_KEY) {
    return new Response(
      JSON.stringify({ error: "Anthropic API key not configured on server" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  try {
    const { portfolio } = await req.json();

    if (!portfolio || !Array.isArray(portfolio) || portfolio.length === 0) {
      return new Response(
        JSON.stringify({ error: "Portfolio data is required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Build the prompt from portfolio data
    const portfolioSummary = portfolio
      .map(
        (p: { shares: number; symbol: string; avgPrice: number }) =>
          `${p.shares} shares of ${p.symbol} at avg price $${p.avgPrice}`
      )
      .join(", ");

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [
          {
            role: "user",
            content: `You are a financial advisor AI. Analyze current market conditions and provide insights for a portfolio containing: ${portfolioSummary}.

Please provide your analysis in JSON format with these fields:
- marketOverview: brief overview of current market sentiment (2-3 sentences)
- portfolioImpact: how current conditions affect this specific portfolio (2-3 sentences)
- ideas: array of 3 actionable ideas, each with "title" and "description"

Respond ONLY with valid JSON, no markdown, no preamble.`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      return new Response(
        JSON.stringify({
          error: `Anthropic API error: ${response.status}`,
          details: errBody,
        }),
        {
          status: response.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const data = await response.json();

    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || "Internal server error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
