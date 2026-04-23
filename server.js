/**
 * server.js — Mia Backend v5 (Lovable AI Gateway)
 * Migrado de Anthropic → Lovable AI (Gemini 2.5 Flash) pra resolver rate limit de tokens.
 */

const express = require("express");
const cors    = require("cors");
const redis   = require("redis");
const { v4: uuid } = require("uuid");

// ─── Config ───────────────────────────────────────────────────────────────────

const app  = express();
const PORT = process.env.PORT || 3001;

// Lovable AI Gateway (formato OpenAI-compatível)
const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY;
const LOVABLE_AI_URL  = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MODEL           = process.env.MIA_MODEL || "google/gemini-2.5-flash";
// Alternativas: "openai/gpt-5-mini" (mais caro, melhor tool-use), "google/gemini-3-flash-preview"

// Supabase MCP
const API_MCP_TOKEN = process.env.API_MCP_TOKEN;
const API_MCP_URL   = "https://bsmjvixagmmmoffpbtuw.supabase.co/functions/v1/api-mcp";

console.log("🔧 LOVABLE_API_KEY:", LOVABLE_API_KEY ? "✅ OK" : "❌ MISSING");
console.log("🔧 API_MCP_TOKEN:  ", API_MCP_TOKEN ? "✅ OK" : "❌ MISSING");
console.log("🔧 MODEL:          ", MODEL);
console.log("🔧 REDIS_URL:      ", process.env.REDIS_URL ? "✅ OK" : "⚠️  localhost");

app.use(cors({ origin: "*" }));
app.use(express.json());

// ─── Redis (memória de sessão) ─────────────────────────────────────────────────

const redisClient = redis.createClient({ url: process.env.REDIS_URL || "redis://localhost:6379" });
redisClient.connect().catch((e) => console.error("Redis:", e.message));

async function getHistory(sessionId) {
  try {
    const raw = await redisClient.get(`mia:${sessionId}`);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

async function saveHistory(sessionId, messages) {
  try {
    // Mantém só as últimas 30 msgs pra evitar contexto inflado
    await redisClient.setEx(`mia:${sessionId}`, 7200, JSON.stringify(messages.slice(-30)));
  } catch { /* ignora */ }
}

// ─── MCP caller (igual antes) ─────────────────────────────────────────────────

function parseMcpResponse(rawText) {
  if (rawText.includes("data:")) {
    const results = [];
    for (const line of rawText.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const json = JSON.parse(line.slice(6));
        const content = json.result?.content;
        if (Array.isArray(content)) {
          results.push(...content.map((c) => c.text ?? JSON.stringify(c)));
        } else if (json.result) {
          results.push(JSON.stringify(json.result, null, 2));
        }
      } catch { /* ignora */ }
    }
    if (results.length) return results.join("\n");
  }
  let json;
  try { json = JSON.parse(rawText); } catch { return rawText; }
  if (json.error) throw new Error(`api-mcp error: ${json.error.message}`);
  const content = json.result?.content;
  if (Array.isArray(content)) {
    return content.map((c) => c.text ?? JSON.stringify(c)).join("\n");
  }
  return JSON.stringify(json.result ?? json, null, 2);
}

async function callMcpTool(toolName, args) {
  if (!API_MCP_TOKEN) {
    return "API_MCP_TOKEN não configurado no Railway.";
  }

  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "Authorization": `Bearer ${API_MCP_TOKEN}`,
  };

  // Handshake
  try {
    const initRes = await fetch(API_MCP_URL, {
      method: "POST", headers,
      body: JSON.stringify({
        jsonrpc: "2.0", method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: { roots: { listChanged: false } },
          clientInfo: { name: "mia-backend", version: "5.0.0" },
        },
        id: 0,
      }),
    });
    const sessionId = initRes.headers.get("Mcp-Session-Id");
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  } catch (e) {
    console.warn(`⚠️ [MCP] Initialize falhou: ${e.message}`);
  }

  console.log(`🔧 [MCP] ${toolName}`, JSON.stringify(args));
  const res = await fetch(API_MCP_URL, {
    method: "POST", headers,
    body: JSON.stringify({
      jsonrpc: "2.0", method: "tools/call",
      params: { name: toolName, arguments: args },
      id: Date.now(),
    }),
  });

  const rawText = await res.text();
  console.log(`🔧 [MCP] ${toolName} → ${res.status}`);
  if (!res.ok) throw new Error(`api-mcp HTTP ${res.status}: ${rawText.slice(0, 300)}`);
  return parseMcpResponse(rawText);
}

// ─── Tools — convertidas para formato OpenAI ──────────────────────────────────
// Antes: { name, description, input_schema } (Anthropic)
// Agora: { type: "function", function: { name, description, parameters } } (OpenAI)

const TOOL_DEFS = [
  {
    name: "erp_buscar_cliente",
    description: "Busca cliente no ERP MK por CPF/CNPJ ou código interno.",
    parameters: {
      type: "object",
      properties: {
        cpf_cnpj:   { type: "string", description: "CPF ou CNPJ (apenas dígitos)" },
        cd_cliente: { type: "string", description: "Código do cliente no MK" },
      },
    },
  },
  {
    name: "erp_os_em_atraso",
    description: "Lista OS em atraso. Se data_abertura omitida ou 'hoje', usa data atual de São Paulo.",
    parameters: {
      type: "object",
      properties: {
        data_abertura: { type: "string", description: "dd/MM/yyyy ou 'hoje'" },
      },
    },
  },
  {
    name: "plataforma_reincidencias",
    description: "Lista reincidências dos últimos N dias (default 30) com cliente, chamados e valor economizado.",
    parameters: {
      type: "object",
      properties: {
        dias: { type: "number", description: "Últimos N dias (default 30)" },
      },
    },
  },
  {
    name: "listar_reincidencias_recentes",
    description: "Lista reincidências dos últimos N dias (default 7).",
    parameters: {
      type: "object",
      properties: {
        dias: { type: "number", description: "Últimos N dias (default 7)" },
      },
    },
  },
  {
    name: "listar_cs_tickets_pendentes",
    description: "Tickets de Customer Success ainda sem resposta da IA.",
    parameters: {
      type: "object",
      properties: { limit: { type: "number", description: "Máximo (default 20)" } },
    },
  },
  {
    name: "listar_auditorias_recentes",
    description: "Auditorias concluídas nos últimos N dias.",
    parameters: {
      type: "object",
      properties: { dias: { type: "number", description: "Últimos N dias (default 7)" } },
    },
  },
  {
    name: "plataforma_query",
    description: "Query genérico de leitura. Tabelas permitidas: recurrences, cs_tickets, audits, evaluations, schedule_slots, service_schedules, vehicle_inspections, system_events.",
    parameters: {
      type: "object",
      properties: {
        tabela:  { type: "string", description: "Nome da tabela (whitelist)" },
        dias:    { type: "number", description: "Últimos N dias (default 30)" },
        limit:   { type: "number", description: "Máximo (default 50, max 200)" },
        filtros: { type: "object", description: "Filtros eq simples: { coluna: valor }" },
      },
      required: ["tabela"],
    },
  },
  {
    name: "listar_eventos_nao_processados",
    description: "Eventos do sistema ainda não processados pela IA.",
    parameters: {
      type: "object",
      properties: { limit: { type: "number", description: "Máximo (default 30)" } },
    },
  },
  {
    name: "publicar_evento",
    description: "Publica novo evento em system_events.",
    parameters: {
      type: "object",
      properties: {
        source:      { type: "string" },
        event_type:  { type: "string" },
        payload:     { type: "object" },
        severity:    { type: "string", enum: ["info", "warning", "critical"] },
        entity_type: { type: "string" },
        entity_id:   { type: "string" },
      },
      required: ["source", "event_type"],
    },
  },
  {
    name: "marcar_eventos_processados",
    description: "Marca eventos como processados pela IA.",
    parameters: {
      type: "object",
      properties: {
        event_ids: { type: "array", items: { type: "string" } },
      },
      required: ["event_ids"],
    },
  },
];

// Wrap pro formato OpenAI
const TOOLS = TOOL_DEFS.map((t) => ({ type: "function", function: t }));

// ─── Helpers de data BR ───────────────────────────────────────────────────────

function todayBR() {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit", month: "2-digit", year: "numeric",
  }).format(new Date());
}

function sanitizeDates(text) {
  if (!text) return text;
  const today = todayBR();
  return text.replace(
    /\b(hoje[^\d]{0,20}|data\s+de\s+hoje[^\d]{0,20}|atual[^\d]{0,20})(\d{2}\/\d{2}\/\d{4})/gi,
    (_m, prefix) => `${prefix}${today}`
  );
}

function buildSystemPrompt() {
  const hoje = todayBR();
  return `Você é a Mia, assistente inteligente da Megalink OPS — sistema operacional interno da Megalink Telecom.

⚠️ CONTEXTO TEMPORAL CRÍTICO:
- HOJE é ${hoje} (fuso America/Sao_Paulo).
- NUNCA use outra data como "hoje". Ignore datas que apareçam em exemplos do seu treinamento.
- Se uma ferramenta retornar campos como "hoje_brasil", "data_abertura_usada" ou "instrucao_para_o_modelo", esses valores são a verdade absoluta — use-os literalmente.

## Ferramentas
- **ERP MK:** erp_buscar_cliente, erp_os_em_atraso
- **Plataforma:** plataforma_reincidencias, listar_reincidencias_recentes, listar_cs_tickets_pendentes, listar_auditorias_recentes, plataforma_query (whitelist de tabelas)
- **Eventos:** listar_eventos_nao_processados, publicar_evento, marcar_eventos_processados

## Regras
1. Sempre use ferramentas antes de responder sobre dados internos — nunca invente.
2. Para datas em ferramentas do ERP, use dd/MM/yyyy. Quando o usuário disser "hoje", use ${hoje}.
3. Para tickets CS use plataforma_query com tabela "cs_tickets" (ou listar_cs_tickets_pendentes).
4. Responda em português brasileiro. Markdown quando ajudar na leitura.
5. Seja direto e objetivo — você é coworker, não assistente genérico.`;
}

// ─── Chamada ao Lovable AI Gateway (com tool-use loop) ────────────────────────

async function callLovableAI(messages) {
  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: buildSystemPrompt() },
      ...messages,
    ],
    tools: TOOLS,
    tool_choice: "auto",
  };

  const res = await fetch(LOVABLE_AI_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${LOVABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 429) throw new Error("Rate limit do Lovable AI. Aguarde alguns segundos.");
    if (res.status === 402) throw new Error("Créditos do Lovable AI esgotados. Adicione no workspace.");
    throw new Error(`Lovable AI HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }

  return res.json();
}

// ─── Rota principal: chat com SSE ─────────────────────────────────────────────

app.post("/api/agent/chat", async (req, res) => {
  const { message, sessionId: clientSessionId } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: "Mensagem vazia" });

  const sessionId = clientSessionId || uuid();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Session-Id", sessionId);
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const history  = await getHistory(sessionId);
  const messages = [...history, { role: "user", content: message.trim() }];

  try {
    let iteracoes = 0;

    while (iteracoes < 10) {
      iteracoes++;

      const response = await callLovableAI(messages);
      const choice = response.choices?.[0];
      if (!choice) throw new Error("Resposta vazia do Lovable AI");

      const msg = choice.message;
      const finishReason = choice.finish_reason;

      // Texto da resposta
      if (msg.content) {
        send({ type: "text", content: sanitizeDates(msg.content) });
      }

      // Tool calls (formato OpenAI: array com {id, function:{name, arguments}})
      const toolCalls = msg.tool_calls || [];

      if (finishReason === "stop" || toolCalls.length === 0) {
        // Salva mensagem final do assistente
        if (msg.content) messages.push({ role: "assistant", content: msg.content });
        break;
      }

      // Adiciona mensagem do assistente com tool_calls
      messages.push({
        role: "assistant",
        content: msg.content || "",
        tool_calls: toolCalls,
      });

      // Executa todas as tools em paralelo
      const toolResults = await Promise.all(
        toolCalls.map(async (call) => {
          const name = call.function.name;
          let args = {};
          try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* ignora */ }

          send({ type: "tool_start", tool: name });

          let result;
          try {
            result = await callMcpTool(name, args);
          } catch (e) {
            result = `Erro ao chamar ${name}: ${e.message}`;
          }

          send({ type: "tool_result", tool: name });

          return {
            role: "tool",
            tool_call_id: call.id,
            content: typeof result === "string" ? result : JSON.stringify(result),
          };
        })
      );

      messages.push(...toolResults);
    }

    await saveHistory(sessionId, messages);
    send({ type: "done" });
  } catch (e) {
    console.error("❌ chat error:", e.message);
    send({ type: "error", error: e.message });
  } finally {
    res.end();
  }
});

// ─── Diagnóstico ──────────────────────────────────────────────────────────────

app.get("/api/debug/ai", async (_req, res) => {
  if (!LOVABLE_API_KEY) return res.status(500).json({ error: "LOVABLE_API_KEY não configurada" });
  try {
    const r = await fetch(LOVABLE_AI_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    res.json({ status: r.status, body: await r.text() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", agent: "Mia", version: "5.0.0", model: MODEL });
});

app.delete("/api/agent/session/:id", async (req, res) => {
  try { await redisClient.del(`mia:${req.params.id}`); } catch { /* ignora */ }
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`✅ Mia v5 (Lovable AI) na porta ${PORT}`));
