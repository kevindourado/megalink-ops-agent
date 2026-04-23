/**
 * server.js — Mia Backend (JavaScript puro, sem TypeScript)
 * Sem compilação, sem tsconfig. Roda direto com Node.js.
 */

const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk").default;
const redis = require("redis");
const { v4: uuid } = require("uuid");

// ─── Config ───────────────────────────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 3001;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors({ origin: "*" }));
app.use(express.json());

// ─── Redis ────────────────────────────────────────────────────────────────────

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
    const trimmed = messages.slice(-40);
    await redisClient.setEx(`mia:${sessionId}`, 28800, JSON.stringify(trimmed));
  } catch { /* ignora */ }
}

// ─── Ferramentas ──────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "erp_buscar_cliente",
    description: "Busca informações de um cliente no ERP pelo nome, CPF/CNPJ ou código.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Nome, CPF/CNPJ ou código" } },
      required: ["query"],
    },
  },
  {
    name: "erp_faturas_cliente",
    description: "Retorna as faturas de um cliente. Inclui status de pagamento.",
    input_schema: {
      type: "object",
      properties: {
        cliente_id: { type: "string", description: "Código ou CPF/CNPJ do cliente" },
        periodo: { type: "string", description: "Período MM/YYYY (opcional)" },
      },
      required: ["cliente_id"],
    },
  },
  {
    name: "erp_os_em_atraso",
    description: "Lista as ordens de serviço em atraso. Pode filtrar por equipe ou técnico.",
    input_schema: {
      type: "object",
      properties: {
        equipe: { type: "string", description: "Nome da equipe (opcional)" },
        tecnico: { type: "string", description: "Nome do técnico (opcional)" },
      },
      required: [],
    },
  },
  {
    name: "plataforma_auditorias_recentes",
    description: "Retorna as auditorias recentes da plataforma Megalink.",
    input_schema: {
      type: "object",
      properties: { limite: { type: "number", description: "Nº máximo de resultados (padrão 10)" } },
      required: [],
    },
  },
  {
    name: "plataforma_avaliacoes_colaborador",
    description: "Busca as avaliações de um colaborador pelo nome ou ID.",
    input_schema: {
      type: "object",
      properties: { colaborador_id: { type: "string", description: "ID ou nome do colaborador" } },
      required: ["colaborador_id"],
    },
  },
  {
    name: "plataforma_listar_colaboradores",
    description: "Lista todos os colaboradores ativos da plataforma.",
    input_schema: {
      type: "object",
      properties: { equipe: { type: "string", description: "Filtrar por equipe (opcional)" } },
      required: [],
    },
  },
  {
    name: "plataforma_reincidencias",
    description: "Lista reincidências de OS na plataforma.",
    input_schema: {
      type: "object",
      properties: {
        cliente_id: { type: "string", description: "Código do cliente (opcional)" },
        periodo: { type: "string", description: "Período MM/YYYY (opcional)" },
      },
      required: [],
    },
  },
  {
    name: "slack_enviar_mensagem",
    description: "Envia uma mensagem para um canal ou usuário no Slack.",
    input_schema: {
      type: "object",
      properties: {
        canal: { type: "string", description: "Canal ex: #operacoes ou @usuario" },
        mensagem: { type: "string", description: "Texto da mensagem" },
      },
      required: ["canal", "mensagem"],
    },
  },
  {
    name: "whatsapp_enviar_mensagem",
    description: "Envia mensagem via WhatsApp usando a integração Zenvia.",
    input_schema: {
      type: "object",
      properties: {
        telefone: { type: "string", description: "Número com DDI+DDD ex: 5511999999999" },
        mensagem: { type: "string", description: "Texto da mensagem" },
      },
      required: ["telefone", "mensagem"],
    },
  },
];

// ─── Executor de ferramentas ───────────────────────────────────────────────────

const BASE_URL = process.env.MEGALINK_API_URL || "";
const API_KEY  = process.env.MEGALINK_INTERNAL_API_KEY || "";

const PATH_MAP = {
  erp_buscar_cliente:               "/erp/buscar-cliente",
  erp_faturas_cliente:              "/erp/faturas",
  erp_os_em_atraso:                "/erp/os-em-atraso",
  plataforma_auditorias_recentes:   "/plataforma/auditorias",
  plataforma_avaliacoes_colaborador:"/plataforma/avaliacoes",
  plataforma_listar_colaboradores:  "/plataforma/colaboradores",
  plataforma_reincidencias:         "/plataforma/reincidencias",
  slack_enviar_mensagem:            "/comunicacao/slack",
  whatsapp_enviar_mensagem:         "/comunicacao/whatsapp/enviar",
};

async function executeTool(name, input) {
  if (!BASE_URL) {
    return JSON.stringify({
      aviso: "API interna não configurada. Adicione MEGALINK_API_URL nas variáveis do Railway.",
      ferramenta: name,
      input,
    });
  }
  try {
    const path = PATH_MAP[name];
    if (!path) return `Ferramenta desconhecida: ${name}`;
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(input),
    });
    const data = await res.json();
    return JSON.stringify(data, null, 2);
  } catch (e) {
    return `Erro ao chamar ${name}: ${e.message}`;
  }
}

// ─── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Você é a Mia, assistente inteligente da Megalink OPS. Age como um coworker experiente com acesso direto aos sistemas internos.

Suas capacidades:
- Buscar clientes, OS, faturas e reincidências no ERP
- Listar e analisar auditorias e avaliações de colaboradores
- Enviar notificações via Slack e WhatsApp
- Responder perguntas operacionais com dados em tempo real

Regras:
1. Sempre use as ferramentas antes de responder sobre dados internos — nunca invente.
2. Ao enviar mensagens (Slack/WhatsApp), confirme com o usuário antes, a menos que ele peça para enviar direto.
3. Responda sempre em português brasileiro.
4. Seja conciso e use markdown quando ajudar na leitura.`;

// ─── Rota: chat com streaming SSE ─────────────────────────────────────────────

app.post("/api/agent/chat", async (req, res) => {
  const { message, sessionId: clientSessionId } = req.body;

  if (!message?.trim()) {
    return res.status(400).json({ error: "Mensagem vazia" });
  }

  const sessionId = clientSessionId || uuid();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Session-Id", sessionId);
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const history = await getHistory(sessionId);
  const messages = [...history, { role: "user", content: message.trim() }];

  try {
    let iteracoes = 0;

    while (iteracoes < 10) {
      iteracoes++;

      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 8096,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
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

      const toolResults = await Promise.all(
        toolUses.map(async (tool) => {
          send({ type: "tool_start", tool: tool.name });
          const result = await executeTool(tool.name, tool.input);
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
  res.json({ status: "ok", agent: "Mia", version: "1.0.0" });
});

app.delete("/api/agent/session/:id", async (req, res) => {
  try { await redisClient.del(`mia:${req.params.id}`); } catch { /* ignora */ }
  res.json({ ok: true });
});

// ─── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => console.log(`✅ Mia rodando na porta ${PORT}`));
