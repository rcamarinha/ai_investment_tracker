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
    const body = await req.json();
    const { portfolio, prompt: customPrompt, perspective, requestType } = body;

    // When a fully-formed prompt is provided (e.g. movers analysis, trade ideas),
    // use it directly instead of building one from the portfolio.
    let promptContent: string;
    if (customPrompt) {
      promptContent = customPrompt;
    } else {
      if (!portfolio || !Array.isArray(portfolio) || portfolio.length === 0) {
        return new Response(
          JSON.stringify({ error: "Portfolio data or prompt is required" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      // Use the perspective-provided prompt if available, otherwise fall back to default
      if (perspective?.prompt) {
        const portfolioSummary = portfolio
          .map(
            (p: { shares: number; symbol: string; avgPrice: number; currentPrice?: number; type?: string }) =>
              `${p.shares} shares of ${p.symbol} at avg price $${p.avgPrice}${p.currentPrice ? ` (current: $${p.currentPrice})` : ''}`
          )
          .join(", ");

        promptContent = `${perspective.prompt}\n\nThe portfolio contains: ${portfolioSummary}.\n\nPlease provide your analysis in JSON format with these fields:\n- marketNews: an OBJECTIVE, perspective-neutral overview of current market conditions and recent notable events affecting equities, bonds, or macro (3-5 sentences). This section should be purely factual — no opinion from any investment philosophy.\n- marketOverview: your OPINIONATED assessment of these market conditions strictly through the lens of ${perspective.name}. Explain what a ${perspective.name} practitioner would focus on and how they would interpret current conditions (3-4 sentences). Make it clear this is a ${perspective.name} perspective.\n- portfolioImpact: evaluate the specific holdings in this portfolio through the ${perspective.name} lens — which positions align well with this philosophy, which don't, and why (3-4 sentences). Be specific about individual holdings.\n\nRespond ONLY with valid JSON, no markdown, no preamble.`;
      } else {
        const portfolioSummary = portfolio
          .map(
            (p: { shares: number; symbol: string; avgPrice: number }) =>
              `${p.shares} shares of ${p.symbol} at avg price $${p.avgPrice}`
          )
          .join(", ");

        promptContent = `You are a financial advisor AI. Analyze current market conditions and provide insights for a portfolio containing: ${portfolioSummary}.

Please provide your analysis in JSON format with these fields:
- marketOverview: brief overview of current market sentiment (2-3 sentences)
- portfolioImpact: how current conditions affect this specific portfolio (2-3 sentences)
- ideas: array of 3 actionable ideas, each with "title" and "description"

Respond ONLY with valid JSON, no markdown, no preamble.`;
      }
    }

    // For movers analysis, plain text response; otherwise JSON
    const maxTokens = requestType === 'movers' ? 350 : 4000;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: maxTokens,
        messages: [{ role: "user", content: promptContent }],
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
