/* Вкладка «Цикл»: календарь с месячными, прогнозом и плодородным окном, отметки «начались» и «закончились»,
   заметки по дням и история циклов. Расчёт ведёт сервер (cycle.get), здесь только показ и ввод.
   Общие функции берутся из app.js (window.App) и shifts.js (App.ui: шторки и поля форм). */
(function () {
  "use strict";

  var App = window.App;
  if (!App || !App.ui) {
    var stub = document.getElementById("cycleBody");
    if (stub) stub.textContent = "Версия приложения устарела. Закрой его и открой заново из бота.";
    return;
  }
  var el = App.el, clear = App.clear, api = App.api, toast = App.toast, haptic = App.haptic, state = App.state, ui = App.ui;

  var MONTHS = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
  var MONTHS_GEN = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
  var DAYS_LONG = ["Воскресенье","Понедельник","Вторник","Среда","Четверг","Пятница","Суббота"];
  var WD_MON = ["Пн","Вт","Ср","Чт","Пт","Сб","Вс"];
  var FEELING = [["good", "Хорошо"], ["ok", "Нормально"], ["bad", "Плохо"]];
  var PAIN = [["none", "Нет"], ["light", "Слабая"], ["strong", "Сильная"]];
  var FLOW = [["light", "Скудные"], ["medium", "Средние"], ["heavy", "Обильные"]];
  var MOODS = [["calm", "Спокойно"], ["happy", "Радостно"], ["energetic", "Бодро"], ["tired", "Усталость"],
    ["irritable", "Раздражение"], ["anxious", "Тревога"], ["sad", "Грусть"]];

  var now0 = new Date();
  var C = { y: now0.getFullYear(), m: now0.getMonth(), data: null, err: null, req: 0, at: 0 };

  /* ───────── даты ───────── */
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function fmt(y, m, d) { return y + "-" + pad(m + 1) + "-" + pad(d); }
  function fmtDate(dt) { return fmt(dt.getFullYear(), dt.getMonth(), dt.getDate()); }
  function parse(s) { var p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function dn(s) { var p = s.split("-"); return Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000; }
  function diff(a, b) { return Math.round(dn(b) - dn(a)); }
  function add(s, n) { var p = s.split("-"); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n)).toISOString().slice(0, 10); }
  function dm(s) { var p = s.split("-"); return p[2] + "." + p[1]; }
  function longDate(s) { var d = parse(s); return DAYS_LONG[d.getDay()] + ", " + d.getDate() + " " + MONTHS_GEN[d.getMonth()]; }
  function plDays(n) {
    var a = n % 10, b = n % 100;
    if (a === 1 && b !== 11) return n + " день";
    if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return n + " дня";
    return n + " дней";
  }
  function labelOf(list, key) { for (var i = 0; i < list.length; i++) if (list[i][0] === key) return list[i][1]; return ""; }

  /* ───────── загрузка ───────── */
  function gridRange() {
    var ws = state.me.user.week_start === 0 ? 0 : 1;
    var first = new Date(C.y, C.m, 1);
    var off = (first.getDay() - ws + 7) % 7;
    var dim = new Date(C.y, C.m + 1, 0).getDate();
    var weeks = Math.ceil((off + dim) / 7);
    return {
      ws: ws, off: off, total: weeks * 7,
      from: fmtDate(new Date(C.y, C.m, 1 - off)),
      to: fmtDate(new Date(C.y, C.m, 1 - off + weeks * 7 - 1)),
    };
  }

  function load() {
    var g = gridRange(), id = ++C.req;
    C.err = null;
    return api("cycle.get", { from: g.from, to: g.to }).then(function (d) {
      if (id !== C.req) return;
      var notes = {};
      d.notes.forEach(function (n) { notes[n.note_date] = n; });
      d.noteBy = notes;
      C.data = d; C.at = Date.now();
      render();
    }).catch(function (e) {
      if (id !== C.req) return;
      C.err = e.message;
      if (C.data) toast(e.message); else render();
    });
  }

  /* ───────── что за день ───────── */
  function lastCycle(d) { return d.cycles.length ? d.cycles[d.cycles.length - 1] : null; }

  // месячные, которые уже отмечены (в том числе идущие сейчас)
  function periodAt(d, date) {
    var last = lastCycle(d);
    for (var i = 0; i < d.cycles.length; i++) {
      var c = d.cycles[i], end = c.end_date;
      if (!end) {
        if (last && c.id === last.id && d.pred.ongoing) { var cap = add(c.start_date, 9); end = d.today < cap ? d.today : cap; }
        else end = add(c.start_date, d.pred.avg.period - 1);
      }
      if (c.start_date <= date && date <= end) return c;
    }
    return null;
  }

  function cycleOn(d, date) {
    var found = null;
    d.cycles.forEach(function (c) { if (c.start_date <= date) found = c; });
    return found;
  }

  // прогноз: только на сегодня и дальше
  function forecastAt(d, date) {
    var r = { pper: false, fert: false, ovul: false };
    if (date < d.today) return r;
    d.pred.forecast.forEach(function (f) {
      if (f.start <= date && date <= f.period_end) r.pper = true;
      if (f.fertile_from <= date && date <= f.fertile_to) r.fert = true;
      if (f.ovulation === date) r.ovul = true;
    });
    return r;
  }

  /* ───────── экран ───────── */
  function render() {
    try { draw(); } catch (e) {
      var r = clear(App.$("cycleBody"));
      r.appendChild(el("div", { class: "empty" }, [el("b", { text: "Ошибка экрана" }), el("span", { text: String(e && e.message || e) })]));
    }
  }

  function btn(text, cls, fn) { return el("button", { type: "button", class: "btn " + cls, text: text, onclick: fn }); }

  function draw() {
    var root = clear(App.$("cycleBody"));
    if (!C.data) {
      if (C.err) {
        root.appendChild(el("div", { class: "empty" }, [
          el("b", { text: "Не получилось загрузить" }), el("span", { text: C.err }),
          el("button", { type: "button", class: "btn", style: "margin-top:10px", text: "Повторить", onclick: function () { C.err = null; render(); load(); } }),
        ]));
      } else {
        root.appendChild(el("div", { class: "empty" }, [el("span", { text: "Загрузка..." })]));
      }
      return;
    }
    var wrap = el("div", { style: "display:flex;flex-direction:column;gap:14px" });
    wrap.appendChild(statusCard());
    wrap.appendChild(calendar());
    wrap.appendChild(history());
    wrap.appendChild(el("div", { class: "sub", style: "padding:0 4px",
      text: "Прогноз приблизительный: он считается по отмеченным циклам и не заменяет врача." }));
    root.appendChild(wrap);
  }

  /* ───────── верхняя карточка ───────── */
  function statusCard() {
    var d = C.data, p = d.pred, last = lastCycle(d);
    var title, lines = [], acts = [];

    var startNow = btn("Начались сегодня", "", function () {
      ui.run(startNow, function () { return api("cycle.start", { date: d.today }); }, load);
    });
    var startEarlier = btn("Начались раньше", "soft", function () { dateForm("Когда начались месячные", d.today, null, d.today, function (v) {
      return api("cycle.start", { date: v });
    }); });

    if (!last) {
      title = "Пока нет отметок";
      lines.push("Отметь первый день месячных, и приложение начнёт считать прогноз.");
      acts.push(startNow, startEarlier);
    } else if (p.phase === "period") {
      title = "Месячные, день " + p.day;
      if (p.forecast.length) lines.push("Следующие ожидаются около " + dm(p.forecast[0].start));
      if (!last.end_date) {
        var endNow = btn("Закончились сегодня", "", function () {
          ui.run(endNow, function () { return api("cycle.end", { id: last.id, date: d.today }); }, load);
        });
        var endEarlier = btn("Закончились раньше", "soft", function () { dateForm("Последний день месячных", d.today, last.start_date, d.today, function (v) {
          return api("cycle.end", { id: last.id, date: v });
        }); });
        acts.push(endNow, endEarlier);
      }
    } else if (p.phase === "delay") {
      title = "Задержка: " + plDays(p.delay_days);
      lines.push("Ожидались " + dm(p.forecast[0].start));
      acts.push(startNow, startEarlier);
    } else {
      title = "День " + p.day + " цикла";
      var next = p.forecast[0], left = diff(d.today, next.start);
      lines.push("Следующие месячные около " + dm(next.start) + " (через " + plDays(left) + ")");
      if (next.ovulation >= d.today) lines.push("Овуляция около " + dm(next.ovulation));
      else if (p.phase === "ovulation") lines.push("Сегодня ожидаемая овуляция");
      acts.push(startNow, startEarlier);
    }

    if (last) {
      var basis = p.avg.samples ? "по " + p.avg.samples + " " + (p.avg.samples === 1 ? "циклу" : "циклам") : "по обычным значениям";
      lines.push("Средний цикл " + plDays(p.avg.len) + ", месячные " + plDays(p.avg.period) + " (" + basis + ")");
    }

    return el("div", { class: "card cyc-st", style: "display:flex;flex-direction:column;gap:8px" }, [
      el("div", { class: "big", text: title }),
    ].concat(lines.map(function (t) { return el("div", { class: "sub", text: t }); }))
     .concat([el("div", { class: "btns", style: "flex-wrap:wrap" }, acts)]));
  }

  /* ───────── календарь ───────── */
  function shiftMonth(delta) {
    var dt = new Date(C.y, C.m + delta, 1);
    C.y = dt.getFullYear(); C.m = dt.getMonth();
    haptic("light");
    render(); load();
  }

  function calendar() {
    var d = C.data, g = gridRange();
    var wrap = el("div", { style: "display:flex;flex-direction:column;gap:10px" });

    wrap.appendChild(el("div", { class: "cal-nav" }, [
      el("button", { type: "button", class: "icon-btn", text: "‹", "aria-label": "Прошлый месяц", onclick: function () { shiftMonth(-1); } }),
      el("div", { class: "cal-title", text: MONTHS[C.m] + " " + C.y }),
      el("button", { type: "button", class: "icon-btn", text: "›", "aria-label": "Следующий месяц", onclick: function () { shiftMonth(1); } }),
    ]));

    var wd = el("div", { class: "cal-wd" });
    for (var i = 0; i < 7; i++) wd.appendChild(el("span", { text: WD_MON[(g.ws === 0 ? i + 6 : i) % 7] }));

    var grid = el("div", { class: "cal-grid" });
    for (var k = 0; k < g.total; k++) {
      (function (date) {
        var dt = parse(date);
        var f = forecastAt(d, date);
        var cls = "day";
        if (dt.getMonth() !== C.m) cls += " out";
        if (date === d.today) cls += " today";
        if (periodAt(d, date)) cls += " cper";
        else if (f.pper) cls += " pper";
        else if (f.fert) cls += " fert";
        if (f.ovul) cls += " ovul";
        var kids = [el("span", { class: "dn", text: String(dt.getDate()) })];
        if (d.noteBy[date]) kids.push(el("span", { class: "dot" }));
        grid.appendChild(el("button", { type: "button", class: cls, "aria-label": longDate(date), onclick: function () { haptic("light"); showDay(date); } }, kids));
      })(fmtDate(new Date(C.y, C.m, 1 - g.off + k)));
    }

    wrap.appendChild(el("div", { class: "cal cyc" }, [wd, grid]));
    wrap.appendChild(el("div", { class: "lgd" }, [
      el("span", {}, [el("i", { class: "sw cper" }), "Месячные"]),
      el("span", {}, [el("i", { class: "sw pper" }), "Ожидаются"]),
      el("span", {}, [el("i", { class: "sw fert" }), "Плодородное окно"]),
      el("span", {}, [el("i", { class: "sw ovul" }), "Овуляция"]),
    ]));
    return wrap;
  }

  /* ───────── история ───────── */
  function history() {
    var d = C.data;
    var card = el("div", { class: "card tlist" }, [el("h3", { text: "История", style: "margin-top:8px" })]);
    if (!d.cycles.length) {
      card.appendChild(el("div", { class: "sub", style: "padding:6px 0 10px", text: "Здесь появятся отмеченные месячные." }));
      return card;
    }
    var list = d.cycles.slice().reverse().slice(0, 8);
    list.forEach(function (c) {
      var idx = d.cycles.indexOf(c);
      var prev = idx > 0 ? d.cycles[idx - 1] : null;
      var span = c.end_date ? dm(c.start_date) + " – " + dm(c.end_date) + " · " + plDays(diff(c.start_date, c.end_date) + 1) : dm(c.start_date) + " · не закончились";
      var cl = prev ? "Цикл " + plDays(diff(prev.start_date, c.start_date)) : "Первая отметка";
      card.appendChild(el("button", { type: "button", class: "trow hist", onclick: function () { cycleForm(c); } }, [
        el("div", { class: "htext" }, [el("span", { class: "ttl", text: span }), el("span", { class: "sub", text: cl })]),
        el("span", { class: "sub", text: "›" }),
      ]));
    });
    return card;
  }

  /* ───────── окно дня ───────── */
  function showDay(date) {
    var d = C.data;
    if (!d) return toast("Календарь ещё загружается");
    var back = function () { showDay(date); };
    ui.show(function (p) {
      p.appendChild(ui.head(longDate(date)));

      var c = periodAt(d, date), f = forecastAt(d, date), cy = cycleOn(d, date);
      var info = [];
      if (c) info.push("Месячные");
      if (cy && diff(cy.start_date, date) < 60) info.push("День " + (diff(cy.start_date, date) + 1) + " цикла");
      if (f.pper) info.push("Ожидаются месячные");
      if (f.ovul) info.push("Ожидаемая овуляция");
      else if (f.fert) info.push("Ожидаемое плодородное окно");
      if (!info.length) info.push("Особых отметок нет");
      p.appendChild(el("div", { class: "sub", text: info.join(" · ") }));

      var n = d.noteBy[date];
      if (n) {
        var bits = [];
        if (n.feeling) bits.push("Самочувствие: " + labelOf(FEELING, n.feeling).toLowerCase());
        if (n.pain) bits.push("Боль: " + labelOf(PAIN, n.pain).toLowerCase());
        if (n.flow) bits.push("Выделения: " + labelOf(FLOW, n.flow).toLowerCase());
        if (n.mood && n.mood.length) bits.push("Настроение: " + n.mood.map(function (m) { return labelOf(MOODS, m).toLowerCase(); }).join(", "));
        var box = el("div", { class: "item" }, bits.map(function (t) { return el("div", { text: t }); }));
        if (n.body) box.appendChild(el("div", { class: "sub", text: n.body }));
        p.appendChild(box);
      }

      var past = date <= d.today;
      var acts = el("div", { style: "display:flex;flex-direction:column;gap:8px" });
      if (past) acts.appendChild(btn(n ? "Изменить заметку" : "Добавить заметку", "soft", function () { noteForm(date, n, back); }));
      if (past && !c) {
        var st = btn("Месячные начались в этот день", "", function () {
          ui.run(st, function () { return api("cycle.start", { date: date }); }, function () { ui.closeSheet(); return load(); });
        });
        acts.appendChild(st);
      }
      if (c && date <= d.today && c.end_date !== date) {
        var en = btn("Месячные закончились в этот день", "soft", function () {
          ui.run(en, function () { return api("cycle.end", { id: c.id, date: date }); }, function () { ui.closeSheet(); return load(); });
        });
        acts.appendChild(en);
      }
      if (c) acts.appendChild(btn("Изменить даты этих месячных", "soft", function () { cycleForm(c, back); }));
      p.appendChild(acts);
    });
  }

  /* ───────── формы ───────── */
  // одна дата: когда начались, когда закончились
  function dateForm(title, value, min, max, call) {
    var inp = el("input", { type: "date", class: "inp", value: value });
    if (max) inp.setAttribute("max", max);
    if (min) inp.setAttribute("min", min);
    var save = btn("Сохранить", "", function () {
      if (!inp.value) return toast("Выбери дату");
      ui.run(save, function () { return call(inp.value); }, function () { ui.closeSheet(); return load(); });
    });
    ui.show(function (p) {
      p.appendChild(ui.head(title));
      p.appendChild(ui.field("Дата", inp));
      p.appendChild(ui.formButtons(save));
    });
  }

  function cycleForm(c, back) {
    var d = C.data;
    var startI = el("input", { type: "date", class: "inp", value: c.start_date, max: d.today });
    var endI = el("input", { type: "date", class: "inp", value: c.end_date || "", max: d.today });
    var save = btn("Сохранить", "", function () {
      if (!startI.value) return toast("Укажи первый день");
      ui.run(save, function () {
        return api("cycle.edit", { id: c.id, start_date: startI.value, end_date: endI.value || null });
      }, function () { ui.closeSheet(); return load(); });
    });
    var del = btn("Удалить", "danger", function () {
      App.confirm("Удалить эти месячные из истории?", function () {
        ui.run(del, function () { return api("cycle.delete", { id: c.id }); }, function () { ui.closeSheet(); return load(); });
      });
    });
    ui.show(function (p) {
      p.appendChild(ui.head("Месячные", back));
      p.appendChild(el("div", { class: "two" }, [ui.field("Первый день", startI), ui.field("Последний день", endI)]));
      p.appendChild(el("div", { class: "sub", text: "Последний день можно оставить пустым, пока месячные идут." }));
      p.appendChild(ui.formButtons(save, back || ui.closeSheet));
      p.appendChild(del);
    });
  }

  // одиночный выбор с возможностью снять выбор повторным нажатием
  function pickRow(items, get, set) {
    return ui.chipRow(items, get, function (k) { set(get() === k ? null : k); });
  }

  function noteForm(date, ex, back) {
    var feeling = ex ? ex.feeling : null, pain = ex ? ex.pain : null, flow = ex ? ex.flow : null;
    var mood = ex && ex.mood ? ex.mood.slice() : [];
    var ta = el("textarea", { class: "inp", rows: "3", maxlength: "500", placeholder: "Если хочется что-то записать" });
    ta.value = ex && ex.body ? ex.body : "";

    var moodRow = el("div", { class: "chips" });
    function drawMood() {
      clear(moodRow);
      MOODS.forEach(function (m) {
        moodRow.appendChild(el("button", { type: "button", class: "chip" + (mood.indexOf(m[0]) > -1 ? " on" : ""), text: m[1],
          onclick: function () {
            var i = mood.indexOf(m[0]);
            if (i > -1) mood.splice(i, 1); else mood.push(m[0]);
            drawMood();
          } }));
      });
    }
    drawMood();

    function finish() { ui.closeSheet(); return load(); }
    var save = btn("Сохранить", "", function () {
      ui.run(save, function () {
        return api("cycle.note", { date: date, feeling: feeling, pain: pain, flow: flow, mood: mood, body: ta.value });
      }, finish);
    });

    ui.show(function (p) {
      p.appendChild(ui.head("Заметка · " + dm(date), back));
      p.appendChild(ui.field("Самочувствие", pickRow(FEELING, function () { return feeling; }, function (v) { feeling = v; })));
      p.appendChild(ui.field("Боль", pickRow(PAIN, function () { return pain; }, function (v) { pain = v; })));
      p.appendChild(ui.field("Выделения", pickRow(FLOW, function () { return flow; }, function (v) { flow = v; })));
      p.appendChild(ui.field("Настроение", moodRow));
      p.appendChild(ui.field("Заметка", ta));
      p.appendChild(ui.formButtons(save, back || ui.closeSheet));
    });
  }

  /* ───────── запуск ───────── */
  // при каждом заходе на вкладку подтягиваем свежее
  App.onTab(function (tab) { if (tab === "cycle" && state.me) load(); });

  // дата могла смениться, пока приложение лежало свёрнутым
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && state.me && C.data && state.tab === "cycle" && Date.now() - C.at > 60000) load();
  });

  App.onReady(function () {
    C.data = null; C.err = null;
    render();
    // данные цикла грузим при первом открытии вкладки, чтобы не тратить запрос на старте
    if (state.tab === "cycle") load();
  });
})();
