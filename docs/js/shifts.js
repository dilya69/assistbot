/* Вкладка «Смены»: календарь, смены (в том числе на несколько дат сразу),
   напоминания, отпуск и больничный, типы смен. Общие функции берутся из app.js (window.App). */
(function () {
  "use strict";

  var App = window.App;
  if (!App) return;
  var el = App.el, clear = App.clear, api = App.api, toast = App.toast, haptic = App.haptic, state = App.state;

  var MONTHS = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
  var MONTHS_GEN = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
  var DAYS_LONG = ["Воскресенье","Понедельник","Вторник","Среда","Четверг","Пятница","Суббота"];
  var WD_MON = ["Пн","Вт","Ср","Чт","Пт","Сб","Вс"];
  var ADV = [[0, "В момент"], [15, "За 15 мин"], [30, "За 30 мин"], [60, "За час"], [1440, "За день"]];
  var REP = [["none", "Не повторять"], ["daily", "Каждый день"], ["weekly", "Каждую неделю"], ["monthly", "Каждый месяц"]];
  var KIND = { vacation: "Отпуск", sick: "Больничный" };

  var now0 = new Date();
  var S = { y: now0.getFullYear(), m: now0.getMonth(), data: null, err: null, select: false, picked: {}, req: 0 };

  /* ───────── даты и подписи ───────── */
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function fmt(y, m, d) { return y + "-" + pad(m + 1) + "-" + pad(d); }
  function fmtDate(dt) { return fmt(dt.getFullYear(), dt.getMonth(), dt.getDate()); }
  function parse(s) { var p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function longDate(s) { var d = parse(s); return DAYS_LONG[d.getDay()] + ", " + d.getDate() + " " + MONTHS_GEN[d.getMonth()]; }
  function dm(s) { var p = s.split("-"); return p[2] + "." + p[1]; }
  function shortT(t) { var p = t.split(":"); var h = String(+p[0]); return p[1] === "00" ? h : h + ":" + p[1]; }
  function hours(s, e) { return shortT(s) + "–" + shortT(e); }
  function readOnly() { return !!(state.me && state.me.viewer.read_only); }
  function advLabel(n) {
    for (var i = 0; i < ADV.length; i++) if (ADV[i][0] === n) return ADV[i][1];
    if (n % 1440 === 0) return "За " + (n / 1440) + " дн.";
    if (n % 60 === 0) return "За " + (n / 60) + " ч";
    return "За " + n + " мин";
  }
  function repLabel(k) { for (var i = 0; i < REP.length; i++) if (REP[i][0] === k) return REP[i][1]; return ""; }

  /* ───────── загрузка ───────── */
  function gridRange() {
    var ws = state.me.user.week_start === 0 ? 0 : 1;
    var first = new Date(S.y, S.m, 1);
    var off = (first.getDay() - ws + 7) % 7;
    var dim = new Date(S.y, S.m + 1, 0).getDate();
    var weeks = Math.ceil((off + dim) / 7);
    return {
      ws: ws, off: off, total: weeks * 7,
      from: fmtDate(new Date(S.y, S.m, 1 - off)),
      to: fmtDate(new Date(S.y, S.m, 1 - off + weeks * 7 - 1)),
    };
  }

  function indexData(d) {
    var o = { types: d.types, shifts: {}, rems: {}, abs: d.absences };
    d.shifts.forEach(function (s) { o.shifts[s.date] = s; });
    d.reminders.forEach(function (r) { (o.rems[r.date] = o.rems[r.date] || []).push(r); });
    return o;
  }

  function load() {
    var g = gridRange(), id = ++S.req;
    S.err = null;
    return api("shifts.range", { from: g.from, to: g.to }).then(function (d) {
      if (id !== S.req) return;
      S.data = indexData(d);
      render();
    }).catch(function (e) {
      if (id !== S.req) return;
      S.err = e.message;
      if (S.data) toast(e.message); else render();
    });
  }

  function absenceOn(date) {
    if (!S.data) return null;
    for (var i = 0; i < S.data.abs.length; i++) {
      var a = S.data.abs[i];
      if (a.start_date <= date && date <= a.end_date) return a;
    }
    return null;
  }
  function absencesOn(date) {
    return S.data.abs.filter(function (a) { return a.start_date <= date && date <= a.end_date; });
  }

  /* ───────── календарь ───────── */
  function shiftMonth(delta) {
    var d = new Date(S.y, S.m + delta, 1);
    S.y = d.getFullYear(); S.m = d.getMonth();
    haptic("light");
    render(); load();
  }

  function render() {
    var root = clear(App.$("shiftsBody"));
    if (!S.data) {
      if (S.err) {
        root.appendChild(el("div", { class: "empty" }, [
          el("b", { text: "Не получилось загрузить смены" }), el("span", { text: S.err }),
          el("button", { type: "button", class: "btn", style: "margin-top:10px", text: "Повторить", onclick: function () { S.err = null; render(); load(); } }),
        ]));
      } else {
        root.appendChild(el("div", { class: "empty" }, [el("span", { text: "Загрузка..." })]));
      }
      return;
    }

    var wrap = el("div", { style: "display:flex;flex-direction:column;gap:12px" });
    var g = gridRange();
    var today = fmtDate(new Date());

    wrap.appendChild(el("div", { class: "cal-nav" }, [
      el("button", { type: "button", class: "icon-btn", text: "‹", "aria-label": "Прошлый месяц", onclick: function () { shiftMonth(-1); } }),
      el("button", { type: "button", class: "cal-title", style: "background:none;border:0;color:var(--ink)", "aria-label": "Текущий месяц",
        text: MONTHS[S.m] + " " + S.y,
        onclick: function () { var n = new Date(); S.y = n.getFullYear(); S.m = n.getMonth(); render(); load(); } }),
      el("button", { type: "button", class: "icon-btn", text: "›", "aria-label": "Следующий месяц", onclick: function () { shiftMonth(1); } }),
    ]));

    var cal = el("div", { class: "cal" });
    var wd = el("div", { class: "cal-wd" });
    for (var i = 0; i < 7; i++) wd.appendChild(el("span", { text: WD_MON[(i + (g.ws === 1 ? 0 : 6)) % 7] }));
    cal.appendChild(wd);

    var grid = el("div", { class: "cal-grid" });
    for (var k = 0; k < g.total; k++) {
      grid.appendChild(dayCell(new Date(S.y, S.m, 1 - g.off + k), today));
    }
    cal.appendChild(grid);
    wrap.appendChild(cal);

    if (!readOnly()) {
      wrap.appendChild(el("div", { class: "cal-tools" }, [
        el("button", { type: "button", class: "btn " + (S.select ? "" : "soft"), text: S.select ? "Готово" : "Выбрать даты",
          onclick: function () { S.select = !S.select; S.picked = {}; render(); } }),
        el("button", { type: "button", class: "btn soft", text: "Типы смен", onclick: showTypes }),
      ]));
    }

    if (S.select && !readOnly()) {
      var n = Object.keys(S.picked).length;
      wrap.appendChild(el("div", { class: "selbar" }, [
        el("span", { class: "grow", text: n ? "Выбрано: " + n : "Отметь дни" }),
        el("button", { type: "button", class: "btn sm", text: "Смена", onclick: function () {
          if (!n) return toast("Сначала отметь дни");
          shiftForm(Object.keys(S.picked).sort(), null);
        } }),
        el("button", { type: "button", class: "btn sm danger", text: "Убрать", onclick: function () {
          if (!n) return toast("Сначала отметь дни");
          var dates = Object.keys(S.picked).sort();
          App.confirm("Убрать смены с выбранных дат (" + dates.length + ")?", function () {
            run(null, function () { return api("shifts.delete", { dates: dates }); }, function () { S.picked = {}; return load(); });
          });
        } }),
      ]));
    }
    root.appendChild(wrap);
  }

  function dayCell(dt, today) {
    var date = fmtDate(dt);
    var sh = S.data.shifts[date];
    var ab = absenceOn(date);
    var rems = S.data.rems[date];
    var cls = "day" + (dt.getMonth() !== S.m ? " out" : "") + (date === today ? " today" : "") +
      (ab ? (ab.kind === "sick" ? " sick" : " vac") : "") + (S.picked[date] ? " sel" : "");
    var kids = [el("span", { class: "dn", text: String(dt.getDate()) })];
    if (sh) {
      kids.push(el("span", { class: "frame" }, [
        el("span", { class: "fn", text: sh.type_name }),
        el("span", { class: "fh", text: hours(sh.start, sh.end) }),
      ]));
    } else if (ab) {
      kids.push(el("span", { class: "tag", text: ab.kind === "sick" ? "бол." : "отп." }));
    }
    if (rems && rems.length) kids.push(el("i", { class: "dot" }));
    return el("button", { type: "button", class: cls, "aria-label": longDate(date), onclick: function () { onDay(date); } }, kids);
  }

  function onDay(date) {
    if (S.select && !readOnly()) {
      if (S.picked[date]) delete S.picked[date]; else S.picked[date] = true;
      haptic("light");
      render();
      return;
    }
    haptic("light");
    showDay(date);
  }

  /* ───────── шторка ───────── */
  var sheet = null;
  function closeSheet() {
    if (sheet && sheet.parentNode) sheet.parentNode.removeChild(sheet);
    sheet = null;
  }
  function show(build) {
    var panel;
    if (sheet) {
      panel = clear(sheet.querySelector(".sheet"));
      panel.scrollTop = 0;
    } else {
      panel = el("div", { class: "sheet", role: "dialog", "aria-modal": "true" });
      sheet = el("div", { class: "sheet-wrap" }, [el("div", { class: "sheet-bg", onclick: closeSheet }), panel]);
      document.body.appendChild(sheet);
    }
    build(panel);
  }
  function head(title, back) {
    var kids = [];
    if (back) kids.push(el("button", { type: "button", class: "icon-btn", text: "‹", "aria-label": "Назад", onclick: back }));
    kids.push(el("h2", { text: title }));
    kids.push(el("button", { type: "button", class: "icon-btn", text: "✕", "aria-label": "Закрыть", onclick: closeSheet }));
    return el("div", { class: "sheet-hd" }, kids);
  }

  // запрос с блокировкой кнопки; при ошибке показывает её и ничего не закрывает
  function run(btn, call, then) {
    if (btn) btn.disabled = true;
    call().then(function () { haptic("light"); return then(); })
      .catch(function (e) { toast(e.message); })
      .then(function () { if (btn) btn.disabled = false; });
  }

  function field(label, node) { return el("div", { class: "fld" }, [el("span", { class: "lbl", text: label }), node]); }

  function chipRow(items, getActive, onPick) {
    var row = el("div", { class: "chips" });
    function draw() {
      clear(row);
      items.forEach(function (it) {
        row.appendChild(el("button", { type: "button", class: "chip" + (getActive() === it[0] ? " on" : ""), text: it[1],
          onclick: function () { onPick(it[0]); draw(); } }));
      });
    }
    draw();
    return row;
  }

  function formButtons(saveBtn, back) {
    return el("div", { class: "btns" }, [
      el("button", { type: "button", class: "btn soft", text: "Отмена", onclick: back || closeSheet }),
      saveBtn,
    ]);
  }

  /* ───────── окно дня ───────── */
  function showDay(date) {
    if (!S.data) return toast("Календарь ещё загружается");
    var ro = readOnly();
    var back = function () { showDay(date); };
    show(function (p) {
      p.appendChild(head(longDate(date)));

      var sh = S.data.shifts[date];
      var abs = absencesOn(date);
      var rems = S.data.rems[date] || [];
      if (!sh && !abs.length && !rems.length) p.appendChild(el("div", { class: "sub", text: "На этот день ничего нет" }));

      if (sh) {
        var acts = [];
        if (!ro) {
          acts.push(el("button", { type: "button", class: "btn soft sm", text: "Изменить", onclick: function () { shiftForm([date], back); } }));
          acts.push(el("button", { type: "button", class: "btn danger sm", text: "Удалить", onclick: function () {
            App.confirm("Удалить смену?", function () {
              run(null, function () { return api("shifts.delete", { dates: [date] }); }, function () { return load().then(back); });
            });
          } }));
        }
        p.appendChild(el("div", { class: "item" }, [
          el("div", { class: "row" }, [
            el("span", { class: "frame" }, [el("span", { class: "fn", text: sh.type_name }), el("span", { class: "fh", text: hours(sh.start, sh.end) })]),
            el("span", { class: "grow ttl", text: "Смена " + sh.start + "–" + sh.end + (sh.end <= sh.start ? " (до утра)" : "") }),
          ]),
          sh.comment ? el("div", { class: "sub", text: sh.comment }) : null,
          acts.length ? el("div", { class: "acts" }, acts) : null,
        ]));
      }

      abs.forEach(function (a) {
        var acts2 = [];
        if (!ro) {
          acts2.push(el("button", { type: "button", class: "btn soft sm", text: "Изменить", onclick: function () { absenceForm(date, a, back); } }));
          acts2.push(el("button", { type: "button", class: "btn danger sm", text: "Удалить", onclick: function () {
            App.confirm("Удалить запись «" + KIND[a.kind].toLowerCase() + "» целиком?", function () {
              run(null, function () { return api("absences.delete", { id: a.id }); }, function () { return load().then(back); });
            });
          } }));
        }
        p.appendChild(el("div", { class: "item" }, [
          el("div", { class: "ttl", text: KIND[a.kind] + ": " + dm(a.start_date) + " – " + dm(a.end_date) }),
          a.note ? el("div", { class: "sub", text: a.note }) : null,
          acts2.length ? el("div", { class: "acts" }, acts2) : null,
        ]));
      });

      rems.forEach(function (r) {
        var acts3 = [];
        if (!ro) {
          if (r.repeat === "none") {
            acts3.push(el("button", { type: "button", class: "btn soft sm", text: r.done ? "Вернуть" : "Готово", onclick: function () {
              run(null, function () { return api("reminders.done", { id: r.id, done: !r.done }); }, function () { return load().then(back); });
            } }));
          }
          acts3.push(el("button", { type: "button", class: "btn soft sm", text: "Изменить", onclick: function () { reminderForm(date, r, back); } }));
          acts3.push(el("button", { type: "button", class: "btn danger sm", text: "Удалить", onclick: function () {
            App.confirm(r.repeat === "none" ? "Удалить напоминание?" : "Удалить напоминание вместе со всеми повторами?", function () {
              run(null, function () { return api("reminders.delete", { id: r.id }); }, function () { return load().then(back); });
            });
          } }));
        }
        p.appendChild(el("div", { class: "item" + (r.done ? " done" : "") }, [
          el("div", { class: "ttl", text: r.time + "  " + r.text }),
          el("div", { class: "sub", text: advLabel(r.advance_minutes) + (r.repeat !== "none" ? " · " + repLabel(r.repeat).toLowerCase() : "") }),
          acts3.length ? el("div", { class: "acts" }, acts3) : null,
        ]));
      });

      if (!ro) {
        p.appendChild(el("div", { class: "add-grid" }, [
          el("button", { type: "button", class: "btn", text: sh ? "Сменить смену" : "Смена", onclick: function () { shiftForm([date], back); } }),
          el("button", { type: "button", class: "btn soft", text: "Напоминание", onclick: function () { reminderForm(date, null, back); } }),
          el("button", { type: "button", class: "btn soft", text: "Отпуск / больничный", onclick: function () { absenceForm(date, null, back); } }),
        ]));
      }
    });
  }

  /* ───────── форма смены ───────── */
  function shiftForm(dates, back) {
    var types = S.data.types;
    var ex = dates.length === 1 ? S.data.shifts[dates[0]] : null;
    var typeKey = types.length ? types[0].id : "custom";
    var customName = "";
    if (ex) {
      if (ex.type_id && types.some(function (t) { return t.id === ex.type_id; })) typeKey = ex.type_id;
      else { typeKey = "custom"; customName = ex.type_name; }
    }
    var first = types.filter(function (t) { return t.id === typeKey; })[0];
    var start = ex ? ex.start : (first && first.default_start) || "09:00";
    var end = ex ? ex.end : (first && first.default_end) || "21:00";

    var startI = el("input", { type: "time", class: "inp", value: start });
    var endI = el("input", { type: "time", class: "inp", value: end });
    var nameI = el("input", { type: "text", class: "inp", maxlength: "40", placeholder: "Например, склад", value: customName });
    var nameFld = field("Название", nameI);
    nameFld.hidden = typeKey !== "custom";
    var commentI = el("input", { type: "text", class: "inp", maxlength: "300", placeholder: "Необязательно", value: (ex && ex.comment) || "" });

    var items = types.map(function (t) { return [t.id, t.name]; });
    items.push(["custom", "Своя"]);
    var chips = chipRow(items, function () { return typeKey; }, function (k) {
      typeKey = k;
      nameFld.hidden = k !== "custom";
      var t = types.filter(function (x) { return x.id === k; })[0];
      if (t && t.default_start && t.default_end) { startI.value = t.default_start; endI.value = t.default_end; }
    });

    var save = el("button", { type: "button", class: "btn", text: "Сохранить" });
    save.addEventListener("click", function () {
      var payload = { dates: dates, start: startI.value, end: endI.value, comment: commentI.value };
      if (!payload.start || !payload.end) return toast("Укажи время начала и конца");
      if (typeKey === "custom") {
        payload.type_name = nameI.value.trim();
        if (!payload.type_name) return toast("Впиши название смены");
      } else {
        payload.type_id = typeKey;
      }
      run(save, function () { return api("shifts.save", payload); }, function () {
        S.picked = {}; S.select = false;
        return load().then(function () { if (back) back(); else closeSheet(); });
      });
    });

    show(function (p) {
      p.appendChild(head(dates.length === 1 ? "Смена · " + longDate(dates[0]) : "Смена · выбрано дат: " + dates.length, back));
      p.appendChild(field("Тип", chips));
      p.appendChild(nameFld);
      p.appendChild(el("div", { class: "two" }, [field("С", startI), field("До", endI)]));
      p.appendChild(el("div", { class: "sub", text: "Если «до» раньше «с», смена закончится на следующий день (ночная)." }));
      p.appendChild(field("Комментарий", commentI));
      if (dates.length > 1) p.appendChild(el("div", { class: "sub", text: "Если на какую-то дату смена уже стоит, она заменится." }));
      p.appendChild(formButtons(save, back));
    });
  }

  /* ───────── форма напоминания ───────── */
  function reminderForm(date, ex, back) {
    var advance = ex ? ex.advance_minutes : 0;
    var repeat = ex ? ex.repeat : "none";

    var textI = el("input", { type: "text", class: "inp", maxlength: "200", placeholder: "О чём напомнить", value: ex ? ex.text : "" });
    var dateI = el("input", { type: "date", class: "inp", value: ex ? ex.start_date : date });
    var timeI = el("input", { type: "time", class: "inp", value: ex ? ex.time : "09:00" });
    var untilI = el("input", { type: "date", class: "inp", value: (ex && ex.repeat_until) || "" });
    var untilFld = field("Повторять до (необязательно)", untilI);
    untilFld.hidden = repeat === "none";

    var advItems = ADV.slice();
    if (!ADV.some(function (a) { return a[0] === advance; })) advItems.push([advance, advLabel(advance)]);
    var advChips = chipRow(advItems, function () { return advance; }, function (k) { advance = k; });
    var repChips = chipRow(REP, function () { return repeat; }, function (k) { repeat = k; untilFld.hidden = k === "none"; });

    var save = el("button", { type: "button", class: "btn", text: "Сохранить" });
    save.addEventListener("click", function () {
      if (!textI.value.trim()) return toast("Напиши, о чём напомнить");
      if (!dateI.value || !timeI.value) return toast("Укажи дату и время");
      var payload = {
        id: ex ? ex.id : undefined, text: textI.value, date: dateI.value, time: timeI.value,
        advance_minutes: advance, repeat: repeat, repeat_until: repeat === "none" ? null : untilI.value || null,
      };
      run(save, function () { return api("reminders.save", payload); }, function () {
        return load().then(function () { if (back) back(); else closeSheet(); });
      });
    });

    show(function (p) {
      p.appendChild(head(ex ? "Напоминание" : "Новое напоминание", back));
      p.appendChild(field("Текст", textI));
      p.appendChild(el("div", { class: "two" }, [field(ex && ex.repeat !== "none" ? "Начиная с" : "Дата", dateI), field("Время", timeI)]));
      p.appendChild(field("Когда напомнить", advChips));
      p.appendChild(field("Повтор", repChips));
      p.appendChild(untilFld);
      p.appendChild(formButtons(save, back));
    });
  }

  /* ───────── форма отпуска / больничного ───────── */
  function absenceForm(date, ex, back) {
    var kind = ex ? ex.kind : "vacation";
    var startI = el("input", { type: "date", class: "inp", value: ex ? ex.start_date : date });
    var endI = el("input", { type: "date", class: "inp", value: ex ? ex.end_date : date });
    var noteI = el("input", { type: "text", class: "inp", maxlength: "200", placeholder: "Необязательно", value: (ex && ex.note) || "" });
    startI.addEventListener("change", function () { if (startI.value && (!endI.value || endI.value < startI.value)) endI.value = startI.value; });

    var save = el("button", { type: "button", class: "btn", text: "Сохранить" });
    save.addEventListener("click", function () {
      if (!startI.value || !endI.value) return toast("Укажи первый и последний день");
      if (endI.value < startI.value) return toast("Последний день раньше первого");
      var payload = { id: ex ? ex.id : undefined, kind: kind, start_date: startI.value, end_date: endI.value, note: noteI.value };
      run(save, function () { return api("absences.save", payload); }, function () {
        return load().then(function () { if (back) back(); else closeSheet(); });
      });
    });

    show(function (p) {
      p.appendChild(head(ex ? "Отпуск / больничный" : "Отпуск или больничный", back));
      p.appendChild(chipRow([["vacation", "Отпуск"], ["sick", "Больничный"]], function () { return kind; }, function (k) { kind = k; }));
      p.appendChild(el("div", { class: "two" }, [field("Первый день", startI), field("Последний день", endI)]));
      p.appendChild(field("Заметка", noteI));
      p.appendChild(formButtons(save, back));
    });
  }

  /* ───────── типы смен ───────── */
  function showTypes() {
    if (!S.data) return toast("Календарь ещё загружается");
    show(function (p) {
      p.appendChild(head("Типы смен"));
      if (!S.data.types.length) p.appendChild(el("div", { class: "sub", text: "Типов пока нет. Можно добавить или вписывать название при каждой смене." }));
      S.data.types.forEach(function (t) {
        p.appendChild(el("div", { class: "item" }, [
          el("div", { class: "ttl", text: t.name }),
          el("div", { class: "sub", text: t.default_start && t.default_end ? "Обычно " + hours(t.default_start, t.default_end) : "Часы не заданы" }),
          el("div", { class: "acts" }, [
            el("button", { type: "button", class: "btn soft sm", text: "Изменить", onclick: function () { typeForm(t); } }),
            el("button", { type: "button", class: "btn danger sm", text: "Удалить", onclick: function () {
              App.confirm("Удалить тип «" + t.name + "»? Уже поставленные смены останутся.", function () {
                run(null, function () { return api("shift_types.delete", { id: t.id }); }, function () { return load().then(showTypes); });
              });
            } }),
          ]),
        ]));
      });
      p.appendChild(el("button", { type: "button", class: "btn", text: "Добавить тип", onclick: function () { typeForm(null); } }));
    });
  }

  function typeForm(ex) {
    var nameI = el("input", { type: "text", class: "inp", maxlength: "40", placeholder: "Например, склад", value: ex ? ex.name : "" });
    var startI = el("input", { type: "time", class: "inp", value: (ex && ex.default_start) || "" });
    var endI = el("input", { type: "time", class: "inp", value: (ex && ex.default_end) || "" });
    var save = el("button", { type: "button", class: "btn", text: "Сохранить" });
    save.addEventListener("click", function () {
      if (!nameI.value.trim()) return toast("Впиши название");
      if (!startI.value !== !endI.value) return toast("Укажи оба времени или оставь оба пустыми");
      var payload = { id: ex ? ex.id : undefined, name: nameI.value, default_start: startI.value || null, default_end: endI.value || null };
      run(save, function () { return api("shift_types.save", payload); }, function () { return load().then(showTypes); });
    });
    show(function (p) {
      p.appendChild(head(ex ? "Тип смены" : "Новый тип смены", showTypes));
      p.appendChild(field("Название", nameI));
      p.appendChild(el("div", { class: "two" }, [field("Обычно с", startI), field("до", endI)]));
      p.appendChild(el("div", { class: "sub", text: "Часы подставятся сами при выборе типа, их можно поменять в смене." }));
      p.appendChild(formButtons(save, showTypes));
    });
  }

  /* ───────── запуск ───────── */
  App.onReady(function () {
    S.data = null; S.err = null; S.select = false; S.picked = {};
    closeSheet();
    render();
    load();
  });
})();
