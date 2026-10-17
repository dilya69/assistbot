/* Вкладка «Привычки»: «делать» (отметка за день, серия подряд) и «не делать» (дни без срыва).
   Общие функции берутся из app.js (window.App) и shifts.js (App.ui: шторки и поля форм). */
(function () {
  "use strict";

  var App = window.App;
  if (!App || !App.ui) {
    // app.js или shifts.js из кэша старые: просим обновить, а не висим на «Загрузке»
    var stub = document.getElementById("habitsBody");
    if (stub) stub.textContent = "Версия приложения устарела. Закрой его и открой заново из бота.";
    return;
  }
  var el = App.el, clear = App.clear, api = App.api, toast = App.toast, ui = App.ui;

  /* Фразы за вехи и после срыва. Тон пока нейтральный: тексты можно спокойно менять здесь.
     Ключ вехи: сколько дней в серии. */
  var PHRASES = {
    doMilestone: {
      3: "Три дня подряд.", 7: "Неделя подряд.", 14: "Две недели подряд.", 21: "Три недели подряд.",
      30: "Месяц подряд.", 60: "Два месяца подряд.", 100: "Сто дней подряд.",
    },
    avoidMilestone: {
      3: "Три дня без срыва.", 7: "Неделя без срыва.", 14: "Две недели без срыва.", 21: "Три недели без срыва.",
      30: "Месяц без срыва.", 60: "Два месяца без срыва.", 100: "Сто дней без срыва.",
    },
    slip: "Отмечено. Счёт начнётся заново.",
  };

  var WD_NAMES = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]; // 1 = понедельник, как в базе
  var WD_JS = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
  var MODES = [["normal", "Как обычно"], ["evening", "Перенести на вечер"], ["silent", "Не напоминать"]];

  var H = { data: null, err: null, req: 0, at: 0 };

  function readOnly() { return !!(App.state.me && App.state.me.viewer.read_only); }

  function plDays(n) {
    var a = n % 10, b = n % 100;
    if (a === 1 && b !== 11) return n + " день";
    if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return n + " дня";
    return n + " дней";
  }
  function dmy(s) { var p = s.split("-"); return p[2] + "." + p[1]; }
  function wdName(s) { var p = s.split("-"); return WD_JS[new Date(+p[0], +p[1] - 1, +p[2]).getDay()]; }

  /* ───────── загрузка ───────── */
  function load() {
    var id = ++H.req;
    H.err = null;
    return api("habits.list").then(function (d) {
      if (id !== H.req) return;
      H.data = d; H.at = Date.now();
      render();
    }).catch(function (e) {
      if (id !== H.req) return;
      H.err = e.message;
      if (H.data) toast(e.message); else render();
    });
  }

  function render() {
    try { draw(); } catch (e) {
      var r = clear(App.$("habitsBody"));
      r.appendChild(el("div", { class: "empty" }, [el("b", { text: "Ошибка экрана привычек" }), el("span", { text: String(e && e.message || e) })]));
    }
  }

  /* ───────── экран ───────── */
  function draw() {
    var root = clear(App.$("habitsBody"));
    if (!H.data) {
      if (H.err) {
        root.appendChild(el("div", { class: "empty" }, [
          el("b", { text: "Не получилось загрузить привычки" }), el("span", { text: H.err }),
          el("button", { type: "button", class: "btn", style: "margin-top:10px", text: "Повторить", onclick: function () { H.err = null; render(); load(); } }),
        ]));
      } else {
        root.appendChild(el("div", { class: "empty" }, [el("span", { text: "Загрузка..." })]));
      }
      return;
    }

    var ro = readOnly();
    var wrap = el("div", { style: "display:flex;flex-direction:column;gap:12px" });
    if (!ro) wrap.appendChild(el("button", { type: "button", class: "btn", text: "Новая привычка", onclick: function () { habitForm(null); } }));

    if (!H.data.habits.length) {
      wrap.appendChild(el("div", { class: "empty" }, [
        el("b", { text: "Пока нет привычек" }),
        el("span", { text: "Добавь первую: что-то делать в выбранные дни или от чего-то воздерживаться." }),
      ]));
    }
    H.data.habits.forEach(function (h) { wrap.appendChild(card(h, ro)); });

    if (!ro && H.data.archived.length) {
      wrap.appendChild(el("button", { type: "button", class: "btn soft", text: "Архив (" + H.data.archived.length + ")", onclick: archiveSheet }));
    }
    root.appendChild(wrap);
  }

  function card(h, ro) {
    var isDo = h.kind === "do";
    var lead;
    if (isDo) {
      var done = h.today === "done";
      lead = el("button", { type: "button", class: "check" + (done ? " on" : ""), text: done ? "✓" : "",
        "aria-label": done ? "Снять отметку за сегодня" : "Отметить за сегодня", "aria-pressed": done ? "true" : "false",
        onclick: function () { mark(h, H.data.today, done ? null : "done"); } });
      if (ro) lead.disabled = true;
    } else {
      lead = el("div", { class: "check static " + (h.today === "slip" ? "bad" : "on"), text: String(h.streak), "aria-label": "Дней без срыва: " + h.streak });
    }

    var sub = isDo
      ? "Серия: " + (h.streak ? plDays(h.streak) : "нет") + " · рекорд " + h.best + (h.total ? " · всего " + h.total : "")
      : "Не делать · без срыва " + plDays(h.streak) + " · рекорд " + h.best;
    var text = el(ro ? "div" : "button", ro ? { class: "htext" } : { type: "button", class: "htext", "aria-label": "Изменить: " + h.name, onclick: function () { habitForm(h); } }, [
      el("span", { class: "ttl", text: h.name }),
      el("span", { class: "sub", text: sub }),
      reminderLine(h),
    ]);

    var rowKids = [lead, text];
    if (!isDo && !ro) {
      var slipped = h.today === "slip";
      rowKids.push(el("button", { type: "button", class: "btn sm " + (slipped ? "soft" : "danger"), text: slipped ? "Отменить срыв" : "Срыв",
        onclick: function () {
          if (slipped) return mark(h, H.data.today, null);
          App.confirm("Отметить срыв за сегодня? Счёт начнётся заново.", function () { mark(h, H.data.today, "slip"); });
        } }));
    }

    var strip = el("div", { class: "hweek" });
    h.week.forEach(function (w) {
      var sym = w.state === "done" ? "✓" : w.state === "slip" ? "✕" : "";
      strip.appendChild(el("button", { type: "button", class: "wk " + w.state + (w.date === H.data.today ? " now" : ""),
        "aria-label": wdName(w.date) + " " + dmy(w.date), onclick: function () { weekTap(h, w, ro); } }, [
        el("span", { class: "wl", text: wdName(w.date) }),
        el("span", { class: "wm", text: sym }),
      ]));
    });

    return el("div", { class: "card habit" }, [el("div", { class: "row" }, rowKids), strip]);
  }

  function reminderLine(h) {
    if (!h.remind_time) return null;
    var t = "Напомню в " + h.remind_time;
    if (h.shift_mode === "evening") t += ", в смену вечером в " + h.evening_time;
    else if (h.shift_mode === "silent") t += ", в смену молчу";
    return el("span", { class: "sub", text: t });
  }

  function weekTap(h, w, ro) {
    if (ro) return;
    if (w.state === "off") return toast(h.kind === "do" ? "В этот день привычка не по расписанию" : "Привычки ещё не было");
    if (h.kind === "do") return mark(h, w.date, w.state === "done" ? null : "done");
    if (w.state === "slip") return mark(h, w.date, null);
    App.confirm("Отметить срыв за " + dmy(w.date) + "?", function () { mark(h, w.date, "slip"); });
  }

  function mark(h, date, status) {
    var before = h.streak;
    ui.run(null, function () { return api("habits.mark", { id: h.id, date: date, status: status }); }, function () {
      return load().then(function () {
        if (status === "slip") return toast(PHRASES.slip);
        if (status !== "done") return;
        var now = H.data.habits.filter(function (x) { return x.id === h.id; })[0];
        var phrase = now && now.streak > before && PHRASES.doMilestone[now.streak];
        if (phrase) toast(phrase);
      });
    });
  }

  /* ───────── форма привычки ───────── */
  function habitForm(ex) {
    var kind = ex ? ex.kind : "do";
    var days = ex ? ex.days.slice() : [1, 2, 3, 4, 5, 6, 7];
    var remindOn = !!(ex && ex.remind_time);
    var mode = ex ? ex.shift_mode : "normal";

    var nameI = el("input", { type: "text", class: "inp", maxlength: "80", placeholder: kind === "avoid" ? "Например, сладкое" : "Например, выпить воду", value: ex ? ex.name : "" });
    var timeI = el("input", { type: "time", class: "inp", value: (ex && ex.remind_time) || "09:00" });
    var eveI = el("input", { type: "time", class: "inp", value: (ex && ex.evening_time) || "21:30" });

    var daysRow = el("div", { class: "chips" });
    function drawDays() {
      clear(daysRow);
      WD_NAMES.forEach(function (n, i) {
        var d = i + 1;
        daysRow.appendChild(el("button", { type: "button", class: "chip" + (days.indexOf(d) > -1 ? " on" : ""), text: n,
          onclick: function () {
            var k = days.indexOf(d);
            if (k > -1) days.splice(k, 1); else days.push(d);
            drawDays();
          } }));
      });
    }
    drawDays();

    var daysFld = ui.field("Дни", daysRow);
    var timeFld = ui.field("Время напоминания", timeI);
    var eveFld = ui.field("Вечером в", eveI);
    var modeFld = ui.field("Если в этот день смена", ui.chipRow(MODES, function () { return mode; }, function (k) { mode = k; sync(); }));
    var remFld = ui.field("Напоминание от бота", ui.chipRow([["on", "Напоминать"], ["off", "Не напоминать"]],
      function () { return remindOn ? "on" : "off"; }, function (k) { remindOn = k === "on"; sync(); }));

    function sync() {
      daysFld.hidden = kind !== "do";
      timeFld.hidden = !remindOn;
      modeFld.hidden = !remindOn;
      eveFld.hidden = !remindOn || mode !== "evening";
    }

    var kindFld;
    if (ex) {
      kindFld = el("div", { class: "sub", text: kind === "do" ? "Делать" : "Не делать" });
    } else {
      kindFld = ui.chipRow([["do", "Делать"], ["avoid", "Не делать"]], function () { return kind; }, function (k) {
        kind = k; nameI.placeholder = k === "avoid" ? "Например, сладкое" : "Например, выпить воду"; sync();
      });
    }
    sync();

    var save = el("button", { type: "button", class: "btn", text: "Сохранить" });
    save.addEventListener("click", function () {
      if (!nameI.value.trim()) return toast("Впиши название");
      if (kind === "do" && !days.length) return toast("Выбери хотя бы один день");
      if (remindOn && !timeI.value) return toast("Укажи время напоминания");
      if (remindOn && mode === "evening" && !eveI.value) return toast("Укажи вечернее время");
      var payload = {
        id: ex ? ex.id : undefined, name: nameI.value, kind: kind, days: days.slice().sort(),
        remind_time: remindOn ? timeI.value : null, shift_mode: mode, evening_time: eveI.value || "21:30",
      };
      ui.run(save, function () { return api("habits.save", payload); }, function () {
        return load().then(ui.closeSheet);
      });
    });

    ui.show(function (p) {
      p.appendChild(ui.head(ex ? "Привычка" : "Новая привычка"));
      p.appendChild(ui.field("Тип", kindFld));
      p.appendChild(ui.field("Название", nameI));
      p.appendChild(daysFld);
      p.appendChild(remFld);
      p.appendChild(timeFld);
      p.appendChild(modeFld);
      p.appendChild(eveFld);
      p.appendChild(el("div", { class: "sub", text: kind === "do"
        ? "Бот напомнит в это время, пока привычка не отмечена за день."
        : "Бот напомнит в это время, если срыва за день не было." }));
      p.appendChild(ui.formButtons(save));
      if (ex) {
        p.appendChild(el("button", { type: "button", class: "btn danger", text: "Убрать в архив", onclick: function () {
          App.confirm("Убрать «" + ex.name + "» в архив? История сохранится, вернуть можно в любой момент.", function () {
            ui.run(null, function () { return api("habits.archive", { id: ex.id, archived: true }); }, function () {
              return load().then(ui.closeSheet);
            });
          });
        } }));
      }
    });
  }

  /* ───────── архив ───────── */
  function archiveSheet() {
    ui.show(function (p) {
      p.appendChild(ui.head("Архив"));
      if (!H.data.archived.length) p.appendChild(el("div", { class: "sub", text: "Архив пуст" }));
      H.data.archived.forEach(function (a) {
        function after() { return load().then(function () { if (H.data.archived.length) archiveSheet(); else ui.closeSheet(); }); }
        p.appendChild(el("div", { class: "item" }, [
          el("div", { class: "ttl", text: a.name }),
          el("div", { class: "sub", text: a.kind === "do" ? "Делать" : "Не делать" }),
          el("div", { class: "acts" }, [
            el("button", { type: "button", class: "btn soft sm", text: "Вернуть", onclick: function () {
              ui.run(null, function () { return api("habits.archive", { id: a.id, archived: false }); }, after);
            } }),
            el("button", { type: "button", class: "btn danger sm", text: "Удалить навсегда", onclick: function () {
              App.confirm("Удалить «" + a.name + "» вместе со всей историей? Это нельзя отменить.", function () {
                ui.run(null, function () { return api("habits.delete", { id: a.id }); }, after);
              });
            } }),
          ]),
        ]));
      });
    });
  }

  /* ───────── запуск ───────── */
  // дата могла смениться, пока приложение лежало свёрнутым
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && App.state.me && H.data && Date.now() - H.at > 60000) load();
  });

  // для экрана «Сегодня» (js/today.js): общие фразы и обновление этой вкладки после отметок
  App.habits = { reload: load, phrases: PHRASES };

  App.onReady(function () {
    H.data = null; H.err = null;
    render();
    load();
  });
})();
