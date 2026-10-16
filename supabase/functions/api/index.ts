// Edge Function `api`: единственная точка входа мини-приложения.
// Каждый запрос подписан Telegram (initData). Функция проверяет подпись,
// находит пользователя и отвечает. Прямого доступа к таблицам из браузера нет.
//
// Секреты (supabase secrets set ...):
//   BOT_TOKEN      токен бота от BotFather
//   ADMIN_TG_ID    Telegram-id администратора (тебя)
// SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY Supabase подставляет сам.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const BOT_TOKEN = Deno.env.get("BOT_TOKEN") ?? "";
const ADMIN_TG_ID = Number(Deno.env.get("ADMIN_TG_ID") ?? "0");
const MAX_AUTH_AGE_SEC = 24 * 60 * 60;

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-init-data",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8" },
  });
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ───────── проверка подписи Telegram ─────────
const enc = new TextEncoder();

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

const toHex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

type TgUser = { id: number; first_name?: string };

async function verifyInitData(initData: string): Promise<TgUser> {
  if (!BOT_TOKEN) throw new HttpError(500, "BOT_TOKEN не задан");
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) throw new HttpError(401, "Нет подписи");
  params.delete("hash");

  const check = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secret = await hmac(enc.encode("WebAppData"), BOT_TOKEN);
  const calc = toHex(await hmac(secret, check));
  if (!safeEqual(calc, hash)) throw new HttpError(401, "Подпись не совпала");

  const authDate = Number(params.get("auth_date") ?? 0);
  if (!authDate || Date.now() / 1000 - authDate > MAX_AUTH_AGE_SEC) {
    throw new HttpError(401, "Сессия устарела, открой приложение заново");
  }
  const user = JSON.parse(params.get("user") ?? "null");
  if (!user?.id) throw new HttpError(401, "Нет данных пользователя");
  return user;
}

// ───────── пользователи ─────────
type DbUser = {
  id: string; tg_id: number; first_name: string | null; role: "user" | "admin";
  timezone: string; [k: string]: unknown;
};

async function getOrCreateUser(tg: TgUser): Promise<DbUser> {
  const role = tg.id === ADMIN_TG_ID ? "admin" : "user";
  const { data: found } = await db.from("users").select("*").eq("tg_id", tg.id).maybeSingle();
  if (found) {
    if (found.role !== role || found.first_name !== (tg.first_name ?? null)) {
      const { data } = await db.from("users")
        .update({ role, first_name: tg.first_name ?? null, bot_blocked: false })
        .eq("id", found.id).select("*").single();
      return data as DbUser;
    }
    return found as DbUser;
  }
  const { data, error } = await db.from("users")
    .insert({ tg_id: tg.id, first_name: tg.first_name ?? null, role })
    .select("*").single();
  if (error) throw error;
  await db.from("user_settings").insert({ user_id: data.id });
  // типы смен по умолчанию
  await db.from("shift_types").insert([
    { user_id: data.id, name: "Прилавок", default_start: "09:00", default_end: "21:00", sort: 1 },
    { user_id: data.id, name: "Авто",     default_start: "10:00", default_end: "18:00", sort: 2 },
    { user_id: data.id, name: "Кухня",    default_start: "08:00", default_end: "16:00", sort: 3 },
    { user_id: data.id, name: "Ночь",     default_start: "21:00", default_end: "08:00", sort: 4 },
    { user_id: data.id, name: "Обучение", default_start: "10:00", default_end: "15:00", sort: 5 },
  ]);
  return data as DbUser;
}

// ───────── контекст запроса: кто смотрит и чьи данные ─────────
type Ctx = { actor: DbUser; target: DbUser; readOnly: boolean };

async function buildCtx(actor: DbUser, viewAs?: string): Promise<Ctx> {
  if (!viewAs || viewAs === actor.id) return { actor, target: actor, readOnly: false };
  if (actor.role !== "admin") throw new HttpError(403, "Нет доступа");
  const { data } = await db.from("users").select("*").eq("id", viewAs).maybeSingle();
  if (!data) throw new HttpError(404, "Пользователь не найден");
  return { actor, target: data as DbUser, readOnly: true }; // админ только смотрит
}

// Вкладка «Цикл» для чужого просмотра закрыта, пока она сама не включила обмен.
// Эта проверка нужна в каждом обработчике данных цикла.
export async function assertCycleAccess(ctx: Ctx) {
  if (ctx.actor.id === ctx.target.id) return;
  const { data } = await db.from("user_settings")
    .select("cycle_share_partner").eq("user_id", ctx.target.id).single();
  if (!data?.cycle_share_partner) throw new HttpError(403, "Цикл закрыт владельцем");
}

function assertWritable(ctx: Ctx) {
  if (ctx.readOnly) throw new HttpError(403, "Режим просмотра: изменения отключены");
}

// ───────── действия ─────────
const SETTINGS_FIELDS = [
  "shift_evening_on", "shift_evening_time", "shift_before_on", "shift_before_hours",
  "cycle_remind_days", "cycle_neutral_text", "cycle_typical_length", "cycle_typical_period",
  "cycle_lock", "cycle_share_partner", "theme",
];
const USER_FIELDS = ["timezone", "quiet_on", "quiet_from", "quiet_to", "quiet_strict_shifts", "week_start", "paused_until"];

function pick(src: Record<string, unknown>, keys: string[]) {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in src) out[k] = src[k];
  return out;
}

type Handler = (ctx: Ctx, p: Record<string, unknown>) => Promise<unknown>;

const actions: Record<string, Handler> = {
  async health() {
    return { ok: true, time: new Date().toISOString() };
  },

  async me(ctx) {
    const { data: settings } = await db.from("user_settings").select("*").eq("user_id", ctx.target.id).single();
    return {
      user: {
        id: ctx.target.id, first_name: ctx.target.first_name, timezone: ctx.target.timezone,
        quiet_on: ctx.target.quiet_on, quiet_from: ctx.target.quiet_from, quiet_to: ctx.target.quiet_to,
        quiet_strict_shifts: ctx.target.quiet_strict_shifts, week_start: ctx.target.week_start,
        paused_until: ctx.target.paused_until, bot_blocked: ctx.target.bot_blocked,
      },
      settings,
      viewer: { role: ctx.actor.role, read_only: ctx.readOnly, is_self: ctx.actor.id === ctx.target.id },
    };
  },

  async "settings.update"(ctx, p) {
    assertWritable(ctx);
    const u = pick(p, USER_FIELDS);
    const s = pick(p, SETTINGS_FIELDS);
    if (Object.keys(u).length) {
      const { error } = await db.from("users").update(u).eq("id", ctx.target.id);
      if (error) throw new HttpError(400, error.message);
    }
    if (Object.keys(s).length) {
      const { error } = await db.from("user_settings").update(s).eq("user_id", ctx.target.id);
      if (error) throw new HttpError(400, error.message);
    }
    return actions.me(ctx, {});
  },

  // только для администратора: список пользователей без их данных
  async "admin.users"(ctx) {
    if (ctx.actor.role !== "admin") throw new HttpError(403, "Нет доступа");
    const { data } = await db.from("users").select("id, first_name, role, created_at, bot_blocked").order("created_at");
    return { users: data ?? [] };
  },

  async "admin.status"(ctx) {
    if (ctx.actor.role !== "admin") throw new HttpError(403, "Нет доступа");
    const { data: errors } = await db.from("error_log").select("at, source, message").order("at", { ascending: false }).limit(20);
    const { data: last } = await db.from("sent_log").select("sent_at").order("sent_at", { ascending: false }).limit(1);
    return { errors: errors ?? [], last_sent_at: last?.[0]?.sent_at ?? null };
  },
};

// ───────── сервер ─────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Только POST" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");
    const handler = actions[action];
    if (!handler) throw new HttpError(404, "Неизвестное действие");

    if (action === "health") return json(await handler({} as Ctx, {}));

    const tg = await verifyInitData(req.headers.get("x-init-data") ?? "");
    const actor = await getOrCreateUser(tg);
    const ctx = await buildCtx(actor, body.view_as);
    return json(await handler(ctx, body.payload ?? {}));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    const message = e instanceof HttpError ? e.message : "Внутренняя ошибка";
    if (status >= 500) {
      // в журнал только суть ошибки, без данных пользователя
      await db.from("error_log").insert({ source: "api", message: String((e as Error)?.message ?? e).slice(0, 500) });
    }
    return json({ error: message }, status);
  }
});
