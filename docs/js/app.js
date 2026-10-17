(function () {
  "use strict";

  var tg = window.Telegram && window.Telegram.WebApp;
  var API_URL = (window.APP_CONFIG || {}).API_URL;
  var state = { me: null, viewAs: null, tab: "today" };

  /* ───────── утилиты ───────── */
  function $(id) { return document.getElementById(id); }

  // создание узлов без innerHTML: имя из Telegram не может внедрить разметку
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "class") n.className = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }

  function haptic(kind) {
    try { if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred(kind || "light"); } catch (e) {}
  }
  var toastTimer;
  function toast(text) {
    var t = $("toast"); t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 3500);
  }

  /* ───────── API ───────── */
  function api(action, payload) {
    var body = { action: action, payload: payload || {} };
    if (state.viewAs) body.view_as = state.viewAs;
    return fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-init-data": (tg && tg.initData) || "" },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || "Ошибка " + r.status);
        return j;
      });
    });
  }

  /* ───────── тема ───────── */
  function applyTheme(choice) {
    var t = choice || "auto";
    if (t === "auto") t = (tg && tg.colorScheme === "dark") ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", t);
    try {
      if (tg && tg.setHeaderColor) {
        var bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
        if (bg) { tg.setHeaderColor(bg); tg.setBackgroundColor(bg); }
      }
    } catch (e) {}
  }

  /* ───────── вкладки ───────── */
  var tabHandlers = [];
  function onTab(fn) { tabHandlers.push(fn); }

  function go(tab) {
    state.tab = tab;
    document.querySelectorAll(".view").forEach(function (v) { v.hidden = v.getAttribute("data-tab") !== tab; });
    document.querySelectorAll(".nav button").forEach(function (b) {
      if (b.getAttribute("data-go") === tab) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    try { sessionStorage.setItem("tab", tab); } catch (e) {}
    haptic("light");
    tabHandlers.forEach(function (fn) { try { fn(tab); } catch (e) {} });
  }

  /* ───────── экраны ───────── */
  var MONTHS = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
  var DAYS = ["Воскресенье","Понедельник","Вторник","Среда","Четверг","Пятница","Суббота"];

  // Содержимое экрана «Сегодня» рисует js/today.js; здесь только дата в заголовке
  function renderToday() {
    var now = new Date();
    $("todayDate").textContent = DAYS[now.getDay()] + ", " + now.getDate() + " " + MONTHS[now.getMonth()];
  }

  var THEMES = [["auto", "Как в Telegram"], ["light", "Светлая"], ["dark", "Тёмная"], ["thrones", "Королевства"], ["dead", "Выжившие"]];

  function saveSettings(patch, done) {
    api("settings.update", patch).then(function (me) {
      state.me = me; if (done) done(); haptic("light");
    }).catch(function (e) { toast(e.message); });
  }

  function renderSettings() {
    var body = clear($("settingsBody"));
    var u = state.me.user, s = state.me.settings, v = state.me.viewer;
    var gap = el("div", { style: "display:flex;flex-direction:column;gap:14px" });

    gap.appendChild(el("div", { class: "card" }, [
      el("h3", { text: "Общие" }),
      el("div", { class: "row" }, [el("span", { class: "grow", text: "Часовой пояс" }), el("span", { class: "sub", text: u.timezone })]),
    ]));

    var me = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
    if (v.is_self && me && me.id) {
      gap.appendChild(el("div", { class: "card" }, [
        el("h3", { text: "Твой Telegram-id" }),
        el("div", { class: "row" }, [
          el("span", { class: "grow ttl", style: "font-size:20px;font-weight:600", text: String(me.id) }),
        ]),
        el("div", { class: "sub", text: "Нужен, чтобы выдать доступ администратора" }),
      ]));
    }

    var themeCard = el("div", { class: "card" }, [el("h3", { text: "Оформление" })]);
    var wrap = el("div", { style: "display:flex;flex-wrap:wrap;gap:6px" });
    THEMES.forEach(function (t) {
      var b = el("button", { type: "button", class: "btn " + (s.theme === t[0] ? "" : "soft"), style: "padding:8px 14px", text: t[1],
        onclick: function () {
          if (v.read_only) return toast("Режим просмотра");
          applyTheme(t[0]); saveSettings({ theme: t[0] }, renderSettings);
        } });
      wrap.appendChild(b);
    });
    themeCard.appendChild(wrap);
    gap.appendChild(themeCard);

    if (v.role === "admin") gap.appendChild(adminCard());
    body.appendChild(gap);
  }

  function adminCard() {
    var card = el("div", { class: "card" }, [el("h3", { text: "Администратор" })]);
    var out = el("div", { class: "sub", text: "Загрузка..." });
    card.appendChild(out);

    var prev = state.viewAs; state.viewAs = null;
    Promise.all([api("admin.status"), api("admin.users")]).then(function (r) {
      state.viewAs = prev;
      var st = r[0], us = r[1];
      clear(out);
      out.appendChild(el("div", { text: "Последняя отправка: " + (st.last_sent_at ? new Date(st.last_sent_at).toLocaleString("ru-RU") : "ещё не было") }));
      out.appendChild(el("div", { text: "Ошибок в журнале: " + st.errors.length }));
      st.errors.slice(0, 3).forEach(function (e) { out.appendChild(el("div", { text: e.source + ": " + e.message })); });
      var list = el("div", { style: "display:flex;flex-direction:column;gap:6px;margin-top:10px" });
      us.users.forEach(function (x) {
        if (x.id === state.me.user.id && !state.viewAs) return;
        list.appendChild(el("button", { type: "button", class: "btn soft", text: "Смотреть: " + (x.first_name || "без имени"),
          onclick: function () { state.viewAs = x.id; boot(); } }));
      });
      out.appendChild(list);
    }).catch(function (e) { state.viewAs = prev; out.textContent = e.message; });
    return card;
  }

  function renderBanner() {
    var b = $("banner"); clear(b); b.hidden = true;
    var v = state.me.viewer;
    if (state.viewAs) {
      b.hidden = false;
      b.appendChild(el("div", { class: "pill warn", style: "margin:8px 16px 0" }, [
        "Режим просмотра: изменения отключены ",
        el("button", { type: "button", class: "btn soft", style: "padding:4px 10px;margin-left:8px", text: "Выйти",
          onclick: function () { state.viewAs = null; boot(); } }),
      ]));
      return;
    }
    if (state.me.user.bot_blocked) {
      b.hidden = false;
      b.appendChild(el("div", { class: "pill warn", style: "margin:8px 16px 0",
        text: "Бот не может писать. Открой чат с ботом и нажми «Старт»." }));
      return;
    }
    var dev = "";
    try { dev = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) {}
    if (v.is_self && dev && dev !== state.me.user.timezone) {
      b.hidden = false;
      b.appendChild(el("div", { class: "pill cyc", style: "margin:8px 16px 0" }, [
        "Часовой пояс устройства: " + dev + ". Обновить? ",
        el("button", { type: "button", class: "btn", style: "padding:4px 10px;margin-left:8px", text: "Да",
          onclick: function () { saveSettings({ timezone: dev }, function () { renderBanner(); renderSettings(); }); } }),
      ]));
    }
  }

  /* ───────── запуск ───────── */
  function showFatal(text) {
    var t = $("todayBody");
    clear(t).appendChild(el("div", { class: "empty" }, [el("b", { text: "Не получилось открыть" }), el("span", { text: text })]));
  }

  // Вкладки в отдельных файлах (js/shifts.js и т. д.) берут общие функции отсюда
  // и просят вызвать их, когда данные пользователя загружены (и при каждой смене режима просмотра).
  var readyHandlers = [];
  function onReady(fn) {
    readyHandlers.push(fn);
    if (state.me) fn();
  }
  window.App = {
    state: state, $: $, el: el, clear: clear, api: api, toast: toast, haptic: haptic, onReady: onReady,
    go: go, onTab: onTab,
    confirm: function (text, cb) {
      if (tg && tg.showConfirm) tg.showConfirm(text, function (ok) { if (ok) cb(); });
      else if (window.confirm(text)) cb();
    },
  };

  function boot() {
    api("me").then(function (me) {
      state.me = me;
      applyTheme(me.settings.theme);
      renderBanner(); renderToday(); renderSettings();
      readyHandlers.forEach(function (fn) { fn(); });
    }).catch(function (e) { showFatal(e.message); });
  }

  function init() {
    if (tg) {
      try { tg.ready(); tg.expand(); if (tg.disableVerticalSwipes) tg.disableVerticalSwipes(); } catch (e) {}
    }
    applyTheme("auto");
    document.querySelectorAll(".nav button").forEach(function (b) {
      b.addEventListener("click", function () { go(b.getAttribute("data-go")); });
    });
    var saved = null; try { saved = sessionStorage.getItem("tab"); } catch (e) {}
    if (saved && document.getElementById("view-" + saved)) go(saved);

    if (!tg || !tg.initData) { showFatal("Открой приложение из Telegram через бота."); return; }
    if (!API_URL || API_URL.indexOf("YOUR-PROJECT-REF") > -1) { showFatal("Не задан адрес сервера в js/config.js."); return; }
    boot();
  }

  init();
})();
