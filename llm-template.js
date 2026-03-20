const CHAT_MODEL_ID = "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b";
const DASHBOARD_MODEL_ID = "@cf/meta/llama-3.1-8b-instruct";
const CHAT_SYSTEM_PROMPT =
  "You are a helpful, friendly assistant. Provide concise and accurate responses.";
const DASHBOARD_SYSTEM_PROMPT = [
  "You analyze pharmacy dashboard data for store operators.",
  "Use only the facts provided in the input JSON.",
  "Do not invent numbers, names, or causes that are not present in the facts.",
  "Return exactly one valid JSON object only.",
  'Schema: {"model":"string","items":[{"title":"string","summary":"string","why_it_matters":"string","recommended_action":"string","severity":"high|medium|low","confidence":0.0,"source_refs":["string"]}]}',
  "Return between 1 and 5 items.",
  "Each item must be short, factual, written in Vietnamese, and focus on risk or opportunity.",
  "Each item must explain why the situation matters to the store and what action should be taken today.",
  "Avoid insights that only restate raw totals without interpretation.",
  "If sales_patterns are available, analyze peak hours and best selling days to suggest staff scheduling or marketing actions.",
  "Compare recent revenue trends with the 7-day forecast to determine if the store is on track.",
  "If financial_performance is available, analyze the net profit and highlight large expense categories that might be eroding profits.",
  "If top_products_30d is available, analyze the types of drugs being sold to infer the most common diseases or health trends in the local market. Suggest cross-selling supplements or relevant health services.",
  "If inventory_insights.potential_stockouts are available, calculate if (current_stock / avg_sales_per_day) is less than lead_time_days. If yes, issue a HIGH severity alert.",
  "For inventory_insights.dead_stock with no sales for over 30 days, suggest promotions to clear inventory as MEDIUM severity.",
  "Use only these source_refs values: today_kpis, month_kpis, revenue_trend_14d, revenue_signal_14d, top_products_30d, top_product_signal, inventory_health, inventory_pressure, restock, restock_risk, debt_summary, debt_signal, priority_actions, sales_patterns, inventory_insights, financial_performance.",
  "Do not return markdown, code fences, explanations, chain-of-thought, or <think> tags.",
].join(" ");
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "Content-Type, X-Internal-AI-Key",
};
const VALID_SEVERITIES = new Set(["high", "medium", "low"]);
const VALID_SOURCE_REFS = new Set([
  "today_kpis",
  "month_kpis",
  "revenue_trend_14d",
  "top_products_30d",
  "top_product_signal",
  "inventory_health",
  "inventory_pressure",
  "restock",
  "restock_risk",
  "debt_summary",
  "debt_signal",
  "revenue_signal_14d",
  "priority_actions",
  "sales_patterns",
  "inventory_insights",
  "financial_performance",
]);

function jsonResponse(body, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json; charset=utf-8");
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

function textResponse(body, init = {}) {
  const headers = new Headers(init.headers || {});
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(body, { ...init, headers });
}

function getInternalApiKey(env) {
  return String(env.INTERNAL_AI_KEY || env.AI_WORKER_API_KEY || "").trim();
}

function getDashboardModel(env) {
  return String(env.DASHBOARD_MODEL_ID || DASHBOARD_MODEL_ID).trim() || DASHBOARD_MODEL_ID;
}

function getChatModel(env) {
  return String(env.CHAT_MODEL_ID || CHAT_MODEL_ID).trim() || CHAT_MODEL_ID;
}

function getUsage(raw) {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  if (raw.usage && typeof raw.usage === "object") {
    return raw.usage;
  }

  return undefined;
}

function stripBom(text) {
  return String(text || "").replace(/^\uFEFF/, "");
}

async function parseJsonRequest(request) {
  const rawText = stripBom(await request.text());
  if (!rawText.trim()) {
    throw new Error("Request body is empty.");
  }
  return JSON.parse(rawText);
}

function extractAiText(raw) {
  if (typeof raw === "string") {
    return raw;
  }

  if (!raw || typeof raw !== "object") {
    throw new Error("AI returned an unsupported response shape.");
  }

  const candidates = [
    raw.response,
    raw.result?.response,
    raw.result?.output_text,
    raw.result?.text,
    raw.output_text,
    raw.text,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  throw new Error("AI response did not include text output.");
}

function stripCodeFences(text) {
  const trimmed = stripBom(String(text || "")).trim();
  if (trimmed.startsWith("```")) {
    const withoutOpen = trimmed.replace(/^```[a-zA-Z0-9_-]*\s*/, "");
    return withoutOpen.replace(/\s*```$/, "").trim();
  }
  return trimmed;
}

function stripThinking(text) {
  return String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function extractJsonObject(text) {
  const cleaned = stripCodeFences(stripThinking(text));
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("AI output did not contain a JSON object.");
  }
  return cleaned.slice(start, end + 1);
}

function normalizeInsightItem(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const title = String(item.title || "").trim();
  const summary = String(item.summary || "").trim();
  const whyItMatters = String(item.why_it_matters || item.why || summary).trim();
  const recommendedAction = String(item.recommended_action || item.action || "").trim();
  const severity = String(item.severity || "").trim().toLowerCase();
  const confidence = Number(item.confidence);
  const sourceRefs = Array.isArray(item.source_refs)
    ? item.source_refs
        .map((entry) => String(entry || "").trim())
        .filter((entry) => VALID_SOURCE_REFS.has(entry))
    : [];

  if (!title || !summary || !whyItMatters || !VALID_SEVERITIES.has(severity) || !sourceRefs.length) {
    return null;
  }

  return {
    title,
    summary,
    why_it_matters: whyItMatters,
    recommended_action: recommendedAction || "Kiểm tra chi tiết trên dashboard và xử lý trong ngày.",
    severity,
    confidence: Number.isFinite(confidence)
      ? Math.max(0, Math.min(1, confidence))
      : 0,
    source_refs: sourceRefs,
  };
}

function normalizeDashboardOutput(rawText, model) {
  const parsed = JSON.parse(extractJsonObject(rawText));
  const items = Array.isArray(parsed.items)
    ? parsed.items.map(normalizeInsightItem).filter(Boolean).slice(0, 5)
    : [];

  if (!items.length) {
    throw new Error("AI output did not include any valid insight items.");
  }

  return {
    model:
      String(parsed.model || "").trim() &&
      String(parsed.model || "").trim().toLowerCase() !== "string"
        ? String(parsed.model).trim()
        : model,
    items,
  };
}

function validateDashboardPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Request body must be a JSON object.");
  }

  if (!payload.facts || typeof payload.facts !== "object") {
    throw new Error("Request body must include a facts object.");
  }
}

function buildDashboardMessages(payload, model) {
  return [
    {
      role: "system",
      content: DASHBOARD_SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: [
        `Model: ${model}`,
        "Analyze the following dashboard facts and return JSON only.",
        JSON.stringify(payload),
      ].join("\n\n"),
    },
  ];
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function formatNumber(value, digits = 0) {
  return new Intl.NumberFormat("vi-VN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(toNumber(value));
}

function formatCurrency(value) {
  return `${formatNumber(value)} VND`;
}

function computeRevenueDelta(trendRows) {
  if (!Array.isArray(trendRows) || trendRows.length < 2) {
    return null;
  }

  const rows = trendRows.slice(-14);
  const midpoint = Math.floor(rows.length / 2);
  const previous = rows.slice(0, midpoint);
  const recent = rows.slice(midpoint);
  const previousRevenue = previous.reduce((sum, row) => sum + toNumber(row?.net_revenue), 0);
  const recentRevenue = recent.reduce((sum, row) => sum + toNumber(row?.net_revenue), 0);

  if (previousRevenue <= 0 && recentRevenue <= 0) {
    return null;
  }

  const delta = previousRevenue > 0
    ? ((recentRevenue - previousRevenue) / previousRevenue) * 100
    : 100;

  return {
    previousRevenue,
    recentRevenue,
    delta,
    recentInvoiceCount: recent.reduce((sum, row) => sum + toNumber(row?.invoice_count), 0),
  };
}

function buildFallbackDashboardInsights(payload, model) {
  const facts = payload?.facts && typeof payload.facts === "object" ? payload.facts : {};
  const items = [];

  const restock = facts.restock && typeof facts.restock === "object" ? facts.restock : {};
  const inventory = facts.inventory_health && typeof facts.inventory_health === "object" ? facts.inventory_health : {};
  const debt = facts.debt_summary && typeof facts.debt_summary === "object" ? facts.debt_summary : {};
  const month = facts.month_kpis && typeof facts.month_kpis === "object" ? facts.month_kpis : {};
  const topProducts = Array.isArray(facts.top_products_30d) ? facts.top_products_30d : [];
  const revenueDelta = computeRevenueDelta(facts.revenue_trend_14d);
  const salesPatterns = facts.sales_patterns && typeof facts.sales_patterns === "object" ? facts.sales_patterns : {};
  const inventoryInsights = facts.inventory_insights && typeof facts.inventory_insights === "object" ? facts.inventory_insights : {};

  const totalActionable = toNumber(restock.total_actionable);
  const criticalCount = toNumber(restock.critical_count);
  const highCount = toNumber(restock.high_count);
  const firstRestockItem = Array.isArray(restock.items) ? restock.items[0] : null;
  if (totalActionable > 0) {
    const daysCover = toNumber(firstRestockItem?.days_cover, -1);
    const leadName = String(firstRestockItem?.drug_name || firstRestockItem?.drug_code || "").trim();
    const leadText = leadName
      ? ` Mặt hàng cần ưu tiên là ${leadName}${daysCover >= 0 ? `, còn khoảng ${formatNumber(daysCover, 1)} ngày phủ hàng.` : "."}`
      : "";
    items.push({
      title: "Cần ưu tiên kế hoạch nhập hàng",
      summary: `Hiện có ${formatNumber(totalActionable)} mặt hàng cần hành động, gồm ${formatNumber(criticalCount)} mức critical và ${formatNumber(highCount)} mức high.${leadText}`,
      why_it_matters: `Nhóm mặt hàng này có thể làm hụt doanh thu nếu không xử lý sớm, đặc biệt khi số mã critical đang ở mức ${formatNumber(criticalCount)}.`,
      recommended_action: leadName
        ? `Kiểm tra tồn thực tế và ưu tiên đặt lại ${leadName} trước các mã khác trong hôm nay.`
        : "Ưu tiên rà soát và đặt lại ngay các mã critical trong danh sách nhập hàng.",
      severity: criticalCount > 0 ? "high" : highCount > 0 ? "medium" : "low",
      confidence: 0.96,
      source_refs: ["restock", "restock_risk"],
    });
  }

  const outOfStock = toNumber(inventory.out_of_stock);
  const lowStock = toNumber(inventory.low_stock);
  const expired = toNumber(inventory.expired);
  const expiringSoon = toNumber(inventory.expiring_soon);
  if (outOfStock > 0 || lowStock > 0 || expired > 0 || expiringSoon > 0) {
    items.push({
      title: "Sức khỏe tồn kho cần được theo dõi sát",
      summary: `Kho hiện có ${formatNumber(outOfStock)} mặt hàng hết hàng, ${formatNumber(lowStock)} mặt hàng tồn thấp, ${formatNumber(expiringSoon)} mặt hàng sắp hết hạn và ${formatNumber(expired)} mặt hàng đã hết hạn.`,
      why_it_matters: `Tổng cộng ${formatNumber(outOfStock + lowStock + expiringSoon + expired)} mã đang ở vùng rủi ro, làm tăng khả năng thiếu hàng hoặc hủy hàng cận hạn.`,
      recommended_action: "Kiểm kê ngay nhóm hết hàng và cận hạn, sau đó tách riêng các mã cần xả hàng hoặc dừng nhập.",
      severity: expired > 0 || outOfStock >= 10 ? "high" : lowStock > 0 || expiringSoon > 0 ? "medium" : "low",
      confidence: 0.94,
      source_refs: ["inventory_health", "inventory_pressure"],
    });
  }

  if (revenueDelta && Math.abs(revenueDelta.delta) >= 8) {
    const direction = revenueDelta.delta > 0 ? "tăng" : "giảm";
    items.push({
      title: `Doanh thu 14 ngày gần đây đang ${direction}`,
      summary: `Doanh thu 7 ngày gần nhất ${direction} ${formatNumber(Math.abs(revenueDelta.delta), 1)}% so với 7 ngày trước đó, với ${formatNumber(revenueDelta.recentInvoiceCount)} hóa đơn trong giai đoạn gần nhất.`,
      why_it_matters: "Biến động doanh thu ngắn hạn thường đi cùng thay đổi nhu cầu, thiếu hàng hoặc thay đổi hiệu quả bán hàng.",
      recommended_action: "Đối chiếu ngay nhóm sản phẩm bán chạy, tình trạng thiếu hàng và các thay đổi khuyến mãi để tìm nguyên nhân chính.",
      severity: revenueDelta.delta <= -15 ? "high" : Math.abs(revenueDelta.delta) >= 15 ? "medium" : "low",
      confidence: 0.88,
      source_refs: ["revenue_trend_14d", "revenue_signal_14d"],
    });
  }

  const totalDebt = toNumber(debt.customer_debt_total);
  const debtInvoiceCount = toNumber(debt.invoice_with_debt_count);
  if (totalDebt > 0) {
    items.push({
      title: "Cần theo dõi công nợ khách hàng",
      summary: `Công nợ hiện tại là ${formatCurrency(totalDebt)} trên ${formatNumber(debtInvoiceCount)} hóa đơn còn dư nợ.`,
      why_it_matters: "Công nợ tăng sẽ gây áp lực dòng tiền và làm giảm khả năng xoay vòng vốn nhập hàng.",
      recommended_action: "Lập danh sách các hóa đơn dư nợ lớn và ưu tiên nhắc thu hoặc chốt lịch thanh toán trong ngày.",
      severity: totalDebt >= 10000000 || debtInvoiceCount >= 10 ? "medium" : "low",
      confidence: 0.91,
      source_refs: ["debt_summary", "debt_signal"],
    });
  }

  const topProduct = topProducts[0];
  if (topProduct && typeof topProduct === "object") {
    const productName = String(topProduct.product_name || topProduct.product_code || "").trim();
    if (productName) {
      items.push({
        title: "Sản phẩm dẫn đầu cần được duy trì nguồn hàng",
        summary: `${productName} đang dẫn đầu 30 ngày gần đây với ${formatNumber(topProduct.sold_base_qty)} đơn vị bán ra và doanh thu ${formatCurrency(topProduct.net_revenue)}.`,
        why_it_matters: "Nếu sản phẩm dẫn đầu bị thiếu hàng, nhóm doanh thu ổn định nhất sẽ bị ảnh hưởng ngay.",
        recommended_action: `Theo dõi tồn thực tế của ${productName} và giữ mức tồn an toàn cao hơn các mã còn lại.`,
        severity: "low",
        confidence: 0.84,
        source_refs: ["top_products_30d", "top_product_signal"],
      });
    }
  }

  const potentialStockouts = Array.isArray(inventoryInsights.potential_stockouts) ? inventoryInsights.potential_stockouts : [];
  if (potentialStockouts.length > 0) {
    const item = potentialStockouts[0];
    const productName = String(item.product_name || "").trim();
    const currentStock = toNumber(item.current_stock);
    const avgSales = toNumber(item.avg_sales_per_day, 1);
    const leadTime = toNumber(item.lead_time_days, 0);
    const daysLeft = currentStock / avgSales;
    
    if (productName && daysLeft < leadTime) {
      items.push({
        title: `Nguy cơ đứt hàng: ${productName}`,
        summary: `Sản phẩm ${productName} còn ${formatNumber(currentStock)} đơn vị, tốc độ bán ${formatNumber(avgSales, 1)}/ngày, sẽ hết sau ~${formatNumber(daysLeft, 1)} ngày.`,
        why_it_matters: `Thời gian nhập hàng mất ${formatNumber(leadTime)} ngày. Lượng tồn hiện tại không đủ đáp ứng tốc độ bán ra.`,
        recommended_action: "Liên hệ nhà cung cấp ưu tiên đặt bổ sung gấp trong ngày hôm nay.",
        severity: "high",
        confidence: 0.95,
        source_refs: ["inventory_insights", "restock_risk"],
      });
    }
  }

  const deadStock = Array.isArray(inventoryInsights.dead_stock) ? inventoryInsights.dead_stock : [];
  if (deadStock.length > 0) {
    const item = deadStock[0];
    const productName = String(item.product_name || "").trim();
    const currentStock = toNumber(item.current_stock);
    const daysNoSales = toNumber(item.days_without_sales);
    
    if (productName && daysNoSales >= 30) {
      items.push({
        title: `Hàng tồn quá hạn luân chuyển: ${productName}`,
        summary: `Sản phẩm ${productName} đang tồn ${formatNumber(currentStock)} đơn vị, không phát sinh doanh thu trong ${formatNumber(daysNoSales)} ngày qua.`,
        why_it_matters: "Sản phẩm không có giao dịch dễ dẫn đến đọng vốn cục bộ và rủi ro hết hạn.",
        recommended_action: "Kiểm tra lại vị trí trưng bày và tạo chương trình khuyến mãi/combo để đẩy hàng.",
        severity: "medium",
        confidence: 0.90,
        source_refs: ["inventory_insights", "inventory_pressure"],
      });
    }
  }

  const peakHours = Array.isArray(salesPatterns.peak_hours) ? salesPatterns.peak_hours : [];
  if (peakHours.length > 0) {
    items.push({
      title: "Luồng khách đông vào giờ cao điểm",
      summary: `Dữ liệu gần đây cho thấy lượng khách tập trung đông nhất vào các khung giờ: ${peakHours.join(", ")}.`,
      why_it_matters: "Giờ cao điểm làm tăng thời gian chờ của khách và áp lực lên nhân viên thu ngân/tư vấn.",
      recommended_action: "Rà soát lại lịch phân ca, đảm bảo bố trí đủ nhân sự đứng quầy trong các khung giờ này.",
      severity: "low",
      confidence: 0.85,
      source_refs: ["sales_patterns", "revenue_signal_14d"],
    });
  }

  if (!items.length) {
    items.push({
      title: "Chưa phát hiện biến động lớn trên dashboard",
      summary: `Tháng hiện tại ghi nhận ${formatNumber(month.invoice_count)} hóa đơn với doanh thu ${formatCurrency(month.net_revenue)} và lợi nhuận gộp ${formatCurrency(month.gross_profit)}.`,
      why_it_matters: "Hiện chưa có tín hiệu rủi ro nổi bật vượt ngưỡng cần cảnh báo trong snapshot này.",
      recommended_action: "Tiếp tục theo dõi các mốc phân tích định kỳ và kiểm tra lại khi có biến động mới.",
      severity: "low",
      confidence: 0.8,
      source_refs: ["month_kpis", "today_kpis"],
    });
  }

  return {
    model: `${model}:fallback`,
    items: items.slice(0, 5),
  };
}

async function runDashboardInsight(request, env) {
  const expectedApiKey = getInternalApiKey(env);
  if (!expectedApiKey) {
    return jsonResponse(
      { error: "Worker internal API key is not configured." },
      { status: 500 },
    );
  }

  const receivedApiKey = String(request.headers.get("X-Internal-AI-Key") || "").trim();
  if (receivedApiKey !== expectedApiKey) {
    return jsonResponse({ error: "Unauthorized" }, { status: 401 });
  }

  let payload;
  try {
    payload = await parseJsonRequest(request);
    validateDashboardPayload(payload);
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Invalid JSON body." },
      { status: 400 },
    );
  }

  const model = getDashboardModel(env);

  try {
    const raw = await env.AI.run(model, {
      messages: buildDashboardMessages(payload, model),
      max_tokens: 900,
      temperature: 0.2,
    });
    const text = extractAiText(raw);
    let normalized;
    try {
      normalized = normalizeDashboardOutput(text, model);
    } catch (parseError) {
      console.warn("AI returned malformed dashboard JSON, using fallback insights.", {
        error: parseError instanceof Error ? parseError.message : String(parseError),
        preview: String(text || "").slice(0, 500),
      });
      normalized = buildFallbackDashboardInsights(payload, model);
    }
    const usage = getUsage(raw);

    return jsonResponse(
      usage ? { ...normalized, usage } : normalized,
      { status: 200 },
    );
  } catch (error) {
    console.error("Error processing dashboard insights, using fallback:", error);
    const fallback = buildFallbackDashboardInsights(payload, model);
    return jsonResponse(fallback, { status: 200 });
  }
}

async function handleChatRequest(request, env) {
  try {
    const { messages = [] } = await parseJsonRequest(request);
    const normalizedMessages = Array.isArray(messages) ? [...messages] : [];

    if (!normalizedMessages.some((message) => message?.role === "system")) {
      normalizedMessages.unshift({ role: "system", content: CHAT_SYSTEM_PROMPT });
    }

    const stream = await env.AI.run(getChatModel(env), {
      messages: normalizedMessages,
      max_tokens: 1024,
      stream: true,
    });

    return textResponse(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("Error processing chat request:", error);
    return jsonResponse(
      { error: "Failed to process request" },
      { status: 500 },
    );
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    if (url.pathname === "/api/chat") {
      if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, { status: 405 });
      }
      return handleChatRequest(request, env);
    }

    if (url.pathname === "/api/internal/dashboard-insights") {
      if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, { status: 405 });
      }
      return runDashboardInsight(request, env);
    }

    return jsonResponse({ error: "Not found" }, { status: 404 });
  },
};
