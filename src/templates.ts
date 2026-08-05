// CLI-side mirror of the dashboard's function templates. Kept inline so the
// compiled binary doesn't need to import the dashboard's React module graph.
// When the dashboard adds a new template, copy it here. (Future: extract to a
// shared package `@zavu/function-templates` consumed by both.)

export interface CliFunctionTemplate {
  id: string
  name: string
  emoji: string
  defaultSlug: string
  summary: string
  dependencies: Record<string, string>
  code: string
  requiredSecrets: { key: string; hint: string }[]
}

const AGENT = `// An agent and one tool. This is the shape the guides and skills teach:
// defineAgent + defineTool register themselves at module load, and
// \`npx zavudev deploy\` reconciles the live agent and tools to match. Your
// source is the source of truth.

import { defineAgent, defineTool } from "@zavudev/functions"

// SENDER_ID is the sender this agent answers on. Find it with
// \`npx zavudev senders list\`, then set it with
// \`npx zavudev fn secrets set SENDER_ID <id>\`.
defineAgent({
  senderId: process.env.SENDER_ID!,
  name: "Support",
  provider: "zavu",
  model: "gpt-4o-mini",
  prompt: \`You are a support agent.

When someone asks about an order, call get_order_status and answer with what it
returns. Never invent a status or a date.\`,
})

// The model reads 'description' to decide WHEN to call this, so be precise.
// 'parameters' is plain JSON Schema. The handler runs in your function and can
// return any JSON-serializable value.
//
// Tools are offered on every channel, including plain text, and the model may
// chain up to 5 tool rounds in a single reply.
defineTool({
  name: "get_order_status",
  description:
    "Look up the delivery status of one order by its id. Call this whenever a customer asks where their order is.",
  parameters: {
    type: "object",
    properties: {
      orderId: { type: "string", description: "The order id, e.g. ORD-4417" },
    },
    required: ["orderId"],
  },
  // Replace this with a real lookup against your backend.
  handler: async (args) => ({
    orderId: args.orderId,
    status: "in_transit",
    expectedDelivery: "2 to 3 business days",
  }),
})
`

const BLANK = `import { defineFunction } from "@zavudev/functions"
import Zavudev from "@zavudev/sdk"

const zavu = new Zavudev({
  apiKey: process.env.ZAVU_API_KEY,
  baseURL: process.env.ZAVU_API_BASE_URL,
})

export default defineFunction({
  on: ["message.inbound"],
  handler: async (event, ctx) => {
    if (event.type !== "message.inbound") return { ok: true }
    const incoming = event.data.text ?? ""
    console.log("inbound from", event.data.from, ":", incoming)

    await zavu.messages.send({
      "Zavu-Sender": event.senderId,
      to: event.data.from,
      channel: event.data.channel,
      text: \`Echo from Zavu Functions: \${incoming}\`,
    })

    return { ok: true }
  },
})
`

// ---------------------------------------------------------------------------
// Restaurant reservations agent — tool webhook.
//
// This function is meant to be attached to a Zavu Agent as the webhook URL
// for four tools: view_menu, check_availability, create_reservation,
// view_reservation. The LLM decides when to call which one based on the
// customer's WhatsApp message; this function executes the action and
// returns structured JSON the agent narrates back.
//
// Wiring:
//   1. `npx zavudev fn deploy` (this function, with httpEnabled=true)
//   2. Create an Agent on your WhatsApp sender
//   3. Register the same publicUrl as the webhook for each tool with the
//      correct `name` and `parameters` schema (see the comment block at the
//      bottom of this file for ready-to-paste JSON).
//
// In production: swap the in-memory data for your real POS / reservation DB.
// ---------------------------------------------------------------------------
const RESTAURANT = `// Restaurant reservations agent — fully declarative.
//
// defineAgent + defineTool register the agent and its tools at module load.
// On \`npx zavudev deploy\`, the platform reads these declarations and reconciles
// the live agent + tools to match. No more separate \`npx zavudev agents create\`
// or \`npx zavudev agents tools create\` commands — your function source IS the
// source of truth.

import { defineAgent, defineTool } from "@zavudev/functions"

// ---------------------------------------------------------------------------
// 1) Declare the agent. Set SENDER_ID as a secret on the function in the
//    dashboard (Secrets tab) — it's the ID of the WhatsApp sender that this
//    agent will live on. Use \`npx zavudev senders list\` to find it.
// ---------------------------------------------------------------------------
defineAgent({
  senderId: process.env.SENDER_ID!,
  name: "Bella",
  // Provider 'zavu' uses Zavu's AI gateway — billed from your project balance,
  // no BYOK. For your own OpenAI/Anthropic key, switch provider and pass apiKey.
  provider: "zavu",
  model: "openai/gpt-4o-mini",
  channels: ["whatsapp"],
  prompt: \`Eres Bella, anfitriona de Bella Pizzeria en WhatsApp.

Ayudas al cliente a ver el menú, consultar disponibilidad y hacer reservas.

Reglas:
- Respuestas cortas. Es WhatsApp.
- Nunca inventes precios ni horarios — usa siempre las tools.
- Confirma cada reserva con su código antes de cerrarla.
- Habla en el idioma del cliente.\`,
})

// ---------------------------------------------------------------------------
// 2) Tools. Each one is a function the LLM can call. The 'description' is
//    what the LLM reads to decide WHEN to call it — be precise.
//    'parameters' is the JSON-schema the LLM fills in.
//    'handler' runs in this Lambda; return any JSON-serializable value.
// ---------------------------------------------------------------------------

// Demo data — swap for your POS / DB in production.
const MENU = [
  { name: "Pizza Margherita", price: 12, vegan: false },
  { name: "Pizza Pepperoni", price: 14, vegan: false },
  { name: "Spaghetti Carbonara", price: 14, vegan: false },
  { name: "Caesar Salad", price: 9, vegan: false },
  { name: "Vegan Buddha Bowl", price: 11, vegan: true },
  { name: "Tiramisu", price: 7, vegan: false },
]

// In-memory store — Lambda cold-start wipes this. For real use, persist to
// Convex, your POS, or a third-party reservation provider.
const reservations: Record<string, any> = {}

defineTool({
  name: "view_menu",
  description:
    "Get the restaurant menu. Use when the customer asks what's available, prices, or vegan options.",
  parameters: {
    type: "object",
    properties: {
      filter: { type: "string", description: "all | vegan" },
    },
    required: [],
  },
  handler: async (args) => {
    const filter: string = args.filter ?? "all"
    const items = filter === "vegan" ? MENU.filter((m) => m.vegan) : MENU
    return {
      menu: items.map((m) => ({
        name: m.name,
        price: \`$\${m.price}\`,
        vegan: m.vegan,
      })),
      count: items.length,
    }
  },
})

defineTool({
  name: "check_availability",
  description:
    "Check available reservation slots for a date and party size. Call before create_reservation.",
  parameters: {
    type: "object",
    properties: {
      date: {
        type: "string",
        description: "YYYY-MM-DD or 'friday', 'today', 'tomorrow' (interpret naturally)",
      },
      partySize: { type: "number", description: "Number of people" },
    },
    required: ["date", "partySize"],
  },
  handler: async (args) => {
    // Demo: weekends have 4 slots, weekdays 2.
    const date: string = args.date ?? "today"
    const partySize: number = Number(args.partySize ?? 2)
    const weekend = /(fri|sat)/i.test(date)
    const slots = weekend
      ? ["18:00", "19:30", "21:00", "22:30"]
      : ["19:00", "21:00"]
    return { available: slots.length > 0, slots, date, partySize }
  },
})

defineTool({
  name: "create_reservation",
  description:
    "Book a confirmed reservation. Only call AFTER check_availability returns the requested slot.",
  parameters: {
    type: "object",
    properties: {
      date: { type: "string" },
      time: { type: "string" },
      partySize: { type: "number" },
      customerName: { type: "string" },
    },
    required: ["date", "time", "partySize", "customerName"],
  },
  handler: async (args, ctx) => {
    const { date, time, partySize, customerName } = args
    if (!date || !time || !partySize || !customerName) {
      return {
        error: "missing_fields",
        required: ["date", "time", "partySize", "customerName"],
      }
    }
    const id = \`RES-\${Date.now().toString(36).toUpperCase()}\`
    reservations[id] = {
      id,
      date,
      time,
      partySize: Number(partySize),
      customerName,
      phone: ctx?.contactPhone ?? null,
      status: "confirmed",
      createdAt: new Date().toISOString(),
    }
    return {
      confirmed: true,
      reservationId: id,
      summary: \`\${customerName}, party of \${partySize}, \${date} at \${time}\`,
      cancellationCode: id.slice(-4),
    }
  },
})

defineTool({
  name: "view_reservation",
  description: "Look up an existing reservation by its ID.",
  parameters: {
    type: "object",
    properties: {
      reservationId: { type: "string" },
    },
    required: ["reservationId"],
  },
  handler: async (args) => {
    const r = reservations[args.reservationId]
    if (!r) return { error: "not_found", reservationId: args.reservationId }
    return r
  },
})

// No \`defineFunction\` needed — the runtime wrapper dispatches tool calls
// from defineTool entries automatically. Add one only if you also want to
// handle raw HTTP requests or native events (message.inbound, etc).
`

export const TEMPLATES: CliFunctionTemplate[] = [
  // First entry is the default when `--template` is omitted, so it is also the
  // answer to "what does a Zavu function look like?". That used to be the echo
  // bot, which is `defineFunction` — a different programming model from the
  // `defineAgent` + `defineTool` shape every guide and skill teaches. Someone
  // scaffolding to learn the shape was handed the one file that does not use
  // it.
  {
    id: "agent",
    name: "Agent with a tool",
    emoji: "◇",
    defaultSlug: "agent",
    summary: "Declarative agent: defineAgent + defineTool. The smallest useful shape.",
    dependencies: {},
    code: AGENT,
    requiredSecrets: [
      {
        key: "SENDER_ID",
        hint: "ID of the sender this agent answers on (from `npx zavudev senders list`).",
      },
    ],
  },
  {
    id: "blank",
    name: "Echo demo",
    emoji: "✨",
    defaultSlug: "echo",
    summary:
      "Minimal echo bot. Uses defineFunction (raw event handling), not the agent shape.",
    dependencies: {},
    code: BLANK,
    requiredSecrets: [],
  },
  {
    id: "restaurant-booking",
    name: "Restaurant reservations agent",
    emoji: "🍽️",
    defaultSlug: "reservations",
    summary:
      "Declarative agent: defineAgent + defineTool. Menu, availability, bookings over WhatsApp.",
    dependencies: {},
    code: RESTAURANT,
    requiredSecrets: [
      {
        key: "SENDER_ID",
        hint: "ID of the WhatsApp sender this agent runs on (from `npx zavudev senders list`).",
      },
    ],
  },
]
