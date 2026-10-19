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
  // Доступ закрытый: работают только те, кто уже есть в таблице users.
  // Новую запись можно создать лишь тому, чей Telegram-id указан в секрете ADMIN_TG_ID.
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
  if (!envAdmin) throw new HttpError(403, "Это закрытое приложение");
  const { data, error } = await db.from("users")
    .insert({ tg_id: tg.id, first_name: tg.first_name ?? null, role: "admin" })
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

// ───────── контекст запроса: кто работает и чьи данные ─────────
// Данные общие: если у пользователя указан data_owner_id, он работает с данными владельца
// (тот же интерфейс, те же записи, правки видны обоим). Режима просмотра нет.
type Ctx = { actor: DbUser; target: DbUser };

async function buildCtx(actor: DbUser): Promise<Ctx> {
  const ownerId = actor.data_owner_id as string | null | undefined;
  if (!ownerId || ownerId === actor.id) return { actor, target: actor };
  const { data } = await db.from("users").select("*").eq("id", ownerId).maybeSingle();
  if (!data) throw new HttpError(500, "Не найден владелец данных");
  return { actor, target: data as DbUser };
}

// Вкладка «Цикл» закрыта для второго человека, пока владелец сама не включила обмен.
// Эта проверка нужна в каждом обработчике данных цикла.
export async function assertCycleAccess(ctx: Ctx) {
  if (ctx.actor.id === ctx.target.id) return;
  const { data } = await db.from("user_settings")
    .select("cycle_share_partner").eq("user_id", ctx.target.id).single();
  if (!data?.cycle_share_partner) throw new HttpError(403, "Цикл закрыт владельцем");
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

// BEGIN-HABITS (чистая логика привычек: серии и неделя; без обращений к базе, проверяется отдельным тестом)
const HABIT_HISTORY_DAYS = 400;
const isoDow = (date: string) => { const d = new Date(dayMs(date)).getUTCDay(); return d === 0 ? 7 : d; };

type HabitLite = { kind: string; days: number[]; start_date: string };

// «Делать»: день входит в расписание. «Не делать»: каждый день с начала.
function habitScheduled(h: HabitLite, date: string): boolean {
  if (date < h.start_date) return false;
  return h.kind === "avoid" ? true : h.days.includes(isoDow(date));
}

// logs: дата -> 'done' | 'slip'. Серия «делать»: подряд выполненные дни расписания (дни вне расписания
// серию не рвут, сегодняшний день не рвёт её до конца дня). Серия «не делать»: дней без срыва, включая сегодня.
function habitStreaks(h: HabitLite, logs: Map<string, string>, today: string) {
  const from = Math.max(dayMs(h.start_date), dayMs(today) - HABIT_HISTORY_DAYS * DAY_MS);
  let run = 0, best = 0;
  for (let t = from; t <= dayMs(today); t += DAY_MS) {
    const date = ymd(t);
    const st = logs.get(date);
    if (h.kind === "avoid") {
      run = st === "slip" ? 0 : run + 1;
      if (run > best) best = run;
    } else {
      if (!habitScheduled(h, date)) continue;
      if (st === "done") { run++; if (run > best) best = run; }
      else if (date !== today) run = 0;
    }
  }
  return { current: run, best };
}

// Семь последних дней для полоски на карточке.
// «делать»: done | miss | open (сегодня, ещё можно) | off (вне расписания);
// «не делать»: clean | slip | off (до начала).
function habitWeek(h: HabitLite, logs: Map<string, string>, today: string) {
  const out: { date: string; state: string }[] = [];
  for (let i = 6; i >= 0; i--) {
    const date = addDays(today, -i);
    const st = logs.get(date);
    let state: string;
    if (h.kind === "avoid") state = date < h.start_date ? "off" : st === "slip" ? "slip" : "clean";
    else if (!habitScheduled(h, date)) state = "off";
    else state = st === "done" ? "done" : date === today ? "open" : "miss";
    out.push({ date, state });
  }
  return out;
}
// END-HABITS

// результат запроса к базе: ошибка базы становится ошибкой сервера (в журнал)
function must<T>(res: { data: T[] | null; error: { message: string } | null }): T[] {
  if (res.error) throw new Error(res.error.message);
  return res.data ?? [];
}

const REPEATS = ["none", "daily", "weekly", "monthly"];
const MAX_SHIFT_TYPES = 20;
const MAX_HABITS = 30;
const HABIT_SHIFT_MODES = ["normal", "evening", "silent"];

// дни недели привычки: числа 1..7 (понедельник = 1), хотя бы один
function reqDays(v: unknown): number[] {
  if (!Array.isArray(v)) throw new HttpError(400, "Выбери дни недели");
  const days = [...new Set(v.map(Number))].filter((n) => Number.isInteger(n) && n >= 1 && n <= 7).sort();
  if (!days.length) throw new HttpError(400, "Выбери хотя бы один день недели");
  return days;
}

// ───────── цикл: прогноз ─────────
// BEGIN-CYCLE (чистые функции без обращений к базе)
type CycleRow = { id: string; start_date: string; end_date: string | null };
const LUTEAL_DAYS = 14;      // от овуляции до следующих месячных
const FERTILE_BEFORE = 5;    // окно: за 5 дней до овуляции и сутки после
const FERTILE_AFTER = 1;
const FORECAST_CYCLES = 3;

function cycleAverages(cycles: CycleRow[], typicalLen: number, typicalPeriod: number) {
  const asc = [...cycles].sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
  const lens: number[] = [];
  for (let i = 1; i < asc.length; i++) {
    const n = Math.round((dayMs(asc[i].start_date) - dayMs(asc[i - 1].start_date)) / DAY_MS);
    if (n >= 15 && n <= 60) lens.push(n); // слишком короткие и слишком длинные считаем сбоем записи
  }
  const periods = asc.filter((c) => c.end_date)
    .map((c) => Math.round((dayMs(c.end_date!) - dayMs(c.start_date)) / DAY_MS) + 1)
    .filter((n) => n >= 1 && n <= 14);
  const avg = (a: number[], fb: number) => a.length ? Math.round(a.slice(-6).reduce((s, x) => s + x, 0) / Math.min(a.length, 6)) : fb;
  return { len: avg(lens, typicalLen), period: avg(periods, typicalPeriod), samples: lens.length };
}

function cyclePredict(cycles: CycleRow[], typicalLen: number, typicalPeriod: number, today: string) {
  const asc = [...cycles].sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
  const avg = cycleAverages(asc, typicalLen, typicalPeriod);
  const last = asc[asc.length - 1];
  if (!last) return { avg, last_start: null, forecast: [], delay_days: 0, day: null, phase: null, ongoing: false };

  const forecast: { start: string; period_end: string; ovulation: string; fertile_from: string; fertile_to: string }[] = [];
  for (let k = 1; k <= FORECAST_CYCLES; k++) {
    const start = addDays(last.start_date, avg.len * k);
    const ovulation = addDays(start, -LUTEAL_DAYS);
    forecast.push({
      start, period_end: addDays(start, avg.period - 1), ovulation,
      fertile_from: addDays(ovulation, -FERTILE_BEFORE), fertile_to: addDays(ovulation, FERTILE_AFTER),
    });
  }

  // «идут»: конец не отмечен и прошло не больше 10 дней, пока можно нажать «Закончились»
  const ongoing = !last.end_date && today <= addDays(last.start_date, 9);
  const day = Math.round((dayMs(today) - dayMs(last.start_date)) / DAY_MS) + 1;
  const next = forecast[0];
  // задержка: ожидаемая дата прошла, а новый цикл не начат
  const delay = today > next.start ? Math.round((dayMs(today) - dayMs(next.start)) / DAY_MS) : 0;

  let phase: string;
  const periodEnd = last.end_date ?? addDays(last.start_date, avg.period - 1);
  if (day < 1) phase = "future";
  // если конец не отмечен, даём запас в два дня сверх обычной длины месячных
  else if (today <= periodEnd || (ongoing && today <= addDays(periodEnd, 2))) phase = "period";
  else if (delay > 0) phase = "delay";
  else if (today === next.ovulation) phase = "ovulation";
  else if (today > next.ovulation) phase = "luteal";
  else phase = "follicular";

  return { avg, last_start: last.start_date, forecast, delay_days: delay, day, phase, ongoing };
}
// END-CYCLE

const CYCLE_FEELING = ["good", "ok", "bad"];
const CYCLE_PAIN = ["none", "light", "strong"];
const CYCLE_FLOW = ["light", "medium", "heavy"];
const CYCLE_MOODS = ["calm", "happy", "irritable", "anxious", "sad", "tired", "energetic"];

// ───────── действия ─────────
const THEMES = ["auto", "light", "dark", "thrones", "dead"];
// общие настройки: лежат у владельца данных, меняют оба
const SETTINGS_FIELDS = [
  "shift_evening_on", "shift_evening_time", "shift_before_on", "shift_before_hours",
  "cycle_remind_days", "cycle_neutral_text", "cycle_typical_length", "cycle_typical_period",
  "cycle_lock", "cycle_share_partner",
];
const CYCLE_SETTINGS = [
  "cycle_remind_days", "cycle_neutral_text", "cycle_typical_length", "cycle_typical_period",
  "cycle_lock", "cycle_share_partner",
];
const USER_FIELDS = ["timezone", "quiet_on", "quiet_from", "quiet_to", "quiet_strict_shifts", "week_start", "paused_until"];
// личное: имя, значок и тема хранятся у того, кто открыл приложение
const PROFILE_FIELDS = ["display_name", "avatar", "theme"];

function pick(src: Record<string, unknown>, keys: string[]) {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in src) out[k] = src[k];
  return out;
}

// Проверка значений до записи в базу: понятная ошибка вместо ответа базы
function cleanValues(v: Record<string, unknown>) {
  const bad = (k: string) => new HttpError(400, "Неверное значение: " + k);
  const bool = (k: string) => { if (typeof v[k] !== "boolean") throw bad(k); };
  const int = (k: string, min: number, max: number) => {
    const x = v[k];
    if (typeof x !== "number" || !Number.isInteger(x) || x < min || x > max) throw bad(k);
  };
  const time = (k: string) => { if (typeof v[k] !== "string" || !TIME_RE.test(v[k] as string)) throw bad(k); };

  for (const k of Object.keys(v)) {
    switch (k) {
      case "shift_evening_on": case "shift_before_on": case "quiet_on": case "quiet_strict_shifts":
      case "cycle_neutral_text": case "cycle_lock": case "cycle_share_partner":
        bool(k); break;
      case "shift_evening_time": case "quiet_from": case "quiet_to":
        time(k); break;
      case "shift_before_hours": int(k, 1, 12); break;
      case "cycle_remind_days": int(k, 0, 7); break;
      case "cycle_typical_length": int(k, 20, 45); break;
      case "cycle_typical_period": int(k, 1, 12); break;
      case "week_start": int(k, 0, 1); break;
      case "timezone":
        try { new Intl.DateTimeFormat("en", { timeZone: String(v[k]) }); } catch { throw bad(k); }
        break;
      case "paused_until":
        if (v[k] !== null) {
          const ms = typeof v[k] === "string" ? Date.parse(v[k] as string) : NaN;
          if (!Number.isFinite(ms) || ms > Date.now() + 400 * DAY_MS) throw bad(k);
          v[k] = new Date(ms).toISOString();
        }
        break;
      case "theme":
        if (!THEMES.includes(String(v[k]))) throw bad(k);
        break;
      case "display_name": {
        const t = v[k] === null ? "" : String(v[k]).trim();
        if (t.length > 30) throw new HttpError(400, "Имя не длиннее 30 символов");
        v[k] = t || null;
        break;
      }
      case "avatar": {
        const t = v[k] === null ? "" : String(v[k]).trim();
        if ([...t].length > 4) throw bad(k);
        v[k] = t || null;
        break;
      }
    }
  }
  return v;
}

type Handler = (ctx: Ctx, p: Record<string, unknown>) => Promise<unknown>;

const actions: Record<string, Handler> = {
  async health() {
    return { ok: true, time: new Date().toISOString() };
  },

  async me(ctx) {
    const { data: settings } = await db.from("user_settings").select("*").eq("user_id", ctx.target.id).single();
    const isSelf = ctx.actor.id === ctx.target.id;
    // настройки цикла видны только тому, кому открыта вкладка «Цикл»
    const out: Record<string, unknown> = { ...(settings ?? {}) };
    if (!isSelf && !settings?.cycle_share_partner) for (const k of CYCLE_SETTINGS) delete out[k];
    // оформление у каждого своё
    out.theme = (ctx.actor.theme as string) ?? "auto";

    const { data: people } = await db.from("users")
      .select("id, first_name, display_name, avatar")
      .or(`id.eq.${ctx.target.id},data_owner_id.eq.${ctx.target.id}`);

    return {
      user: {
        id: ctx.target.id, first_name: ctx.target.first_name, timezone: ctx.target.timezone,
        quiet_on: ctx.target.quiet_on, quiet_from: ctx.target.quiet_from, quiet_to: ctx.target.quiet_to,
        quiet_strict_shifts: ctx.target.quiet_strict_shifts, week_start: ctx.target.week_start,
        paused_until: ctx.target.paused_until, bot_blocked: ctx.target.bot_blocked,
      },
      settings: out,
      profile: {
        first_name: ctx.actor.first_name,
        display_name: (ctx.actor.display_name as string | null) ?? null,
        avatar: (ctx.actor.avatar as string | null) ?? null,
      },
      members: (people ?? []).map((m) => ({
        id: m.id, name: m.display_name ?? m.first_name, avatar: m.avatar ?? null, is_me: m.id === ctx.actor.id,
      })),
      viewer: { role: ctx.actor.role, is_self: isSelf },
    };
  },

  async "settings.update"(ctx, p) {
    const u = pick(p, USER_FIELDS);
    const s = pick(p, SETTINGS_FIELDS);
    const me = pick(p, PROFILE_FIELDS);
    cleanValues(u); cleanValues(s); cleanValues(me);

    // настройки цикла: второму человеку только когда вкладка открыта, а обмен включает лишь владелец
    if (Object.keys(s).some((k) => CYCLE_SETTINGS.includes(k))) await assertCycleAccess(ctx);
    if ("cycle_share_partner" in s && ctx.actor.id !== ctx.target.id) {
      throw new HttpError(403, "Доступ к циклу меняет только владелец");
    }

    if (Object.keys(u).length) {
      const { error } = await db.from("users").update(u).eq("id", ctx.target.id);
      if (error) throw new HttpError(400, error.message);
    }
    if (Object.keys(s).length) {
      const { error } = await db.from("user_settings").update(s).eq("user_id", ctx.target.id);
      if (error) throw new HttpError(400, error.message);
    }
    if (Object.keys(me).length) {
      const { error } = await db.from("users").update(me).eq("id", ctx.actor.id);
      if (error) throw new HttpError(400, error.message);
    }
    // берём свежие строки: правки общих полей у владельца, личных у того, кто открыл приложение
    if (Object.keys(u).length || Object.keys(me).length) {
      const { data: a } = await db.from("users").select("*").eq("id", ctx.actor.id).single();
      if (a) ctx.actor = a as DbUser;
      if (ctx.actor.id === ctx.target.id) ctx.target = ctx.actor;
      else {
        const { data: t } = await db.from("users").select("*").eq("id", ctx.target.id).single();
        if (t) ctx.target = t as DbUser;
      }
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
    const dates = reqDates(p.dates);
    const { error } = await db.from("shifts").delete().eq("user_id", ctx.target.id).in("shift_date", dates);
    if (error) throw new Error(error.message);
    return { ok: true };
  },

  async "shift_types.save"(ctx, p) {
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
    const { error } = await db.from("shift_types").delete()
      .eq("id", reqId(p.id)).eq("user_id", ctx.target.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  },

  async "absences.save"(ctx, p) {
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
    const { error } = await db.from("absences").delete()
      .eq("id", reqId(p.id)).eq("user_id", ctx.target.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  },

  // remind_at — момент самого события по местному времени; за сколько минут напомнить, хранится отдельно
  async "reminders.save"(ctx, p) {
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
    const { error } = await db.from("reminders")
      .update({ done_at: p.done === false ? null : new Date().toISOString() })
      .eq("id", reqId(p.id)).eq("user_id", ctx.target.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  },

  async "reminders.delete"(ctx, p) {
    const { error } = await db.from("reminders").delete()
      .eq("id", reqId(p.id)).eq("user_id", ctx.target.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  },

  // ───────── привычки ─────────
  // Всё одним запросом: активные привычки с сериями и полоской недели, плюс короткий список архива.
  async "habits.list"(ctx) {
    const uid = ctx.target.id;
    const today = localParts(new Date(), ctx.target.timezone).date;
    const since = addDays(today, -HABIT_HISTORY_DAYS);
    const [hs, ls] = await Promise.all([
      db.from("habits")
        .select("id, name, kind, days, remind_time, shift_mode, evening_time, start_date, best_streak, total_done, archived_at")
        .eq("user_id", uid).order("created_at"),
      db.from("habit_logs").select("habit_id, log_date, status").eq("user_id", uid).gte("log_date", since),
    ]);
    const logsBy = new Map<string, Map<string, string>>();
    for (const l of must(ls)) {
      const m = logsBy.get(l.habit_id) ?? new Map<string, string>();
      // если за день есть и «сделано», и «срыв», срыв важнее
      if (m.get(l.log_date) !== "slip") m.set(l.log_date, l.status);
      logsBy.set(l.habit_id, m);
    }
    const habits: unknown[] = [];
    const archived: unknown[] = [];
    for (const h of must(hs)) {
      if (h.archived_at) { archived.push({ id: h.id, name: h.name, kind: h.kind }); continue; }
      const lite = { kind: h.kind, days: h.days as number[], start_date: h.start_date };
      const logs = logsBy.get(h.id) ?? new Map<string, string>();
      const st = habitStreaks(lite, logs, today);
      const best = Math.max(st.best, h.best_streak ?? 0);
      if (best > (h.best_streak ?? 0)) {
        await db.from("habits").update({ best_streak: best }).eq("id", h.id);
      }
      const done = [...logs.values()].filter((v) => v === "done").length;
      habits.push({
        id: h.id, name: h.name, kind: h.kind, days: h.days, start_date: h.start_date,
        remind_time: h.remind_time ? String(h.remind_time).slice(0, 5) : null,
        shift_mode: h.shift_mode, evening_time: String(h.evening_time).slice(0, 5),
        streak: st.current, best,
        total: h.kind === "do" ? (h.total_done ?? 0) + done : null,
        today: logs.get(today) ?? null,
        week: habitWeek(lite, logs, today),
      });
    }
    return { today, habits, archived };
  },

  // Тип и дата начала при изменении не меняются: иначе отметки потеряют смысл.
  async "habits.save"(ctx, p) {
    const name = reqText(p.name, "Название", 80) as string;
    const shift_mode = String(p.shift_mode ?? "normal");
    if (!HABIT_SHIFT_MODES.includes(shift_mode)) throw new HttpError(400, "Неверный режим в дни смен");
    const remind_time = optTime(p.remind_time, "Время напоминания");
    const evening_time = p.evening_time ? reqTime(p.evening_time, "Вечернее время") : "21:30";

    if (p.id) {
      const id = reqId(p.id);
      const { data: cur } = await db.from("habits").select("kind").eq("id", id).eq("user_id", ctx.target.id).maybeSingle();
      if (!cur) throw new HttpError(404, "Привычка не найдена");
      const row: Record<string, unknown> = { name, remind_time, shift_mode, evening_time };
      if (cur.kind === "do") row.days = reqDays(p.days);
      const { error } = await db.from("habits").update(row).eq("id", id).eq("user_id", ctx.target.id);
      if (error) throw new Error(error.message);
      return { ok: true };
    }

    const kind = String(p.kind ?? "");
    if (kind !== "do" && kind !== "avoid") throw new HttpError(400, "Выбери: делать или не делать");
    const { count } = await db.from("habits").select("id", { count: "exact", head: true })
      .eq("user_id", ctx.target.id).is("archived_at", null);
    if ((count ?? 0) >= MAX_HABITS) throw new HttpError(400, "Привычек уже достаточно, убери лишние в архив");
    const { error } = await db.from("habits").insert({
      user_id: ctx.target.id, name, kind, remind_time, shift_mode, evening_time,
      days: kind === "do" ? reqDays(p.days) : [1, 2, 3, 4, 5, 6, 7],
      start_date: localParts(new Date(), ctx.target.timezone).date,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  },

  // status: «done» для «делать», «slip» для «не делать», null снимает отметку. Отмечать можно последние 14 дней.
  async "habits.mark"(ctx, p) {
    const id = reqId(p.id);
    const date = reqDate(p.date, "Дата");
    const { data: h } = await db.from("habits").select("id, kind, start_date, archived_at")
      .eq("id", id).eq("user_id", ctx.target.id).maybeSingle();
    if (!h || h.archived_at) throw new HttpError(404, "Привычка не найдена");
    const today = localParts(new Date(), ctx.target.timezone).date;
    if (date > today) throw new HttpError(400, "Будущие дни отмечать нельзя");
    if (date < addDays(today, -14)) throw new HttpError(400, "Отметить можно только последние две недели");
    if (date < h.start_date) throw new HttpError(400, "Привычка тогда ещё не началась");
    const status = p.status === null || p.status === undefined || p.status === "" ? null : String(p.status);
    if (status !== null && status !== (h.kind === "avoid" ? "slip" : "done")) throw new HttpError(400, "Неверная отметка");
    const del = await db.from("habit_logs").delete().eq("habit_id", id).eq("log_date", date);
    if (del.error) throw new Error(del.error.message);
    if (status) {
      const { error } = await db.from("habit_logs").insert({ habit_id: id, user_id: ctx.target.id, log_date: date, status });
      if (error) throw new Error(error.message);
    }
    return { ok: true };
  },

  async "habits.archive"(ctx, p) {
    const archived = p.archived !== false;
    const { error } = await db.from("habits")
      .update({ archived_at: archived ? new Date().toISOString() : null })
      .eq("id", reqId(p.id)).eq("user_id", ctx.target.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  },

  // Насовсем удалить можно только привычку из архива (отметки удаляются вместе с ней).
  async "habits.delete"(ctx, p) {
    const { data, error } = await db.from("habits").delete()
      .eq("id", reqId(p.id)).eq("user_id", ctx.target.id).not("archived_at", "is", null).select("id");
    if (error) throw new Error(error.message);
    if (!data?.length) throw new HttpError(400, "Сначала убери привычку в архив");
    return { ok: true };
  },

  // ───────── цикл ─────────
  // Данные за период для календаря, история циклов и прогноз одним запросом.
  async "cycle.get"(ctx, p) {
    await assertCycleAccess(ctx);
    const { from, to } = reqRange(p);
    const uid = ctx.target.id;
    const today = localParts(new Date(), ctx.target.timezone).date;
    const [cs, ns, st] = await Promise.all([
      db.from("cycles").select("id, start_date, end_date").eq("user_id", uid)
        .order("start_date", { ascending: false }).limit(12),
      db.from("cycle_notes").select("note_date, feeling, pain, mood, flow, body").eq("user_id", uid)
        .gte("note_date", from).lte("note_date", to),
      db.from("user_settings").select("cycle_remind_days, cycle_typical_length, cycle_typical_period").eq("user_id", uid).single(),
    ]);
    const cycles = must(cs) as CycleRow[];
    const s = st.data;
    if (!s) throw new Error("Нет настроек пользователя");
    return {
      today,
      cycles: [...cycles].reverse(),
      notes: must(ns),
      pred: cyclePredict(cycles, s.cycle_typical_length, s.cycle_typical_period, today),
      settings: { remind_days: s.cycle_remind_days, typical_length: s.cycle_typical_length, typical_period: s.cycle_typical_period },
    };
  },

  // «Начались»: новый цикл с этой даты. Если прошлые месячные остались открытыми, закрываем их.
  async "cycle.start"(ctx, p) {
    await assertCycleAccess(ctx);
    const uid = ctx.target.id;
    const today = localParts(new Date(), ctx.target.timezone).date;
    const date = reqDate(p.date);
    if (date > today) throw new HttpError(400, "Нельзя отметить дату из будущего");
    if (date < addDays(today, -366)) throw new HttpError(400, "Слишком давняя дата");
    const rows = must(await db.from("cycles").select("id, start_date, end_date").eq("user_id", uid)
      .order("start_date", { ascending: false }).limit(24)) as CycleRow[];
    if (rows.some((c) => c.start_date <= date && date <= (c.end_date ?? c.start_date))) {
      throw new HttpError(400, "Эта дата уже входит в отмеченные месячные");
    }
    const { data: s } = await db.from("user_settings").select("cycle_typical_period").eq("user_id", uid).single();
    const typical = s?.cycle_typical_period ?? 5;
    const open = rows.find((c) => !c.end_date && c.start_date < date);
    if (open) {
      const end = addDays(open.start_date, typical - 1);
      await db.from("cycles").update({ end_date: end < date ? end : addDays(date, -1) }).eq("id", open.id);
    }
    const { error } = await db.from("cycles").insert({ user_id: uid, start_date: date });
    if (error) throw new HttpError(400, "Не получилось сохранить: " + error.message);
    return { ok: true };
  },

  // «Закончились»: последний день месячных
  async "cycle.end"(ctx, p) {
    await assertCycleAccess(ctx);
    const uid = ctx.target.id;
    const today = localParts(new Date(), ctx.target.timezone).date;
    const id = reqId(p.id);
    const date = reqDate(p.date);
    if (date > today) throw new HttpError(400, "Нельзя отметить дату из будущего");
    const { data: c } = await db.from("cycles").select("id, start_date").eq("id", id).eq("user_id", uid).maybeSingle();
    if (!c) throw new HttpError(404, "Цикл не найден");
    if (date < c.start_date) throw new HttpError(400, "Конец раньше начала");
    if ((dayMs(date) - dayMs(c.start_date)) / DAY_MS > 20) throw new HttpError(400, "Месячные не могут идти так долго");
    const { data: later } = await db.from("cycles").select("start_date").eq("user_id", uid)
      .gt("start_date", c.start_date).order("start_date").limit(1);
    if (later?.length && date >= later[0].start_date) throw new HttpError(400, "Дата заходит на следующий цикл");
    const { error } = await db.from("cycles").update({ end_date: date }).eq("id", id);
    if (error) throw new Error(error.message);
    return { ok: true };
  },

  // правка дат уже записанного цикла
  async "cycle.edit"(ctx, p) {
    await assertCycleAccess(ctx);
    const uid = ctx.target.id;
    const today = localParts(new Date(), ctx.target.timezone).date;
    const id = reqId(p.id);
    const start = reqDate(p.start_date, "Начало");
    const end = p.end_date ? reqDate(p.end_date, "Конец") : null;
    if (start > today) throw new HttpError(400, "Нельзя отметить дату из будущего");
    if (end && end < start) throw new HttpError(400, "Конец раньше начала");
    if (end && end > today) throw new HttpError(400, "Нельзя отметить дату из будущего");
    if (end && (dayMs(end) - dayMs(start)) / DAY_MS > 20) throw new HttpError(400, "Месячные не могут идти так долго");
    const rows = must(await db.from("cycles").select("id, start_date, end_date").eq("user_id", uid)) as CycleRow[];
    if (!rows.some((c) => c.id === id)) throw new HttpError(404, "Цикл не найден");
    const hi = end ?? start;
    for (const c of rows) {
      if (c.id === id) continue;
      if (start <= (c.end_date ?? c.start_date) && c.start_date <= hi) throw new HttpError(400, "Даты пересекаются с другим циклом");
    }
    const { error } = await db.from("cycles").update({ start_date: start, end_date: end }).eq("id", id).eq("user_id", uid);
    if (error) throw new HttpError(400, "Не получилось сохранить: " + error.message);
    return { ok: true };
  },

  async "cycle.delete"(ctx, p) {
    await assertCycleAccess(ctx);
    const { error } = await db.from("cycles").delete().eq("id", reqId(p.id)).eq("user_id", ctx.target.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  },

  // заметка на день: самочувствие, боль, настроение, выделения, текст. Пустая заметка удаляется.
  async "cycle.note"(ctx, p) {
    await assertCycleAccess(ctx);
    const uid = ctx.target.id;
    const today = localParts(new Date(), ctx.target.timezone).date;
    const date = reqDate(p.date);
    if (date > today) throw new HttpError(400, "Нельзя добавить заметку на будущую дату");
    const one = (v: unknown, allowed: string[], label: string) => {
      if (v === null || v === undefined || v === "") return null;
      if (!allowed.includes(String(v))) throw new HttpError(400, `${label}: неверное значение`);
      return String(v);
    };
    const feeling = one(p.feeling, CYCLE_FEELING, "Самочувствие");
    const pain = one(p.pain, CYCLE_PAIN, "Боль");
    const flow = one(p.flow, CYCLE_FLOW, "Выделения");
    const moodIn = Array.isArray(p.mood) ? p.mood.map(String) : [];
    if (moodIn.some((m) => !CYCLE_MOODS.includes(m))) throw new HttpError(400, "Настроение: неверное значение");
    const mood = [...new Set(moodIn)];
    const body = reqText(p.body, "Заметка", 500, false);
    if (!feeling && !pain && !flow && !mood.length && !body) {
      const { error } = await db.from("cycle_notes").delete().eq("user_id", uid).eq("note_date", date);
      if (error) throw new Error(error.message);
      return { ok: true, removed: true };
    }
    const { error } = await db.from("cycle_notes").upsert(
      { user_id: uid, note_date: date, feeling, pain, flow, mood, body },
      { onConflict: "user_id,note_date" },
    );
    if (error) throw new HttpError(400, "Не получилось сохранить: " + error.message);
    return { ok: true };
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
    const ctx = await buildCtx(actor);
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
