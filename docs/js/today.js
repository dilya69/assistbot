/* Экран «Сегодня»: привычки, смена (или отпуск/больничный) и напоминания на сегодня.
   Данные берутся теми же запросами, что и во вкладках «Привычки» и «Смены»; новых действий на сервере нет.
   Порядок блоков: привычки, смена, напоминания. Если смены нет, идёт отпуск или больничный
   и есть напоминания, то напоминания выше блока с отпуском. */
(function () {
  "use strict";

  var App = window.App;
  if (!App || !App.ui) {
    var stub = document.getElementById("todayBody");
    if (stub) stub.textContent = "Версия приложения устарела. Закрой его и открой заново из бота.";
    return;
  }
  var el = App.el, clear = App.clear, api = App.api, toast = App.toast, ui = App.ui;

  var T = { data: null, err: null, req: 0, at: 0 };

  function readOnly() { return !!(App.state.me && App.state.me.viewer.read_only); }

  function plDays(n) {
    var a = n % 10, b = n % 100;
    if (a === 1 && b !== 11) return n + " день";
    if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return n + " дня";
    return n + " дней";
  }
  function dm(s) { var p = s.split("-"); return p[2] + "." + p[1]; }
  function shortT(t) { var p = t.split(":"); var h = String(+p[0]); return p[1] === "00" ? h : h + ":" + p[1]; }
  function hours(s, e) { return shortT(s) + "–" + shortT(e); }

  /* ───────── загрузка ───────── */
  function load() {
    var id = ++T.req;
    T.err = null;
    return api("habits.list").then(function (h) {
      return api("shifts.range", { from: h.today, to: h.today }).then(function (s) { return { h: h, s: s }; });
    }).then(function (r) {
      if (id !== T.req) return;
      T.data = r; T.at = Date.now();
      render();
    }).catch(function (e) {
      if (id !== T.req) return;
      T.err = e.message;
      if (T.data) toast(e.message); else render();
    });
  }

  // после отметки обновляем и соседние вкладки, чтобы там не лежали старые данные
  function refreshOthers(what) {
    if (what === "habits" && App.habits) App.habits.reload();
    if (what === "shifts" && App.shifts) App.shifts.reload();
  }

  function render() {
    try { draw(); } catch (e) {
      var r = clear(App.$("todayBody"));
      r.appendChild(el("div", { class: "empty" }, [el("b", { text: "Ошибка экрана" }), el("span", { text: String(e && e.message || e) })]));
    }
  }

  /* ───────── экран ───────── */
  function draw() {
    var root = clear(App.$("todayBody"));
    if (!T.data) {
      if (T.err) {
        root.appendChild(el("div", { class: "empty" }, [
          el("b", { text: "Не получилось загрузить" }), el("span", { text: T.err }),
          el("button", { type: "button", class: "btn", style: "margin-top:10px", text: "Повторить", onclick: function () { T.err = null; render(); load(); } }),
        ]));
      } else {
        root.appendChild(el("div", { class: "empty" }, [el("span", { text: "Загрузка..." })]));
      }
      return;
    }

    var today = T.data.h.today;
    var shift = null;
    T.data.s.shifts.forEach(function (s) { if (s.date === today) shift = s; });
    var absences = T.data.s.absences || [];
    var rems = T.data.s.reminders.filter(function (r) { return r.date === today; });

    var wrap = el("div", { style: "display:flex;flex-direction:column;gap:18px" });
    var habitsSec = habitsBlock();
    var shiftSec = shiftBlock(shift, absences);
    var remSec = rems.length ? remindersBlock(rems) : null;

    wrap.appendChild(habitsSec);
    if (!shift && absences.length && remSec) {
      wrap.appendChild(remSec);
      wrap.appendChild(shiftSec);
    } else {
      wrap.appendChild(shiftSec);
      if (remSec) wrap.appendChild(remSec);
    }
    root.appendChild(wrap);
  }

  function section(title, right, kids) {
    var hd = [el("h3", { text: title })];
    if (right) hd.push(right);
    return el("div", { class: "tsec" }, [el("div", { class: "tsec-hd" }, hd)].concat(kids));
  }

  /* ───────── привычки ───────── */
  function habitsBlock() {
    var ro = readOnly();
    var all = T.data.h.habits;
    // «делать» только в свои дни; «не делать» каждый день
    var list = all.filter(function (h) { return h.week[h.week.length - 1].state !== "off"; });

    var doList = list.filter(function (h) { return h.kind === "do"; });
    var doneN = doList.filter(function (h) { return h.today === "done"; }).length;
    var right = null;
    if (doList.length) {
      var full = doneN === doList.length;
      right = el("span", { class: "cnt" + (full ? " full" : ""), text: full ? "Всё сделано" : doneN + " из " + doList.length });
    }

    if (!all.length) {
      return section("Привычки", null, [el("div", { class: "card" }, [
        el("div", { class: "sub", text: "Привычек пока нет. Добавь первую во вкладке «Привычки»." }),
        ro ? null : el("button", { type: "button", class: "btn soft", style: "margin-top:10px", text: "Перейти к привычкам", onclick: function () { App.go("habits"); } }),
      ])]);
    }
    if (!list.length) {
      return section("Привычки", null, [el("div", { class: "card" }, [el("div", { class: "sub", text: "На сегодня привычек нет" })])]);
    }

    // сначала невыполненные «делать», потом выполненные, внизу «не делать»
    var rank = function (h) { return h.kind === "avoid" ? 2 : (h.today === "done" ? 1 : 0); };
    list.sort(function (a, b) { return rank(a) - rank(b); });

    var card = el("div", { class: "card tlist" });
    list.forEach(function (h) { card.appendChild(habitRow(h, ro)); });
    return section("Привычки", right, [card]);
  }

  function habitRow(h, ro) {
    var isDo = h.kind === "do";
    var lead, sub, trail = null;

    if (isDo) {
      var done = h.today === "done";
      lead = el("button", { type: "button", class: "check" + (done ? " on" : ""), text: done ? "✓" : "",
        "aria-label": (done ? "Снять отметку: " : "Отметить: ") + h.name, "aria-pressed": done ? "true" : "false" });
      if (ro) lead.disabled = true;
      else lead.addEventListener("click", function () { mark(h, done ? null : "done", lead); });
      sub = h.streak ? "Серия " + plDays(h.streak) : "Начни серию";
    } else {
      var slipped = h.today === "slip";
      lead = el("div", { class: "check static " + (slipped ? "bad" : "on"), text: String(h.streak), "aria-label": "Дней без срыва: " + h.streak });
      sub = "Не делать · без срыва " + plDays(h.streak);
      if (!ro) {
        trail = el("button", { type: "button", class: "btn sm " + (slipped ? "soft" : "danger"), text: slipped ? "Отменить срыв" : "Срыв",
          onclick: function () {
            if (slipped) return mark(h, null, trail);
            App.confirm("Отметить срыв за сегодня? Счёт начнётся заново.", function () { mark(h, "slip", trail); });
          } });
      }
    }

    var row = el("div", { class: "trow" + (isDo && h.today === "done" ? " done" : "") }, [
      lead,
      el("div", { class: "htext" }, [el("span", { class: "ttl", text: h.name }), el("span", { class: "sub", text: sub })]),
      trail,
    ]);
    return row;
  }

  function mark(h, status, btn) {
    var before = h.streak;
    var date = T.data.h.today;
    ui.run(btn, function () { return api("habits.mark", { id: h.id, date: date, status: status }); }, function () {
      refreshOthers("habits");
      return load().then(function () {
        var P = App.habits && App.habits.phrases;
        if (!P) return;
        if (status === "slip") return toast(P.slip);
        if (status !== "done") return;
        var now = T.data.h.habits.filter(function (x) { return x.id === h.id; })[0];
        var phrase = now && now.streak > before && P.doMilestone[now.streak];
        if (phrase) toast(phrase);
      });
    });
  }

  /* ───────── смена, отпуск, больничный ───────── */
  function shiftBlock(shift, absences) {
    var kids = [];

    if (shift) {
      var night = shift.end <= shift.start;
      kids.push(el("div", { class: "tblock work" }, [
        el("div", { class: "tt", text: shift.type_name + " · " + hours(shift.start, shift.end) }),
        night ? el("div", { class: "ts", text: "Смена закончится утром" }) : null,
        shift.comment ? el("div", { class: "ts", text: shift.comment }) : null,
      ]));
    }

    absences.forEach(function (a) {
      var sick = a.kind === "sick";
      kids.push(el("div", { class: "tblock " + (sick ? "sick" : "vac") }, [
        el("div", { class: "tt", text: sick ? "Больничный" : "Отпуск" }),
        el("div", { class: "ts", text: dm(a.start_date) + " – " + dm(a.end_date) }),
        a.note ? el("div", { class: "ts", text: a.note }) : null,
      ]));
    });

    if (!kids.length) {
      kids.push(el("div", { class: "card" }, [el("div", { class: "sub", text: "Сегодня без смены" })]));
    }
    return section("Смена", null, kids);
  }

  /* ───────── напоминания ───────── */
  function remindersBlock(rems) {
    var ro = readOnly();
    var card = el("div", { class: "card tlist" });
    rems.forEach(function (r) {
      var act = null;
      if (!ro && r.repeat === "none") {
        act = el("button", { type: "button", class: "btn soft sm", text: r.done ? "Вернуть" : "Готово" });
        act.addEventListener("click", function () {
          ui.run(act, function () { return api("reminders.done", { id: r.id, done: !r.done }); }, function () {
            refreshOthers("shifts");
            return load();
          });
        });
      }
      card.appendChild(el("div", { class: "trow" + (r.done ? " done" : "") }, [
        el("span", { class: "rtime", text: r.time }),
        el("div", { class: "htext" }, [el("span", { class: "ttl", text: r.text })]),
        act,
      ]));
    });
    return section("Напоминания", null, [card]);
  }

  /* ───────── запуск ───────── */
  // при каждом заходе на вкладку подтягиваем свежее (старое остаётся на экране, пока грузится новое)
  App.onTab(function (tab) { if (tab === "today" && App.state.me) load(); });

  // дата могла смениться, пока приложение лежало свёрнутым
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && App.state.me && T.data && App.state.tab === "today" && Date.now() - T.at > 60000) load();
  });

  App.onReady(function () {
    T.data = null; T.err = null;
    render();
    load();
  });
})();
