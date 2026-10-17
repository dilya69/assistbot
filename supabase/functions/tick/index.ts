// Edge Function `tick`: бот-планировщик. pg_cron вызывает её раз в минуту.
// Что делает:
//   1) отправляет напоминания (на дату, с повтором и «за сколько напомнить»);
//   2) за вечер до смены и за N часов до начала шлёт сообщения о смене.
// Вызов защищён секретом из Vault (заголовок x-cron-secret), см. миграцию 004.
// Секрет BOT_TOKEN тот же, что у функции `api`.
// Тест без отправки: POST {"dry": true} с тем же заголовком, вернёт, что было бы отправлено.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const BOT_TOKEN = Deno.env.get("BOT_TOKEN") ?? "";
const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

// BEGIN-PURE (без обращений к базе и сети; проверяется отдельным тестом)
const DAY_MS = 86400000;
const MIN_MS = 60000;
// Опоздавшее напоминание (тихие часы, сбой) уходит не позже чем через сутки, потом считается пропущенным.
const MAX_LATE_MS = DAY_MS;

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (date: string) => Date.parse(date + "T00:00:00Z");
const addDays = (date: string, n: number) => ymd(dayMs(date) + n * DAY_MS);

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

function localToUtcMs(date: string, time: string, tz: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - tzOffsetMs(tz, guess);
  t = guess - tzOffsetMs(tz, t);
  return t;
}

function localParts(ms: number, tz: string) {
  const p = partsIn(tz, ms);
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

type ReminderRow = {
  id: string; text: string; remind_at: string; advance_minutes: number;
  repeat: string; repeat_until: string | null; done_at: string | null; sent_at: string | null;
};

// Даты срабатывания напоминания внутри [from, to] по местному времени (как expandReminder в `api`).
function occurrenceDates(r: ReminderRow, from: string, to: string, tz: string): string[] {
  const base = localParts(Date.parse(r.remind_at), tz);
  if (r.repeat === "none") return base.date >= from && base.date <= to ? [base.date] : [];
  const out: string[] = [];
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
    if (date >= from) out.push(date);
  }
  return out;
}

// Какие срабатывания напоминания пора отправить сейчас.
// Для одиночного напоминания нужен sent_at = null и done_at = null; у повторяющегося
// каждое срабатывание помечается отдельно (ключ id:дата в sent_log).
function dueOccurrences(r: ReminderRow, tz: string, nowMs: number) {
  if (r.repeat === "none" && (r.done_at || r.sent_at)) return [];
  const advMs = Math.max(0, r.advance_minutes) * MIN_MS;
  const from = localParts(nowMs - DAY_MS, tz).date;
  const to = localParts(nowMs + advMs + DAY_MS, tz).date;
  const time = localParts(Date.parse(r.remind_at), tz).time;
  const out: { date: string; eventMs: number; fireMs: number }[] = [];
  for (const date of occurrenceDates(r, from, to, tz)) {
    const eventMs = localToUtcMs(date, time, tz);
    const fireMs = eventMs - advMs;
    if (fireMs <= nowMs && nowMs - fireMs <= MAX_LATE_MS) out.push({ date, eventMs, fireMs });
  }
  return out;
}

const hhmm = (s: string | null | undefined) => String(s ?? "").slice(0, 5);

// Тихие часы по местному времени; интервал может переходить через полночь (23:00–08:00).
function inQuiet(on: boolean, from: string, to: string, localTime: string): boolean {
  if (!on) return false;
  const f = hhmm(from), t = hhmm(to);
  if (f === t) return false;
  return f < t ? localTime >= f && localTime < t : localTime >= f || localTime < t;
}

function human(ms: number): string {
  const min = Math.round(ms / MIN_MS);
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return m ? `${h} ч ${m} мин` : `${h} ч`;
  const d = Math.floor(h / 24), hh = h % 24;
  return hh ? `${d} дн ${hh} ч` : `${d} дн`;
}

function dayLabel(date: string, today: string): string {
  if (date === today) return "";
  if (date === addDays(today, 1)) return "завтра ";
  const [, m, d] = date.split("-");
  return `${d}.${m} `;
}

function reminderMessage(text: string, date: string, time: string, eventMs: number, nowMs: number, today: string) {
  const diff = eventMs - nowMs;
  let tail = "";
  if (diff >= MIN_MS) tail = `\n🕐 ${dayLabel(date, today)}в ${time} (через ${human(diff)})`;
  else if (diff <= -5 * MIN_MS) tail = `\n🕐 было в ${time}`;
  return `🔔 ${text}${tail}`;
}

function shiftEveningMessage(typeName: string, start: string, end: string, comment: string | null) {
  return `🌙 Завтра смена: ${typeName}, ${start}–${end}` + (comment ? `\n💬 ${comment}` : "");
}

function shiftBeforeMessage(typeName: string, start: string, end: string, startMs: number, nowMs: number) {
  return `⏰ Скоро смена: ${typeName}, ${start}–${end} (через ${human(Math.max(0, startMs - nowMs))})`;
}
// END-PURE

// ───────── Telegram ─────────
type SendResult = "ok" | "blocked" | "retry" | "fail";

async function sendMessage(chatId: number, text: string, errors: string[]): Promise<SendResult> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    if (res.ok) return "ok";
    const body = await res.json().catch(() => ({}));
    const desc = String(body?.description ?? res.status);
    if (res.status === 429) return "retry";
    if (res.status === 403 || /chat not found|user is deactivated/i.test(desc)) return "blocked";
    errors.push(`telegram ${res.status}: ${desc}`.slice(0, 300));
    return "fail";
  } catch (e) {
    errors.push(`telegram fetch: ${String((e as Error)?.message ?? e)}`.slice(0, 300));
    return "fail";
  }
}

// ───────── основной проход ─────────
type U = {
  id: string; tg_id: number; timezone: string; quiet_on: boolean; quiet_from: string; quiet_to: string;
  quiet_strict_shifts: boolean; paused_until: string | null;
};
type S = {
  shift_evening_on: boolean; shift_evening_time: string; shift_before_on: boolean; shift_before_hours: number;
};
type Planned = {
  userId: string; chatId: number; text: string;
  claim: () => Promise<boolean>; release: () => Promise<void>;
};

async function planUser(u: U, s: S, nowMs: number, inShift: boolean): Promise<Planned[]> {
  const tz = u.timezone;
  const nowIso = new Date(nowMs).toISOString();
  const local = localParts(nowMs, tz);
  const planned: Planned[] = [];

  // ── напоминания: в тихие часы (и, если включено, во время смены) ждут, потом уходят
  const holdReminders = inQuiet(u.quiet_on, u.quiet_from, u.quiet_to, local.time) ||
    (u.quiet_strict_shifts && inShift);
  if (!holdReminders) {
    const { data: rem, error } = await db.from("reminders")
      .select("id, text, remind_at, advance_minutes, repeat, repeat_until, done_at, sent_at")
      .eq("user_id", u.id)
      .lte("remind_at", new Date(nowMs + 8 * DAY_MS).toISOString())
      .or(`repeat.neq.none,and(done_at.is.null,sent_at.is.null,remind_at.gte.${new Date(nowMs - MAX_LATE_MS - 7 * DAY_MS).toISOString()})`);
    if (error) throw new Error(error.message);
    for (const r of (rem ?? []) as ReminderRow[]) {
      if (r.repeat !== "none" && r.repeat_until && r.repeat_until < local.date) continue;
      for (const o of dueOccurrences(r, tz, nowMs)) {
        const text = reminderMessage(r.text, o.date, localParts(o.eventMs, tz).time, o.eventMs, nowMs, local.date);
        if (r.repeat === "none") {
          planned.push({
            userId: u.id, chatId: u.tg_id, text,
            claim: async () => {
              const { data } = await db.from("reminders").update({ sent_at: nowIso })
                .eq("id", r.id).is("sent_at", null).is("done_at", null).select("id");
              return (data?.length ?? 0) === 1;
            },
            release: async () => { await db.from("reminders").update({ sent_at: null }).eq("id", r.id); },
          });
        } else {
          const ref = `${r.id}:${o.date}`;
          planned.push({
            userId: u.id, chatId: u.tg_id, text,
            claim: async () => {
              const { error: e } = await db.from("sent_log").insert({ user_id: u.id, kind: "reminder", ref_id: ref });
              return !e; // дубликат (23505) значит, что это срабатывание уже отправлено
            },
            release: async () => { await db.from("sent_log").delete().eq("kind", "reminder").eq("ref_id", ref); },
          });
        }
      }
    }
  }

  // ── сообщения о сменах: тихие часы их не задерживают (иначе ранняя смена останется без предупреждения)
  if (s.shift_evening_on || s.shift_before_on) {
    const { data: shifts, error } = await db.from("shifts")
      .select("id, shift_date, type_name, start_at, end_at, comment, evening_sent_at, before_sent_at")
      .eq("user_id", u.id)
      .gte("start_at", new Date(nowMs - MIN_MS).toISOString())
      .lte("start_at", new Date(nowMs + 2 * DAY_MS).toISOString());
    if (error) throw new Error(error.message);
    const tomorrow = addDays(local.date, 1);
    for (const sh of shifts ?? []) {
      const startMs = Date.parse(sh.start_at);
      const start = localParts(startMs, tz).time;
      const end = localParts(Date.parse(sh.end_at), tz).time;
      const mk = (col: "evening_sent_at" | "before_sent_at", text: string): Planned => ({
        userId: u.id, chatId: u.tg_id, text,
        claim: async () => {
          const { data } = await db.from("shifts").update({ [col]: nowIso }).eq("id", sh.id).is(col, null).select("id");
          return (data?.length ?? 0) === 1;
        },
        release: async () => { await db.from("shifts").update({ [col]: null }).eq("id", sh.id); },
      });
      if (s.shift_evening_on && !sh.evening_sent_at && sh.shift_date === tomorrow &&
          local.time >= hhmm(s.shift_evening_time)) {
        planned.push(mk("evening_sent_at", shiftEveningMessage(sh.type_name, start, end, sh.comment)));
      }
      if (s.shift_before_on && !sh.before_sent_at && startMs > nowMs &&
          nowMs >= startMs - s.shift_before_hours * 3600000) {
        planned.push(mk("before_sent_at", shiftBeforeMessage(sh.type_name, start, end, startMs, nowMs)));
      }
    }
  }
  return planned;
}

async function logError(message: string) {
  await db.from("error_log").insert({ source: "tick", message: message.slice(0, 500) });
}

Deno.serve(async (req) => {
  const headers = { "content-type": "application/json; charset=utf-8" };
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
  if (req.method !== "POST") return reply({ error: "Только POST" }, 405);

  const secret = req.headers.get("x-cron-secret") ?? "";
  const { data: ok } = secret ? await db.rpc("tick_secret_ok", { p: secret }) : { data: false };
  if (ok !== true) return reply({ error: "Нет доступа" }, 401);

  const body = await req.json().catch(() => ({}));
  const dry = body?.dry === true;
  const nowMs = Date.now();
  const errors: string[] = [];

  try {
    if (!BOT_TOKEN) throw new Error("BOT_TOKEN не задан");

    if (dry) {
      // проверка токена без отправки сообщений
      const me = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`).then((r) => r.json()).catch(() => null);
      errors.push(me?.ok ? `bot: @${me.result.username}` : "bot: токен не принят Telegram");
    }

    const { data: users, error: ue } = await db.from("users")
      .select("id, tg_id, timezone, quiet_on, quiet_from, quiet_to, quiet_strict_shifts, paused_until, bot_blocked")
      .eq("bot_blocked", false);
    if (ue) throw new Error(ue.message);
    const { data: settings, error: se } = await db.from("user_settings")
      .select("user_id, shift_evening_on, shift_evening_time, shift_before_on, shift_before_hours");
    if (se) throw new Error(se.message);
    const { data: active } = await db.from("shifts").select("user_id")
      .lte("start_at", new Date(nowMs).toISOString()).gt("end_at", new Date(nowMs).toISOString());
    const onShift = new Set((active ?? []).map((x) => x.user_id));
    const byUser = new Map((settings ?? []).map((x) => [x.user_id, x as S & { user_id: string }]));

    let sent = 0, skipped = 0;
    const preview: string[] = [];

    outer:
    for (const u of (users ?? []) as U[]) {
      if (u.paused_until && Date.parse(u.paused_until) > nowMs) continue;
      const s = byUser.get(u.id);
      if (!s) continue;
      let planned: Planned[];
      try {
        planned = await planUser(u, s, nowMs, onShift.has(u.id));
      } catch (e) {
        errors.push(`plan: ${String((e as Error)?.message ?? e)}`);
        continue;
      }
      for (const p of planned) {
        if (dry) { preview.push(p.text); continue; }
        if (!(await p.claim())) { skipped++; continue; }
        const r = await sendMessage(p.chatId, p.text, errors);
        if (r === "ok") { sent++; continue; }
        await p.release(); // не отправилось: попробуем на следующем проходе
        if (r === "blocked") {
          await db.from("users").update({ bot_blocked: true }).eq("id", u.id);
          break; // остальные сообщения этому пользователю не отправить
        }
        if (r === "retry") break outer; // Telegram просит притормозить
      }
    }

    // ошибки сохраняем в журнал (без текста сообщений и личных данных)
    if (!dry) for (const m of errors) await logError(m);
    return reply({ ok: true, dry, sent, skipped, preview, notes: dry ? errors : undefined });
  } catch (e) {
    await logError(`tick: ${String((e as Error)?.message ?? e)}`);
    return reply({ error: "Внутренняя ошибка" }, 500);
  }
});
