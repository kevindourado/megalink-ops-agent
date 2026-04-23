/**
 * server.js — Mia Backend v4 (nomes de ferramentas corrigidos)
 * Ferramentas espelham exatamente o api-mcp do Supabase.
 */

const express = require("express");
const cors    = require("cors");
const Anthropic = require("@anthropic-ai/sdk").default;
const redis   = require("redis");
const { v4: uuid } = require("uuid");

// ─── Config ───────────────────────────────────────────────────────────────────

const app  = express();
const PORT = process.env.PORT || 3001;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Supabase MCP
const API_MCP_TOKEN = process.env.API_MCP_TOKEN;
const API_MCP_URL   = "https://bsmjvixagmmmoffpbtuw.supabase.co/functions/v1/api-mcp";

// Valida variáveis críticas no boot
console.log("🔧 ANTHROPIC_API_KEY:", process.env.ANTHROPIC_API_KEY ? "✅ OK" : "❌ MISSING");
console.log("🔧 API_MCP_TOKEN:    ", API_MCP_TOKEN ? "✅ OK" : "❌ MISSING");
console.log("🔧 REDIS_URL:        ", process.env.REDIS_URL ? "✅ OK" : "⚠️  usando localhost");

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
    // 2h em vez de 8h — evita arrastar contexto stale (datas antigas etc)
    await redisClient.setEx(`mia:${sessionId}`, 7200, JSON.stringify(messages.slice(-40)));
  } catch { /* ignora */ }
}

// ─── Chamador MCP (JSON-RPC → api-mcp do Supabase) ───────────────────────────

/**
 * Extrai texto de uma resposta MCP (JSON ou SSE).
 */
function parseMcpResponse(rawText) {
  // Resposta SSE: linhas "data: {...}"
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
      } catch { /* ignora linhas mal formadas */ }
    }
    if (results.length) return results.join("\n");
  }

  // Resposta JSON pura
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
    const msg = "API_MCP_TOKEN não configurado no Railway. Adicione a variável de ambiente.";
    console.error("❌", msg);
    return msg;
  }

  // Headers padrão MCP Streamable HTTP
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "Authorization": `Bearer ${API_MCP_TOKEN}`,
  };

  // ── Passo 1: initialize (handshake obrigatório do protocolo MCP) ──────────
  try {
    const initRes = await fetch(API_MCP_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: { roots: { listChanged: false } },
          clientInfo: { name: "mia-backend", version: "4.0.0" },
        },
        id: 0,
      }),
    });

    // Se o servidor mantém sessão stateful, captura o ID
    const sessionId = initRes.headers.get("Mcp-Session-Id");
    if (sessionId) {
      headers["Mcp-Session-Id"] = sessionId;
      console.log(`🔧 [MCP] Session-Id: ${sessionId}`);
    }

    console.log(`🔧 [MCP] Initialize → ${initRes.status}`);
  } catch (e) {
    console.warn(`⚠️ [MCP] Initialize falhou (${e.message}), tentando tool call direto`);
  }

  // ── Passo 2: tools/call ───────────────────────────────────────────────────
  console.log(`🔧 [MCP] Chamando tool: ${toolName}`, JSON.stringify(args));

  const res = await fetch(API_MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: toolName, arguments: args },
      id: Date.now(),
    }),
  });

  const rawText = await res.text();
  console.log(`🔧 [MCP] ${toolName} → Status: ${res.status}`);
  console.log(`🔧 [MCP] Raw: ${rawText.slice(0, 600)}`);

  if (!res.ok) {
    throw new Error(`api-mcp HTTP ${res.status}: ${rawText}`);
  }

  return parseMcpResponse(rawText);
}

// ─── Definições de ferramentas (nomes EXATOS do api-mcp) ─────────────────────

const TOOLS = [
  // ── ERP MK ──
  {
    name: "erp_buscar_cliente",
    description: "Busca cliente no ERP MK por CPF/CNPJ ou código interno. Retorna dados cadastrais, conexões, contratos e saldo.",
    input_schema: {
      type: "object",
      properties: {
        cpf_cnpj:   { type: "string", description: "CPF ou CNPJ (apenas dígitos)" },
        cd_cliente: { type: "string", description: "Código do cliente no MK" },
      },
      required: [],
    },
  },
  {
    name: "erp_faturas_cliente",
    description: "Consulta faturas (em aberto / vencidas) de um cliente no ERP MK.",
    input_schema: {
      type: "object",
      properties: {
        cd_cliente: { type: "string", description: "Código do cliente no MK" },
      },
      required: ["cd_cliente"],
    },
  },
  {
    name: "erp_os_em_atraso",
    description: "Lista as ordens de serviço em atraso a partir de uma data de abertura.",
    input_schema: {
      type: "object",
      properties: {
        data_abertura: { type: "string", description: "Data no formato dd/MM/yyyy" },
      },
      required: ["data_abertura"],
    },
  },

  // ── Plataforma Megalink ──
  {
    name: "plataforma_listar_colaboradores",
    description: "Lista colaboradores cadastrados na plataforma Megalink. Pode filtrar por equipe.",
    input_schema: {
      type: "object",
      properties: {
        team: { type: "string", description: "Nome da equipe (parcial)" },
      },
      required: [],
    },
  },
  {
    name: "plataforma_auditorias_recentes",
    description: "Lista auditorias técnicas recentes (status, equipe, responsável, comentário do auditor).",
    input_schema: {
      type: "object",
      properties: {
        limit:  { type: "number", description: "Número máximo de registros" },
        status: { type: "string", description: "Filtrar por status: em_andamento ou finalizada" },
      },
      required: [],
    },
  },
  {
    name: "plataforma_reincidencias",
    description: "Lista reincidências cadastradas (cliente, chamados vinculados, valor economizado).",
    input_schema: {
      type: "object",
      properties: {
        cliente: { type: "string", description: "Nome do cliente para filtrar" },
        limit:   { type: "number", description: "Número máximo de registros" },
      },
      required: [],
    },
  },
  {
    name: "plataforma_avaliacoes_colaborador",
    description: "Retorna últimas avaliações de um colaborador (histórico de notas, status, área).",
    input_schema: {
      type: "object",
      properties: {
        collaborator: { type: "string", description: "Nome do colaborador" },
        limit:        { type: "number", description: "Máximo de registros (padrão 10)" },
      },
      required: ["collaborator"],
    },
  },
  {
    name: "plataforma_query",
    description: "Consulta SELECT em tabelas internas da plataforma. Use para buscar tickets CS, leads, requisições de compra, agendamentos e mais.",
    input_schema: {
      type: "object",
      properties: {
        table: {
          type: "string",
          description: "Tabela a consultar",
          enum: [
            "collaborators",
            "evaluations",
            "audits",
            "recurrences",
            "leads",
            "vehicle_inspections",
            "survey_responses",
            "cs_tickets",
            "purchase_requests",
            "schedule_slots",
            "service_schedules",
            "technician_regions",
            "tech_metrics_cache",
          ],
        },
        filter_column: { type: "string", description: "Coluna para filtrar (opcional)" },
        filter_value:  { type: "string", description: "Valor do filtro (opcional)" },
        limit:         { type: "number", description: "Número máximo de registros (padrão 20)" },
      },
      required: ["table"],
    },
  },

  // ── Comunicação ──
  {
    name: "slack_enviar_mensagem",
    description: "Envia uma mensagem para um canal Slack da Megalink.",
    input_schema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "ID do canal Slack (ex: C0123456) ou nome (ex: #operacoes)" },
        text:    { type: "string", description: "Texto da mensagem (suporta mrkdwn)" },
      },
      required: ["channel", "text"],
    },
  },
  {
    name: "whatsapp_enviar_zenvia",
    description: "Envia mensagem WhatsApp via Zenvia para um cliente ou colaborador.",
    input_schema: {
      type: "object",
      properties: {
        to:   { type: "string", description: "Telefone destino no formato 55DDDNNNNNNNNN" },
        text: { type: "string", description: "Texto da mensagem" },
      },
      required: ["to", "text"],
    },
  },
  {
    name: "whatsapp_historico_conversa",
    description: "Retorna as últimas mensagens de WhatsApp (Zenvia) trocadas com um número.",
    input_schema: {
      type: "object",
      properties: {
        phone: { type: "string", description: "Número no formato 55DDDNNNNNNNNN" },
        limit: { type: "number", description: "Número de mensagens a retornar" },
      },
      required: ["phone"],
    },
  },
];

// ─── Helpers de data BR ────────────────────────────────────────────────────────

function todayBR() {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit", month: "2-digit", year: "numeric",
  }).format(new Date());
}

// Sanitiza datas alucinadas em frases tipo "hoje 09/07/2025" → "hoje 23/04/2026"
function sanitizeDates(text) {
  if (!text) return text;
  const today = todayBR();
  return text.replace(
    /\b(hoje[^\d]{0,20}|data\s+de\s+hoje[^\d]{0,20}|atual[^\d]{0,20})(\d{2}\/\d{2}\/\d{4})/gi,
    (_m, prefix) => `${prefix}${today}`
  );
}

// ─── System prompt (gerado dinâmico p/ injetar a data correta) ────────────────

function buildSystemPrompt() {
  const hoje = todayBR();
  return `Você é a Mia, assistente inteligente da Megalink OPS — o sistema operacional interno da Megalink Telecom.

⚠️ CONTEXTO TEMPORAL CRÍTICO:
- HOJE é ${hoje} (fuso America/Sao_Paulo).
- NUNCA use outra data como "hoje". Ignore datas que apareçam em exemplos do seu treinamento.
- Se uma ferramenta retornar campos como "hoje_brasil", "data_abertura_usada" ou "instrucao_para_o_modelo", esses valores são a verdade absoluta — use-os literalmente.

Você tem acesso direto aos dados reais da empresa via ferramentas integradas ao backend da plataforma.

## Ferramentas disponíveis
- **ERP MK:** buscar clientes, consultar faturas em aberto/vencidas, listar OS em atraso
- **Plataforma:** listar colaboradores, auditorias recentes, reincidências, avaliações individuais, query livre em tabelas internas (tickets CS, leads, agendamentos, requisições de compra, inspeções de veículo e mais)
- **Slack:** enviar mensagens e alertas para canais internos
- **WhatsApp (Zenvia):** enviar mensagens e consultar histórico de conversas com clientes

## Regras
1. Use sempre as ferramentas antes de responder sobre dados internos — nunca invente números, nomes ou datas.
2. Para datas em ferramentas do ERP, use o formato dd/MM/yyyy. Quando o usuário disser "hoje", use ${hoje}.
3. Para tickets CS, use a ferramenta \`plataforma_query\` com \`table: "cs_tickets"\`.
4. Ao enviar mensagens no Slack ou WhatsApp, confirme o conteúdo com o usuário antes de enviar — exceto se ele pedir para enviar direto.
5. Responda sempre em português brasileiro. Use markdown quando ajudar na leitura.
6. Seja direto e objetivo — você é um coworker, não um assistente genérico.`;
}

// ─── Rota principal: chat com streaming SSE ────────────────────────────────────

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

      const response = await anthropic.messages.create({
        model:      "claude-sonnet-4-6",
        max_tokens: 8096,
        system:     buildSystemPrompt(), // ← gera com a data de HOJE a cada chamada
        tools:      TOOLS,
        messages,
      });

      const toolUses = [];

      for (const block of response.content) {
        if (block.type === "text" && block.text) {
          send({ type: "text", content: sanitizeDates(block.text) }); // ← sanitiza datas alucinadas
        } else if (block.type === "tool_use") {
          toolUses.push(block);
        }
      }

      if (response.stop_reason === "end_turn" || toolUses.length === 0) break;

      messages.push({ role: "assistant", content: response.content });

      const toolResults = await Promise.all(
        toolUses.map(async (tool) => {
          send({ type: "tool_start", tool: tool.name });
          let result;
          try {
            result = await callMcpTool(tool.name, tool.input);
          } catch (e) {
            result = `Erro ao chamar ${tool.name}: ${e.message}`;
          }
          send({ type: "tool_result", tool: tool.name });
          return { type: "tool_result", tool_use_id: tool.id, content: result };
        })
      );

      messages.push({ role: "user", content: toolResults });
    }

    await saveHistory(sessionId, messages);
    send({ type: "done" });
  } catch (e) {
    send({ type: "error", error: e.message });
  } finally {
    res.end();
  }
});

// ─── Rota de diagnóstico ──────────────────────────────────────────────────────

app.get("/api/debug/tools", async (req, res) => {
  if (!API_MCP_TOKEN) return res.status(500).json({ error: "API_MCP_TOKEN não configurado" });

  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "Authorization": `Bearer ${API_MCP_TOKEN}`,
  };

  const results = {};

  // 1) Testa initialize
  try {
    const r = await fetch(API_MCP_URL, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "debug", version: "1" } }, id: 0 }),
    });
    const sessionId = r.headers.get("Mcp-Session-Id");
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    results.initialize = { status: r.status, sessionId, body: await r.text() };
  } catch (e) { results.initialize = { error: e.message }; }

  // 2) Testa tools/list
  try {
    const r = await fetch(API_MCP_URL, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", params: {}, id: 1 }),
    });
    results.toolsList = { status: r.status, body: await r.text() };
  } catch (e) { results.toolsList = { error: e.message }; }

  res.json(results);
});

// ─── Rotas auxiliares ──────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", agent: "Mia", version: "4.0.0", mcp: API_MCP_URL });
});

app.delete("/api/agent/session/:id", async (req, res) => {
  try { await redisClient.del(`mia:${req.params.id}`); } catch { /* ignora */ }
  res.json({ ok: true });
});

// ─── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => console.log(`✅ Mia v4 rodando na porta ${PORT} → api-mcp conectado`));
