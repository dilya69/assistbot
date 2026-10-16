// Edge Function `api`: единственная точка входа мини-приложения.
// Каждый запрос подписан Telegram (initData). Функция проверяет подпись,
// находит пользователя и отвечает. Прямого доступа к таблицам из браузера нет.
//
// Секреты (supabase secrets set ...):
//   BOT_TOKEN      токен бота от BotFather
//   ADMIN_TG_ID    (необязательно) Telegram-id администраторов через запятую; роль можно выдать и в базе
// SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY Supabase подставляет сам.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const BOT_TOKEN = Deno.env.get("BOT_TOKEN") ?? "";
// Администраторов может быть несколько: ADMIN_TG_ID="111111,222222"
const ADMIN_IDS = new Set(
  (Deno.env.get("ADMIN_TG_ID") ?? "").split(",").map((x) => Number(x.trim())).filter((n) => n > 0),
);
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
  // Роль админа хранится в базе (users.role). Секрет ADMIN_TG_ID только добавляет права, не отнимает.
  const envAdmin = ADMIN_IDS.has(tg.id);
  const { data: found } = await db.from("users").select("*").eq("tg_id", tg.id).maybeSingle();
  if (found) {
    const role = envAdmin ? "admin" : found.role;
    if (found.role !== role || found.first_name !== (tg.first_name ?? null) || found.bot_blocked) {
      const { data } = await db.from("users")
        .update({ role, first_name: tg.first_name ?? null, bot_blocked: false })
        .eq("id", found.id).select("*").single();
      return data as DbUser;
    }
    return found as DbUser;
  }
  const role = envAdmin ? "admin" : "user";
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

// ───────── даты и время ─────────
// BEGIN-DATES (этот блок проверяется отдельным тестом, держи его без обращений к базе)
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86400000;

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (date: string) => Date.parse(date + "T00:00:00Z");
const addDays = (date: string, n: number) => ymd(dayMs(date) + n * DAY_MS);

function reqDate(v: unknown, label = "Дата"): string {
  const s = String(v ?? "");
  if (!DATE_RE.test(s)) throw new HttpError(400, `${label}: неверный формат`);
  const t = dayMs(s);
  if (Number.isNaN(t) || ymd(t) !== s) throw new HttpError(400, `${label}: такой даты нет`);
  return s;
}

function reqTime(v: unknown, label = "Время"): string {
  const s = String(v ?? "");
  if (!TIME_RE.test(s)) throw new HttpError(400, `${label}: неверный формат`);
  return s;
}

function optTime(v: unknown, label: string): string | null {
  return v === null || v === undefined || v === "" ? null : reqTime(v, label);
}

function reqId(v: unknown): string {
  const s = String(v ?? "");
  if (!UUID_RE.test(s)) throw new HttpError(400, "Неверный идентификатор");
  return s;
}

function reqText(v: unknown, label: string, max: number, required = true): string | null {
  const s = String(v ?? "").trim();
  if (!s) {
    if (required) throw new HttpError(400, `${label}: заполни поле`);
    return null;
  }
  if (s.length > max) throw new HttpError(400, `${label}: не длиннее ${max} символов`);
  return s;
}

function reqDates(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0) throw new HttpError(400, "Выбери хотя бы одну дату");
  if (v.length > 62) throw new HttpError(400, "Слишком много дат за один раз");
  return [...new Set(v.map((x) => reqDate(x)))];
}

function reqRange(p: Record<string, unknown>) {
  const from = reqDate(p.from, "Начало периода");
  const to = reqDate(p.to, "Конец периода");
  if (to < from) throw new HttpError(400, "Конец раньше начала");
  if ((dayMs(to) - dayMs(from)) / DAY_MS > 70) throw new HttpError(400, "Период слишком большой");
  return { from, to };
}

// Часовой пояс пользователя: смены и напоминания хранятся в UTC, а вводятся по местному времени.
function partsIn(tz: string, ms: number) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return p;
}

function tzOffsetMs(tz: string, utcMs: number): number {
  const p = partsIn(tz, utcMs);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

function localToUtc(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - tzOffsetMs(tz, guess);
  t = guess - tzOffsetMs(tz, t); // второй проход нужен рядом с переводом часов
  return new Date(t);
}

function localParts(d: Date, tz: string) {
  const p = partsIn(tz, d.getTime());
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

type ReminderRow = {
  id: string; text: string; remind_at: string; advance_minutes: number;
  repeat: string; repeat_until: string | null; done_at: string | null;
};

// Разворачивает напоминание в конкретные даты внутри периода [from, to].
function expandReminder(r: ReminderRow, from: string, to: string, tz: string) {
  const base = localParts(new Date(r.remind_at), tz);
  const mk = (date: string) => ({
    id: r.id, date, start_date: base.date, time: base.time, text: r.text, advance_minutes: r.advance_minutes,
    repeat: r.repeat, repeat_until: r.repeat_until, done: r.repeat === "none" && !!r.done_at,
  });
  const out: ReturnType<typeof mk>[] = [];
  if (r.repeat === "none") {
    if (base.date >= from && base.date <= to) out.push(mk(base.date));
    return out;
  }
  const limit = r.repeat_until && r.repeat_until < to ? r.repeat_until : to;
  const [by, bm, bd] = base.date.split("-").map(Number);
  const [fy, fm] = from.split("-").map(Number);
  const gap = Math.floor((dayMs(from) - dayMs(base.date)) / DAY_MS);
  let i0 = 0;
  if (r.repeat === "daily") i0 = Math.max(0, gap);
  else if (r.repeat === "weekly") i0 = Math.max(0, Math.floor(gap / 7));
  else i0 = Math.max(0, (fy - by) * 12 + (fm - bm) - 1);
  for (let i = i0; i < i0 + 500; i++) {
    let date: string;
    if (r.repeat === "daily") date = addDays(base.date, i);
    else if (r.repeat === "weekly") date = addDays(base.date, 7 * i);
    else {
      const idx = bm - 1 + i;
      const y = by + Math.floor(idx / 12);
      const m = idx % 12;
      const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      date = ymd(Date.UTC(y, m, Math.min(bd, dim)));
    }
    if (date > limit) break;
    if (date >= from) out.push(mk(date));
  }
  return out;
}
// END-DATES

// результат запроса к базе: ошибка базы становится ошибкой сервера (в журнал)
function must<T>(res: { data: T[] | null; error: { message: string } | null }): T[] {
  if (res.error) throw new Error(res.error.message);
  return res.data ?? [];
}

const REPEATS = ["none", "daily", "weekly", "monthly"];
const MAX_SHIFT_TYPES = 20;

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

  // ───────── календарь смен ─────────
  // Всё за период одним запросом: типы смен, смены, отпуска/больничные и напоминания (уже по датам).
  async "shifts.range"(ctx, p) {
    const { from, to } = reqRange(p);
    const tz = ctx.target.timezone;
    const uid = ctx.target.id;
    const fromUtc = localToUtc(from, "00:00", tz).toISOString();
    const toUtc = localToUtc(addDays(to, 1), "00:00", tz).toISOString();

    const [types, shifts, absences, once, repeating] = await Promise.all([
      db.from("shift_types").select("id, name, default_start, default_end, sort")
        .eq("user_id", uid).order("sort").order("name"),
      db.from("shifts").select("id, shift_date, type_id, type_name, start_at, end_at, comment")
        .eq("user_id", uid).gte("shift_date", from).lte("shift_date", to).order("shift_date"),
      db.from("absences").select("id, kind, start_date, end_date, note")
        .eq("user_id", uid).lte("start_date", to).gte("end_date", from).order("start_date"),
      db.from("reminders").select("id, text, remind_at, advance_minutes, repeat, repeat_until, done_at")
        .eq("user_id", uid).eq("repeat", "none").gte("remind_at", fromUtc).lt("remind_at", toUtc),
      db.from("reminders").select("id, text, remind_at, advance_minutes, repeat, repeat_until, done_at")
        .eq("user_id", uid).neq("repeat", "none").lt("remind_at", toUtc)
        .or(`repeat_until.is.null,repeat_until.gte.${from}`),
    ]);

    const reminders = [...must(once), ...must(repeating)]
      .flatMap((r) => expandReminder(r as ReminderRow, from, to, tz))
      .sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1));

    return {
      types: must(types).map((t) => ({
        id: t.id, name: t.name,
        default_start: t.default_start ? String(t.default_start).slice(0, 5) : null,
        default_end: t.default_end ? String(t.default_end).slice(0, 5) : null,
      })),
      shifts: must(shifts).map((s) => ({
        id: s.id, date: s.shift_date, type_id: s.type_id, type_name: s.type_name, comment: s.comment,
        start: localParts(new Date(s.start_at), tz).time, end: localParts(new Date(s.end_at), tz).time,
      })),
      absences: must(absences),
      reminders,
    };
  },

  // Одна и та же смена на несколько дат сразу (мультивыбор). Смена на дату одна: новая заменяет старую.
  async "shifts.save"(ctx, p) {
    assertWritable(ctx);
    const tz = ctx.target.timezone;
    const dates = reqDates(p.dates);
    const start = reqTime(p.start, "Начало смены");
    const end = reqTime(p.end, "Конец смены");
    if (start === end) throw new HttpError(400, "Начало и конец смены совпадают");
    const comment = reqText(p.comment, "Комментарий", 300, false);

    let typeId: string | null = null;
    let typeName = reqText(p.type_name, "Название", 40, false);
    if (p.type_id) {
      const { data } = await db.from("shift_types").select("id, name")
        .eq("id", reqId(p.type_id)).eq("user_id", ctx.target.id).maybeSingle();
      if (!data) throw new HttpError(404, "Тип смены не найден");
      typeId = data.id; typeName = data.name;
    }
    if (!typeName) throw new HttpError(400, "Выбери тип смены или впиши название");

    const rows = dates.map((d) => ({
      user_id: ctx.target.id, shift_date: d, type_id: typeId, type_name: typeName,
      start_at: localToUtc(d, start, tz).toISOString(),
      // конец «раньше» начала значит, что смена переходит через полночь
      end_at: localToUtc(end <= start ? addDays(d, 1) : d, end, tz).toISOString(),
      comment, evening_sent_at: null, before_sent_at: null,
    }));
    const { error } = await db.from("shifts").upsert(rows, { onConflict: "user_id,shift_date" });
    if (error) throw new Error(error.message);
    return { ok: true, saved: rows.length };
  },

  async "shifts.delete"(ctx, p) {
    assertWritable(ctx);
    const dates = reqDates(p.dates);
    const { error } = await db.from("shifts").delete().eq("user_id", ctx.target.id).in("shift_date", dates);
    if (error) throw new Error(error.message);
    return { ok: true };
  },

  async "shift_types.save"(ctx, p) {
    assertWritable(ctx);
    const row = {
      name: reqText(p.name, "Название", 40) as string,
      default_start: optTime(p.default_start, "Начало"),
      default_end: optTime(p.default_end, "Конец"),
    };
    if (p.id) {
      const { error } = await db.from("shift_types").update(row)
        .eq("id", reqId(p.id)).eq("user_id", ctx.target.id);
      if (error) throw new Error(error.message);
    } else {
      const { data: list } = await db.from("shift_types").select("sort").eq("user_id", ctx.target.id);
      if ((list?.length ?? 0) >= MAX_SHIFT_TYPES) throw new HttpError(400, "Типов смен уже достаточно");
      const sort = Math.max(0, ...(list ?? []).map((x) => x.sort as number)) + 1;
      const { error } = await db.from("shift_types").insert({ ...row, user_id: ctx.target.id, sort });
      if (error) throw new Error(error.message);
    }
    return { ok: true };
  },

  // Старые смены не меняются: у них остаётся копия названия (type_name).
  async "shift_types.delete"(ctx, p) {
    assertWritable(ctx);
    const { error } = await db.from("shift_types").delete()
      .eq("id", reqId(p.id)).eq("user_id", ctx.target.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  },

  async "absences.save"(ctx, p) {
    assertWritable(ctx);
    const kind = String(p.kind ?? "");
    if (kind !== "vacation" && kind !== "sick") throw new HttpError(400, "Выбери: отпуск или больничный");
    const start_date = reqDate(p.start_date, "Первый день");
    const end_date = reqDate(p.end_date, "Последний день");
    if (end_date < start_date) throw new HttpError(400, "Последний день раньше первого");
    if ((dayMs(end_date) - dayMs(start_date)) / DAY_MS > 366) throw new HttpError(400, "Слишком длинный период");
    const row = { kind, start_date, end_date, note: reqText(p.note, "Заметка", 200, false) };
    if (p.id) {
      const { error } = await db.from("absences").update(row)
        .eq("id", reqId(p.id)).eq("user_id", ctx.target.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await db.from("absences").insert({ ...row, user_id: ctx.target.id });
      if (error) throw new Error(error.message);
    }
    return { ok: true };
  },

  async "absences.delete"(ctx, p) {
    assertWritable(ctx);
    const { error } = await db.from("absences").delete()
      .eq("id", reqId(p.id)).eq("user_id", ctx.target.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  },

  // remind_at — момент самого события по местному времени; за сколько минут напомнить, хранится отдельно
  async "reminders.save"(ctx, p) {
    assertWritable(ctx);
    const date = reqDate(p.date, "Дата");
    const time = reqTime(p.time, "Время");
    const repeat = String(p.repeat ?? "none");
    if (!REPEATS.includes(repeat)) throw new HttpError(400, "Неверный повтор");
    const advance = Math.trunc(Number(p.advance_minutes ?? 0));
    if (!Number.isFinite(advance) || advance < 0 || advance > 10080) throw new HttpError(400, "Неверное «за сколько напомнить»");
    let repeat_until: string | null = null;
    if (repeat !== "none" && p.repeat_until) {
      repeat_until = reqDate(p.repeat_until, "Повторять до");
      if (repeat_until < date) throw new HttpError(400, "«Повторять до» раньше даты напоминания");
    }
    const row = {
      text: reqText(p.text, "Текст", 200) as string,
      remind_at: localToUtc(date, time, ctx.target.timezone).toISOString(),
      advance_minutes: advance, repeat, repeat_until, done_at: null, sent_at: null,
    };
    if (p.id) {
      const { error } = await db.from("reminders").update(row)
        .eq("id", reqId(p.id)).eq("user_id", ctx.target.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await db.from("reminders").insert({ ...row, user_id: ctx.target.id });
      if (error) throw new Error(error.message);
    }
    return { ok: true };
  },

  async "reminders.done"(ctx, p) {
    assertWritable(ctx);
    const { error } = await db.from("reminders")
      .update({ done_at: p.done === false ? null : new Date().toISOString() })
      .eq("id", reqId(p.id)).eq("user_id", ctx.target.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  },

  async "reminders.delete"(ctx, p) {
    assertWritable(ctx);
    const { error } = await db.from("reminders").delete()
      .eq("id", reqId(p.id)).eq("user_id", ctx.target.id);
    if (error) throw new Error(error.message);
    return { ok: true };
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
