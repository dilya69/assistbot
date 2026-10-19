/* Вкладка «Настройки».
   Своё у каждого из двоих: имя, значок и тема оформления.
   Общее (данные принадлежат владельцу): напоминания о сменах, тихие часы, пауза, часовой пояс,
   начало недели и обычные значения для цикла.
   Кнопок удаления данных здесь нет: старые записи чистит база по расписанию. */
(function () {
  "use strict";

  var App = window.App;
  if (!App) return;
  var el = App.el, clear = App.clear, api = App.api, toast = App.toast;

  var THEMES = [
    ["auto", "Как в Telegram", ["#F5F3F8", "#17151C"]],
    ["light", "Светлая", ["#F5F3F8", "#26232F"]],
    ["dark", "Тёмная", ["#17151C", "#F0EDF5"]],
    ["thrones", "Престол", ["#15110E", "#C8A24E"]],
    ["dead", "Ходячие", ["#191B17", "#B1332B"]],
  ];
  var AVATARS = ["🌿", "🌸", "🦊", "🐱", "🌙", "☀️", "⭐", "🍓", "🦋", "🎧", "☕", "🔥"];
  var ZONES = [
    ["Europe/Kaliningrad", "Калининград"], ["Europe/Moscow", "Москва"], ["Europe/Samara", "Самара"],
    ["Asia/Yekaterinburg", "Екатеринбург"], ["Asia/Omsk", "Омск"], ["Asia/Krasnoyarsk", "Красноярск"],
    ["Asia/Irkutsk", "Иркутск"], ["Asia/Yakutsk", "Якутск"], ["Asia/Vladivostok", "Владивосток"],
    ["Asia/Magadan", "Магадан"], ["Asia/Kamchatka", "Камчатка"], ["Europe/Minsk", "Минск"],
    ["Asia/Almaty", "Алматы"], ["Asia/Tbilisi", "Тбилиси"], ["Asia/Yerevan", "Ереван"],
    ["Asia/Baku", "Баку"], ["Europe/Istanbul", "Стамбул"], ["UTC", "UTC"],
  ];
  var PAUSES = [[1, "На сутки"], [3, "На 3 дня"], [7, "На неделю"]];

  function view() { return App.$("view-settings"); }
  function hhmm(t) { return t ? String(t).slice(0, 5) : ""; }

  /* ───────── сохранение ───────── */
  function save(patch) {
    var box = view(), top = box ? box.scrollTop : 0;
    return api("settings.update", patch).then(function (me) {
      App.state.me = me;
      App.applyTheme(me.settings.theme);
      App.renderBanner();
      render();
      if (box) box.scrollTop = top;
      App.haptic("light");
    }).catch(function (e) {
      toast(e.message);
      render(); // вернуть на экран то, что реально сохранено
      if (box) box.scrollTop = top;
    });
  }

  /* ───────── элементы ───────── */
  function toggle(on, onChange) {
    return el("button", {
      type: "button", class: "tgl" + (on ? " on" : ""), role: "switch", "aria-checked": on ? "true" : "false",
      onclick: function () { onChange(!on); },
    }, [el("span", { class: "knob" })]);
  }

  function row(title, sub, control) {
    return el("div", { class: "row srow" }, [
      el("div", { class: "grow" }, [el("div", { text: title }), sub ? el("div", { class: "sub", text: sub }) : null]),
      control,
    ]);
  }

  function select(options, value, onChange) {
    var s = el("select", { class: "inp compact" }, options.map(function (o) {
      return el("option", { value: String(o[0]), text: o[1] });
    }));
    s.value = String(value);
    s.addEventListener("change", function () { onChange(s.value); });
    return s;
  }

  function timeInput(value, onChange) {
    var i = el("input", { type: "time", class: "inp compact", value: hhmm(value) });
    i.addEventListener("change", function () { if (i.value) onChange(i.value); });
    return i;
  }

  function nums(from, to, label) {
    var out = [];
    for (var n = from; n <= to; n++) out.push([n, label(n)]);
    return out;
  }
  function plDays(n) {
    var a = n % 10, b = n % 100;
    if (a === 1 && b !== 11) return n + " день";
    if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return n + " дня";
    return n + " дней";
  }

  function card(title, kids) {
    return el("div", { class: "card" }, [el("h3", { text: title })].concat(kids));
  }

  /* ───────── блоки ───────── */
  function profileCard(me) {
    var p = me.profile;
    var name = el("input", { type: "text", class: "inp", maxlength: "30", placeholder: p.first_name || "Имя", value: p.display_name || "" });
    name.addEventListener("change", function () { save({ display_name: name.value.trim() || null }); });

    var avatars = el("div", { class: "chips" }, [
      el("button", { type: "button", class: "chip" + (p.avatar ? "" : " on"), text: "Без значка", onclick: function () { save({ avatar: null }); } }),
    ].concat(AVATARS.map(function (a) {
      return el("button", { type: "button", class: "chip" + (p.avatar === a ? " on" : ""), text: a, onclick: function () { save({ avatar: a }); } });
    })));

    return card("Профиль", [
      el("div", { class: "fld" }, [el("span", { class: "lbl", text: "Как тебя называть" }), name]),
      el("div", { class: "fld", style: "margin-top:12px" }, [el("span", { class: "lbl", text: "Значок" }), avatars]),
      el("div", { class: "sub", style: "margin-top:10px", text: "Имечко, значок" }),
    ]);
  }

  function themeCard(me) {
    var cur = me.settings.theme || "auto";
    var chips = el("div", { class: "chips" }, THEMES.map(function (t) {
      return el("button", {
        type: "button", class: "chip" + (cur === t[0] ? " on" : ""),
        onclick: function () { App.applyTheme(t[0]); save({ theme: t[0] }); },
      }, [
        el("span", { class: "tsw", style: "background:linear-gradient(135deg," + t[2][0] + " 50%," + t[2][1] + " 50%)" }),
        t[1],
      ]);
    }));
    return card("Оформление", [chips, el("div", { class: "sub", style: "margin-top:10px", text: "Темы там всякие" })]);
  }

  function shiftCard(s) {
    var kids = [
      row("Вечером накануне", "Сообщение о завтрашней смене", toggle(s.shift_evening_on, function (v) { save({ shift_evening_on: v }); })),
    ];
    if (s.shift_evening_on) {
      kids.push(row("Во сколько", null, timeInput(s.shift_evening_time, function (v) { save({ shift_evening_time: v }); })));
    }
    kids.push(row("Перед сменой", "Напомнить заранее", toggle(s.shift_before_on, function (v) { save({ shift_before_on: v }); })));
    if (s.shift_before_on) {
      kids.push(row("За сколько часов", null, select(nums(1, 12, function (n) { return "за " + n + " ч"; }), s.shift_before_hours,
        function (v) { save({ shift_before_hours: +v }); })));
    }
    return card("Напоминания о сменах", kids);
  }

  function quietCard(u) {
    var kids = [
      row("Тихие часы", "В это время бот не пишет, сообщения придут после", toggle(u.quiet_on, function (v) { save({ quiet_on: v }); })),
    ];
    if (u.quiet_on) {
      kids.push(row("С", null, timeInput(u.quiet_from, function (v) { save({ quiet_from: v }); })));
      kids.push(row("До", null, timeInput(u.quiet_to, function (v) { save({ quiet_to: v }); })));
    }
    kids.push(row("Не беспокоить в часы смены", "Напоминания придут после её конца",
      toggle(u.quiet_strict_shifts, function (v) { save({ quiet_strict_shifts: v }); })));

    // пауза всего бота
    var until = u.paused_until ? new Date(u.paused_until) : null;
    var active = until && until.getTime() > Date.now();
    var pause = el("div", { class: "fld", style: "margin-top:12px" }, [
      el("span", { class: "lbl", text: active ? "Бот на паузе до " + until.toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) : "Пауза бота" }),
      el("div", { class: "chips" }, PAUSES.map(function (p) {
        return el("button", { type: "button", class: "chip", text: p[1],
          onclick: function () { save({ paused_until: new Date(Date.now() + p[0] * 864e5).toISOString() }); } });
      }).concat(active ? [el("button", { type: "button", class: "chip on", text: "Снять паузу", onclick: function () { save({ paused_until: null }); } })] : [])),
    ]);
    kids.push(pause);
    return card("Тишина", kids);
  }

  function generalCard(u) {
    var zones = ZONES.slice();
    if (!zones.some(function (z) { return z[0] === u.timezone; })) zones.unshift([u.timezone, u.timezone]);
    var ws = el("div", { class: "chips" }, [[1, "С понедельника"], [0, "С воскресенья"]].map(function (w) {
      return el("button", { type: "button", class: "chip" + (u.week_start === w[0] ? " on" : ""), text: w[1], onclick: function () { save({ week_start: w[0] }); } });
    }));
    return card("Общие", [
      row("Часовой пояс", "По нему считаются смены и напоминания", select(zones, u.timezone, function (v) { save({ timezone: v }); })),
      el("div", { class: "fld", style: "margin-top:12px" }, [el("span", { class: "lbl", text: "Неделя в календарях" }), ws]),
    ]);
  }

  function cycleCard(me) {
    var s = me.settings, v = me.viewer;
    if (s.cycle_typical_length === undefined) return null; // вкладка «Цикл» закрыта владельцем
    var kids = [
      row("Обычная длина цикла", "Пока мало данных, прогноз считается по этому", select(nums(20, 45, plDays), s.cycle_typical_length,
        function (x) { save({ cycle_typical_length: +x }); })),
      row("Обычная длина месячных", null, select(nums(1, 12, plDays), s.cycle_typical_period,
        function (x) { save({ cycle_typical_period: +x }); })),
    ];
    if (v.is_self) {
      kids.push(row("Показывать вкладку «Цикл» второму человеку", "Выключишь, и она закроется у него сразу",
        toggle(s.cycle_share_partner, function (x) { save({ cycle_share_partner: x }); })));
    }
    return card("Цикл", kids);
  }

  function membersCard(me) {
    var list = me.members || [];
    if (list.length < 2) return null;
    return card("две котятки", [
      el("div", { class: "chips" }, list.map(function (m) {
        return el("span", { class: "chip" + (m.is_me ? " on" : ""), text: (m.avatar ? m.avatar + " " : "") + (m.name || "Без имени") + (m.is_me ? " (ты)" : "") });
      })),
      el("div", { class: "sub", style: "margin-top:10px", text: "Смены, привычки и напоминания общие: правки видны обоим." }),
    ]);
  }

  function adminCard() {
    var c = card("Состояние бота", []);
    var out = el("div", { class: "sub", text: "Загрузка..." });
    c.appendChild(out);
    api("admin.status").then(function (st) {
      clear(out);
      out.appendChild(el("div", { text: "Последняя отправка: " + (st.last_sent_at ? new Date(st.last_sent_at).toLocaleString("ru-RU") : "ещё не было") }));
      out.appendChild(el("div", { text: "Ошибок в журнале: " + st.errors.length }));
      st.errors.slice(0, 3).forEach(function (e) { out.appendChild(el("div", { text: e.source + ": " + e.message })); });
    }).catch(function (e) { out.textContent = e.message; });
    return c;
  }

  /* ───────── экран ───────── */
  function render() {
    var me = App.state.me;
    if (!me) return;
    var body = clear(App.$("settingsBody"));
    var wrap = el("div", { style: "display:flex;flex-direction:column;gap:14px" });
    [profileCard(me), themeCard(me), shiftCard(me.settings), quietCard(me.user), generalCard(me.user), cycleCard(me), membersCard(me)]
      .forEach(function (c) { if (c) wrap.appendChild(c); });
    // журнал бота нужен тому, кто помогает с настройкой, а не владельцу данных
    if (me.viewer.role === "admin" && !me.viewer.is_self) wrap.appendChild(adminCard());
    body.appendChild(wrap);
  }

  App.renderSettings = render;
  App.onReady(render);
})();
