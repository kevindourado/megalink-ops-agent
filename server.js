/**
 * server.js — Mia Backend v3 (conectado ao api-mcp real da Megalink OPS)
 * As ferramentas agora chamam o api-mcp do Supabase via MCP JSON-RPC.
 * Sem PATH_MAP manual — uma URL, todas as tools.
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
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const API_MCP_URL       = "https://bsmjvixagmmmoffpbtuw.supabase.co/functions/v1/api-mcp";

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
    await redisClient.setEx(`mia:${sessionId}`, 28800, JSON.stringify(messages.slice(-40)));
  } catch { /* ignora */ }
}

// ─── Chamador MCP (JSON-RPC → api-mcp do Supabase) ───────────────────────────

async function callMcpTool(toolName, args) {
  const res = await fetch(API_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
      "apikey": SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: toolName, arguments: args },
      id: Date.now(),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`api-mcp HTTP ${res.status}: ${text}`);
  }

  const json = await res.json();

  if (json.error) throw new Error(`api-mcp error: ${json.error.message}`);

  // Resultado MCP vem em json.result.content (array de { type, text })
  const content = json.result?.content;
  if (Array.isArray(content)) {
    return content.map((c) => c.text ?? JSON.stringify(c)).join("\n");
  }
  return JSON.stringify(json.result ?? json);
}

// ─── Definições de ferramentas (espelham o api-mcp) ───────────────────────────

const TOOLS = [
  {
    name: "erp_buscar_cliente",
    description: "Busca um cliente no ERP da Megalink por CPF/CNPJ ou código interno.",
    input_schema: {
      type: "object",
      properties: {
        cpf_cnpj:   { type: "string", description: "CPF ou CNPJ do cliente" },
        cd_cliente: { type: "string", description: "Código interno do cliente no ERP" },
      },
      required: [],
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
  {
    name: "listar_cs_tickets_pendentes",
    description: "Lista os tickets de atendimento (CS) ainda pendentes de resolução.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Número máximo de tickets a retornar (padrão: 20)" },
      },
      required: [],
    },
  },
  {
    name: "listar_auditorias_recentes",
    description: "Lista as auditorias técnicas registradas nos últimos N dias.",
    input_schema: {
      type: "object",
      properties: {
        dias: { type: "number", description: "Janela de dias a considerar (padrão: 7)" },
      },
      required: [],
    },
  },
  {
    name: "listar_reincidencias_recentes",
    description: "Lista as reincidências de OS detectadas nos últimos N dias.",
    input_schema: {
      type: "object",
      properties: {
        dias: { type: "number", description: "Janela de dias a considerar (padrão: 30)" },
      },
      required: [],
    },
  },
  {
    name: "listar_eventos_nao_processados",
    description: "Lista os eventos do sistema ainda não processados pelo AI Orchestrator (camada cérebro).",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Número máximo de eventos (padrão: 10)" },
      },
      required: [],
    },
  },
  {
    name: "publicar_evento",
    description: "Publica um evento na tabela system_events para ser processado pela camada cérebro.",
    input_schema: {
      type: "object",
      properties: {
        event_type: { type: "string", description: "Tipo do evento ex: cs_ticket_created, audit_completed" },
        payload:    { type: "object", description: "Dados do evento" },
        priority:   { type: "string", description: "low | medium | high | critical" },
      },
      required: ["event_type"],
    },
  },
  {
    name: "slack_send_message",
    description: "Envia uma mensagem para um canal ou usuário no Slack da Megalink.",
    input_schema: {
      type: "object",
      properties: {
        channel:  { type: "string", description: "Canal ex: #operacoes ou @usuario" },
        text:     { type: "string", description: "Texto da mensagem" },
      },
      required: ["channel", "text"],
    },
  },
];

// ─── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Você é a Mia, assistente inteligente da Megalink OPS — o sistema operacional interno da Megalink Telecom.

Você tem acesso direto aos dados reais da empresa: ERP (clientes, OS), CS (tickets), auditorias técnicas, reincidências, eventos do sistema e notificações via Slack.

Você também pode publicar eventos na camada cérebro (AI Orchestrator), que roda a cada 15 minutos e toma decisões automáticas. Isso significa que você pode acionar o cérebro de forma intencional quando necessário.

## Regras
1. Use sempre as ferramentas antes de responder sobre dados internos — nunca invente números ou nomes.
2. Para datas em ferramentas do ERP, use o formato dd/MM/yyyy.
3. Ao enviar mensagens no Slack, confirme o conteúdo com o usuário antes de enviar — exceto se ele pedir para enviar direto.
4. Ao publicar eventos, explique o que vai acontecer e peça confirmação.
5. Responda sempre em português brasileiro. Use markdown quando ajudar na leitura.
6. Seja direto e objetivo — você é um coworker, não um assistente genérico.

## O que você pode fazer hoje
- Buscar clientes e OS no ERP (MK)
- Listar tickets CS pendentes, auditorias e reincidências recentes
- Ver eventos pendentes na fila da camada cérebro
- Publicar eventos para que o orquestrador processe
- Enviar alertas e resumos no Slack`;

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
        system:     SYSTEM_PROMPT,
        tools:      TOOLS,
        messages,
      });

      const toolUses = [];

      for (const block of response.content) {
        if (block.type === "text" && block.text) {
          send({ type: "text", content: block.text });
        } else if (block.type === "tool_use") {
          toolUses.push(block);
        }
      }

      if (response.stop_reason === "end_turn" || toolUses.length === 0) break;

      messages.push({ role: "assistant", content: response.content });

      // Executa as ferramentas chamando o api-mcp real
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

// ─── Rotas auxiliares ──────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", agent: "Mia", version: "3.0.0", mcp: API_MCP_URL });
});

app.delete("/api/agent/session/:id", async (req, res) => {
  try { await redisClient.del(`mia:${req.params.id}`); } catch { /* ignora */ }
  res.json({ ok: true });
});

// ─── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => console.log(`✅ Mia v3 rodando na porta ${PORT} → api-mcp conectado`));
