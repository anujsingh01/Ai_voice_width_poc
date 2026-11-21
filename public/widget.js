/*
 * Prestige voice + text chat widget.
 *
 * Embed on any page:
 *   <script src="https://YOUR-SERVER/widget.js"
 *           data-server="https://YOUR-SERVER"
 *           data-title="Prestige Assistant"
 *           data-color="#c8102e"
 *           data-lang="en-IN" defer></script>
 */
(function () {
  // Not inside our own checkout frame (the store page there loads this script too).
  if (window.__prestigeChatLoaded || window.name === "prestige-chat-checkout") return;
  window.__prestigeChatLoaded = true;

  var script = document.currentScript || document.querySelector('script[src*="widget.js"]');
  var cfg = {
    server: (script && script.dataset.server) || (script ? new URL(script.src).origin : location.origin),
    title: (script && script.dataset.title) || "Prestige Assistant",
    color: (script && script.dataset.color) || "#c8102e",
    lang: (script && script.dataset.lang) || "en-IN",
    // Part of a browser voice's name to prefer. Chosen by ear on /voices.html:
    // Chrome's "Google हिन्दी". Browsers without it get their most natural voice.
    voice: (script && script.dataset.voice) || "Google हिन्दी",

    greeting:
      (script && script.dataset.greeting) ||
      "Hi! I'm here to help you find the right Prestige product. Ask me anything, or tap the mic to talk.",
  };
  var STORE_KEY = "prestige-chat-history";
  // Cart and checkout work only when the widget runs on the store itself; on
  // any other page (like the local demo) the product view links to the store.
  var onStore = /(^|\.)ttkprestige\.com$/.test(location.hostname);

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var canListen = !!SR;
  var canSpeak = "speechSynthesis" in window;

  // ---------- DOM ----------
  var host = document.createElement("div");
  host.id = "prestige-chat";
  document.body.appendChild(host);
  var root = host.attachShadow({ mode: "open" });

  root.innerHTML =
    "<style>" +
    ":host{--c:" + cfg.color + ";all:initial}" +
    "*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Sans',sans-serif}" +
    ".launcher{position:fixed;right:20px;bottom:20px;width:60px;height:60px;border-radius:50%;border:0;background:var(--c);color:#fff;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;z-index:2147483646;transition:transform .2s}" +
    ".launcher:hover{transform:scale(1.06)}" +
    ".nudge{position:fixed;right:20px;bottom:92px;max-width:260px;background:#fff;color:#1d1d1f;border-radius:14px;box-shadow:0 8px 28px rgba(0,0,0,.18);padding:11px 34px 11px 14px;font-size:13.5px;line-height:1.4;cursor:pointer;z-index:2147483646;display:none;animation:pop .2s ease-out}" +
    ".nudge.on{display:block}.nudge b{display:block;color:var(--c)}" +
    ".nudge .x{position:absolute;top:6px;right:6px;border:0;background:none;color:#888;cursor:pointer;padding:4px;display:flex}.nudge .x svg{width:14px;height:14px}" +
    ".launcher svg{width:28px;height:28px}" +
    ".panel{position:fixed;right:20px;bottom:92px;width:380px;max-width:calc(100vw - 32px);height:600px;max-height:calc(100vh - 120px);background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.22);display:none;flex-direction:column;overflow:hidden;z-index:2147483647;color:#1d1d1f}" +
    ".panel.open{display:flex;animation:pop .18s ease-out}" +
    ".panel.big{width:min(920px,calc(100vw - 40px));height:calc(100vh - 112px);max-height:none}" +
    ".body{flex:1;display:flex;min-height:0;position:relative}" +
    ".chat{flex:1;display:flex;flex-direction:column;min-width:0}" +
    ".pv{position:absolute;inset:0;background:#fff;display:none;flex-direction:column;z-index:3}" +
    ".pv.on{display:flex;animation:pop .15s ease-out}" +
    ".panel.big .pv{position:static;flex:0 0 46%;border-left:1px solid #eee;animation:none}" +
    ".pvbar{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #eee}" +
    ".back{border:0;background:#f0f0f2;color:#1d1d1f;border-radius:999px;padding:7px 12px;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:4px}" +
    ".back svg{width:16px;height:16px}.back:hover{background:#e6e6ea}" +
    ".pvbody{flex:1;overflow-y:auto;padding:14px 16px;font-size:13.5px;line-height:1.5;color:#1d1d1f}" +
    ".pvbody img.hero{width:100%;height:230px;object-fit:contain;display:block;margin-bottom:10px}" +
    ".pvbody h3{font-size:16px;line-height:1.3;margin:0 0 4px}.pvbody .cat{color:#777;font-size:12px;margin-bottom:8px}" +
    ".pvbody .price{font-size:20px;font-weight:700;margin:6px 0}.pvbody .price s{font-size:13px;color:#888;font-weight:400;margin-left:6px}" +
    ".pvbody .price em{font-style:normal;color:#1a7f37;font-size:13px;margin-left:6px}" +
    ".badge{display:inline-block;font-size:12px;font-weight:600;border-radius:6px;padding:2px 8px;background:#e7f6ec;color:#1a7f37}.badge.no{background:#fdecea;color:#b42318}" +
    ".pvbody h4{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#666;margin:16px 0 6px}" +
    ".pvbody ul{margin:0;padding-left:18px}.pvbody li{margin:2px 0}" +
    ".opts{display:flex;flex-wrap:wrap;gap:6px}.opt{border:1px solid #ddd;border-radius:8px;padding:6px 9px;font-size:12.5px}.opt b{display:block}.opt.no{opacity:.55}" +
    ".specs{width:100%;border-collapse:collapse;font-size:12.5px}.specs td{border-bottom:1px solid #f0f0f0;padding:5px 4px;vertical-align:top}.specs td:first-child{color:#666;width:42%}" +
    ".pvfoot{display:flex;gap:8px;padding:10px 12px;border-top:1px solid #eee}.pvfoot:empty{display:none}" +
    ".panel.big .pv.wide{flex-basis:64%}.pv.wide .pvbody{padding:0;overflow:hidden}" +
    ".pvbody iframe{width:100%;height:100%;border:0;display:block;background:#fff}" +
    ".opt{background:#fff;cursor:pointer;color:#1d1d1f;text-align:left;font:inherit;font-size:12.5px}.opt:hover{border-color:var(--c)}" +
    ".opt.sel{border-color:var(--c);box-shadow:inset 0 0 0 1px var(--c);background:#fff5f6}.opt:disabled{cursor:default}" +
    ".qty{display:flex;align-items:center;gap:6px}.qty button{width:30px;height:30px;border-radius:8px;border:1px solid #ddd;background:#fff;cursor:pointer;font-size:16px;color:#1d1d1f}" +
    ".qty span{min-width:24px;text-align:center;font-weight:600}.qty .rm{width:auto;border:0;color:#b42318;font-size:12.5px;margin-left:auto;padding:0 4px}" +
    ".ci{display:flex;gap:10px;padding:10px 0;border-bottom:1px solid #f0f0f0}.ci img{width:64px;height:64px;object-fit:contain;flex-shrink:0}" +
    ".ci-m{flex:1;min-width:0}.ci-t{font-size:13px;line-height:1.3;font-weight:600}.ci-p{font-weight:700;margin:3px 0 6px}" +
    ".sub{display:flex;justify-content:space-between;font-size:15px;padding:12px 0 4px}" +
    ".empty{text-align:center;color:#555;padding:40px 10px}.empty b{display:block;font-size:15px;color:#1d1d1f;margin-bottom:4px}" +
    ".buy:disabled{opacity:.5;cursor:default}" +
    ".toast{position:absolute;left:50%;bottom:76px;transform:translateX(-50%) translateY(10px);background:#1d1d1f;color:#fff;font-size:13px;padding:8px 14px;border-radius:999px;opacity:0;pointer-events:none;transition:all .2s;z-index:5;white-space:nowrap;max-width:90%;overflow:hidden;text-overflow:ellipsis}" +
    ".toast.on{opacity:1;transform:translateX(-50%)}.toast.bad{background:#b42318}" +
    ".cartbtn{position:relative}.cartbtn .count{position:absolute;top:0;right:0;background:#fff;color:var(--c);font-size:10px;font-weight:700;border-radius:999px;min-width:16px;height:16px;line-height:16px;text-align:center;padding:0 3px}" +
    ".pvfoot button,.pvfoot a{flex:1;border-radius:999px;padding:10px 0;font-size:13.5px;font-weight:600;text-align:center;cursor:pointer;text-decoration:none}" +
    ".ask{border:1px solid var(--c);background:#fff;color:var(--c)}.buy{background:var(--c);color:#fff;border:0}" +
    "@keyframes pop{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}" +
    ".head{background:var(--c);color:#fff;padding:14px 16px;display:flex;align-items:center;gap:10px}" +
    ".avatar{width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;font-weight:700}" +
    ".who{flex:1;min-width:0;line-height:1.2}.who b,.who span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.who b{font-size:15px}.who span{font-size:12px;opacity:.85}" +
    ".icon{background:none;border:0;color:#fff;cursor:pointer;padding:5px;border-radius:8px;display:flex;flex-shrink:0}" +
    ".icon:hover{background:rgba(255,255,255,.15)}.icon svg{width:20px;height:20px}" +
    ".icon.off{opacity:.55}" +
    ".msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;background:#f6f6f8}" +
    ".m{flex-shrink:0;max-width:85%;padding:10px 13px;border-radius:14px;font-size:14px;line-height:1.45;white-space:normal;word-wrap:break-word}" +
    ".m.bot{background:#fff;align-self:flex-start;border-bottom-left-radius:4px;box-shadow:0 1px 2px rgba(0,0,0,.06)}" +
    ".m.user{background:var(--c);color:#fff;align-self:flex-end;border-bottom-right-radius:4px}" +
    ".m a{color:var(--c);font-weight:600}.m.user a{color:#fff}" +
    ".m ul{margin:4px 0;padding-left:18px}.m p{margin:0 0 6px}.m p:last-child{margin:0}" +
    ".cards{display:flex;flex-shrink:0;gap:8px;overflow-x:auto;align-self:stretch;padding:2px 2px 6px;scroll-snap-type:x mandatory;margin-top:-2px}" +
    ".card{cursor:pointer;flex:0 0 150px;min-width:0;background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.1);overflow:hidden;display:flex;flex-direction:column;text-decoration:none;color:#1d1d1f;scroll-snap-align:start}" +
    ".card:only-child{flex-basis:200px}" +
    ".card img{width:100%;height:110px;object-fit:contain;background:#fff;padding:6px}" +
    ".card .noimg{height:110px;margin:6px;border-radius:8px;background:#f4f4f5;color:#8a8a8e;font-size:11.5px;display:flex;align-items:center;justify-content:center;text-align:center;padding:0 8px}" +
    ".card .t{font-size:12.5px;line-height:1.3;padding:0 10px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:33px}" +
    ".card .p{padding:6px 10px 0;font-size:14px;font-weight:700}.card .p s{color:#888;font-weight:400;font-size:12px;margin-left:4px}" +
    ".card .p em{color:#1a7f37;font-style:normal;font-size:12px;font-weight:600;margin-left:4px}" +
    ".card .oos{color:#b42318;font-size:12px;padding:2px 10px 0}" +
    ".card .go{margin:8px 10px 10px;background:var(--c);color:#fff;border-radius:8px;text-align:center;font-size:12.5px;font-weight:600;padding:7px 0}" +
    ".typing span{display:inline-block;width:7px;height:7px;margin:0 2px;border-radius:50%;background:#aaa;animation:b 1s infinite}" +
    ".typing span:nth-child(2){animation-delay:.15s}.typing span:nth-child(3){animation-delay:.3s}" +
    "@keyframes b{0%,60%,100%{transform:none;opacity:.5}30%{transform:translateY(-4px);opacity:1}}" +
    ".verify{align-self:stretch;background:#fff;border-radius:12px;padding:12px;box-shadow:0 1px 2px rgba(0,0,0,.06);font-size:13px;flex-shrink:0}" +
    ".verify .vr{display:flex;gap:6px;margin-top:8px}.verify .cc{display:flex;align-items:center;padding:0 8px;border:1px solid #ddd;border-radius:8px;color:#555}" +
    ".verify input{flex:1;min-width:0;border:1px solid #ddd;border-radius:8px;padding:9px 10px;font:inherit;font-size:14px;outline:none}.verify input:focus{border-color:var(--c)}" +
    ".verify button{background:var(--c);color:#fff;border:0;border-radius:8px;padding:0 14px;font:inherit;font-weight:600;cursor:pointer}.verify button:disabled{opacity:.5;cursor:default}" +
    ".verify .err{color:#b42318;margin-top:6px}.verify .err:empty{display:none}.verify .note{color:#777;font-size:11.5px;margin-top:6px}" +
    ".verify .lnk{background:none;color:var(--c);padding:0;font-weight:600;margin-top:6px}" +
    ".chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 16px 10px;background:#f6f6f8}" +
    ".chip{border:1px solid #ddd;background:#fff;border-radius:999px;padding:6px 11px;font-size:12.5px;cursor:pointer;color:#333}" +
    ".chip:hover{border-color:var(--c);color:var(--c)}" +
    ".bar{display:flex;gap:8px;padding:10px 12px;border-top:1px solid #eee;align-items:center;background:#fff}" +
    ".bar input{flex:1;border:1px solid #ddd;border-radius:999px;padding:10px 14px;font-size:14px;outline:none;color:#1d1d1f;background:#fff}" +
    ".bar input:focus{border-color:var(--c)}" +
    ".round{width:40px;height:40px;border-radius:50%;border:0;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}" +
    ".round svg{width:20px;height:20px}" +
    ".send{background:var(--c);color:#fff}.send:disabled{opacity:.4;cursor:default}" +
    ".mic{background:#f0f0f2;color:#333}" +
    ".mic.live{background:var(--c);color:#fff;animation:pulse 1.4s infinite}" +
    "@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(200,16,46,.45)}70%{box-shadow:0 0 0 12px rgba(200,16,46,0)}100%{box-shadow:0 0 0 0 rgba(200,16,46,0)}}" +
    ".status{font-size:12px;color:#666;text-align:center;padding:0 12px 8px;min-height:0;background:#fff}" +
    ".status:empty{display:none}" +
    "@media (max-width:480px){.panel,.panel.big{right:0;bottom:0;width:100vw;max-width:100vw;height:100%;max-height:100%;border-radius:0}.launcher{right:16px;bottom:16px}.nudge{right:16px;bottom:86px}.launcher.open{display:none}.expand{display:none}.panel.big .pv{position:absolute;flex:none;border:0}}" +
    "</style>" +
    '<div class="nudge" role="button" tabindex="0"><b>Welcome back!</b>Want to pick up our chat where we left off?' +
    '<button class="x" aria-label="Dismiss">' + icon("close") + "</button></div>" +
    '<button class="launcher" aria-label="Open chat">' + icon("chat") + "</button>" +
    '<div class="panel" role="dialog" aria-label="' + esc(cfg.title) + '">' +
    '<div class="head"><div class="avatar">P</div><div class="who"><b>' + esc(cfg.title) + "</b><span>Online · voice or text</span></div>" +
    (canSpeak ? '<button class="icon speaker off" title="Read replies aloud" aria-label="Read replies aloud">' + icon("speaker") + "</button>" : "") +
    (onStore ? '<button class="icon cartbtn" title="Your cart" aria-label="Your cart">' + icon("cart") + '<span class="count" style="display:none">0</span></button>' : "") +
    '<button class="icon expand" title="Bigger window" aria-label="Bigger window">' + icon("expand") + "</button>" +
    '<button class="icon reset" title="New conversation" aria-label="New conversation">' + icon("reset") + "</button>" +
    '<button class="icon close" title="Close" aria-label="Close chat">' + icon("close") + "</button></div>" +
    '<div class="body"><div class="chat">' +
    '<div class="msgs" aria-live="polite"></div>' +
    '<div class="chips"></div>' +
    '<div class="status"></div>' +
    '<form class="bar">' +
    (canListen ? '<button type="button" class="round mic" title="Talk to me" aria-label="Talk">' + icon("mic") + "</button>" : "") +
    '<input type="text" placeholder="Type your question…" aria-label="Message" autocomplete="off" />' +
    '<button type="submit" class="round send" aria-label="Send" disabled>' + icon("send") + "</button>" +
    "</form></div>" +
    '<div class="pv" role="region" aria-label="Product details">' +
    '<div class="pvbar"><button class="back">' + icon("back") + "Back to chat</button></div>" +
    '<div class="pvbody"></div>' +
    '<div class="pvfoot"></div>' +
    '</div><div class="toast" role="status"></div></div></div>';

  var $ = function (s) { return root.querySelector(s); };
  var launcher = $(".launcher"), panel = $(".panel"), msgsEl = $(".msgs"), chipsEl = $(".chips");
  var form = $(".bar"), input = $(".bar input"), sendBtn = $(".send"), micBtn = $(".mic");
  var speakerBtn = $(".speaker"), statusEl = $(".status");
  var pv = $(".pv"), pvBody = $(".pvbody"), pvFoot = $(".pvfoot"), expandBtn = $(".expand"), nudge = $(".nudge");
  var cartBtn = $(".cartbtn");


  // ---------- state ----------
  var history = load();
  var busy = false;
  var voiceMode = false; // hands-free conversation: listen -> answer -> speak -> listen
  var speakReplies = false;
  var recognition = null;
  var silentRetries = 0;
  var current = null; // the reply being fetched or spoken: { stop(), text() }
  var barge = null;   // the listener that lets the customer talk over a reply

  // The conversation is kept in localStorage for a week, so it's shared by every
  // tab of the store and still there when the shopper comes back another day.
  function load() {
    var keepMs = 7 * 24 * 3600 * 1000;
    try {
      var saved = JSON.parse(localStorage.getItem(STORE_KEY));
      if (saved && saved.at && Date.now() - saved.at < keepMs) {
        var msgs = saved.messages || [];
        // Back after a break: the earlier chat stays on screen, but the
        // assistant starts fresh, so an old topic doesn't steer a new question.
        if (Date.now() - saved.at > 15 * 60 * 1000) msgs.forEach(function (m) { m.old = true; });
        return msgs;
      }
    } catch (e) {}
    return [];
  }
  // The messages the assistant sees: this visit's conversation only.
  function context() {
    return history.filter(function (m) { return !m.old; });
  }
  // Open/big/product-view state, so the chat comes back as it was after the
  // shopper moves to another page of the store.
  var ui = (function () { try { return JSON.parse(sessionStorage.getItem(STORE_KEY + "-ui")) || {}; } catch (e) { return {}; } })();
  function saveUi() {
    try { sessionStorage.setItem(STORE_KEY + "-ui", JSON.stringify(ui)); } catch (e) {}
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ at: Date.now(), messages: history.slice(-30) })); } catch (e) {}
  }

  // ---------- pilot counts ----------
  // A random id per browser, so the report can count visitors, chat opens and
  // chats. No name, no message text; nothing that identifies the shopper.
  var visitor = (function () {
    try {
      var id = localStorage.getItem("prestige-chat-visitor");
      if (!id) {
        id = Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem("prestige-chat-visitor", id);
      }
      return id;
    } catch (e) { return ""; }
  })();
  // Set once the shopper has confirmed a WhatsApp number (server/verify.js).
  var verified = (function () { try { return localStorage.getItem("prestige-chat-verified") || ""; } catch (e) { return ""; } })();
  // Each event once a visitor a day.
  function track(type) {
    if (!visitor) return;
    var key = "prestige-chat-" + type, today = new Date().toDateString();
    try { if (localStorage.getItem(key) === today) return; localStorage.setItem(key, today); } catch (e) { return; }
    fetch(cfg.server + "/api/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: type, visitor: visitor }),
      keepalive: true,
    }).catch(function () {});
  }
  track("view");

  // ---------- rendering ----------
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function md(text) {
    var out = [], list = null;
    esc(text).split(/\n/).forEach(function (line) {
      line = line
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">link</a>')
        .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
      var li = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)/);
      if (li) { (list = list || []).push("<li>" + li[1] + "</li>"); return; }
      if (list) { out.push("<ul>" + list.join("") + "</ul>"); list = null; }
      if (line.trim()) out.push("<p>" + line + "</p>");
    });
    if (list) out.push("<ul>" + list.join("") + "</ul>");
    return out.join("");
  }

  function bubble(role, text) {
    var el = document.createElement("div");
    el.className = "m " + (role === "user" ? "user" : "bot");
    el.innerHTML = role === "user" ? esc(text) : md(text);
    msgsEl.appendChild(el);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return el;
  }

  var rupee = function (n) { return "₹" + Number(n).toLocaleString("en-IN"); };
  function cards(list) {
    if (!list || !list.length) return;
    var row = document.createElement("div");
    row.className = "cards";
    list.forEach(function (c) {
      var a = document.createElement("a");
      a.className = "card";
      a.href = c.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.innerHTML =
        // Some store pages have no photo yet; keep the card's shape.
        (c.image ? '<img src="' + esc(c.image) + '" alt="" loading="lazy">' : '<div class="noimg">Photo not available</div>') +
        '<div class="t">' + esc(c.title) + "</div>" +
        '<div class="p">' + (c.price ? (c.from ? "from " : "") + rupee(c.price) +
          (c.mrp ? "<s>" + rupee(c.mrp) + "</s>" : "") + (c.off ? "<em>" + c.off + "% off</em>" : "") : "Price on request") + "</div>" +
        (c.inStock ? "" : '<div class="oos">Out of stock</div>') +
        '<div class="go">View product</div>';
      var img = a.querySelector("img");
      if (img) {
        img.onerror = function () { img.remove(); };
        img.onload = function () { msgsEl.scrollTop = msgsEl.scrollHeight; };
      }
      row.appendChild(a);
    });
    msgsEl.appendChild(row);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  // ---------- side view: product, cart and checkout, all inside the chat ----------
  var shortName = function (t) { return t.split(/\s[|–-]\s|\s\||,|\(/)[0].trim().slice(0, 90); };
  function setBig(on) {
    panel.classList.toggle("big", on);
    if (expandBtn) expandBtn.innerHTML = icon(on ? "shrink" : "expand");
    ui.big = on; saveUi();
  }
  function openSide(kind) {
    pv.classList.add("on");
    pv.classList.toggle("wide", kind === "checkout");
    ui.side = kind; saveUi();
    pvBody.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
    pvFoot.innerHTML = "";
    if ((kind === "checkout" || window.innerWidth > 900) && !panel.classList.contains("big")) setBig(true);
  }
  function closeProduct() {
    pv.classList.remove("on", "wide");
    ui.product = null; ui.side = null; saveUi();
    input.focus();
  }
  var toastTimer;
  function toast(text, bad) {
    var t = $(".toast");
    t.textContent = text;
    t.className = "toast on" + (bad ? " bad" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = "toast"; }, 2600);
  }

  // The store's own cart, used through the same calls its pages use. This only
  // works when the widget runs on the store (same site, same cart cookie).
  var cart = {
    count: 0,
    formKey: function () {
      var m = document.cookie.match(/(?:^|;\s*)form_key=([^;]+)/);
      return m ? decodeURIComponent(m[1]) : "";
    },
    post: function (path, data) {
      var f = new FormData();
      Object.keys(data).forEach(function (k) { f.append(k, data[k]); });
      f.append("form_key", cart.formKey());
      return fetch(path, { method: "POST", body: f, headers: { "X-Requested-With": "XMLHttpRequest" }, credentials: "same-origin" })
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); });
    },
    // The store refreshes its own cart right after a change, and the two
    // refreshes can block each other, so each try gets 8 s and up to 3 tries.
    fetchCart: function (tries) {
      var ac = window.AbortController ? new AbortController() : null;
      var timer = ac && setTimeout(function () { ac.abort(); }, 8000);
      return fetch("/customer/section/load/?sections=cart&force_new_section_timestamp=true&_=" + Date.now(), {
        headers: { "X-Requested-With": "XMLHttpRequest" }, credentials: "same-origin", signal: ac && ac.signal,
      }).then(function (r) {
        clearTimeout(timer);
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).catch(function (e) {
        clearTimeout(timer);
        if (tries <= 1) throw e;
        return new Promise(function (ok) { setTimeout(ok, 700); }).then(function () { return cart.fetchCart(tries - 1); });
      });
    },
    // Prefer the store's own cart code: one request, and the store's header
    // cart icon updates at the same time. Fall back to asking directly.
    viaStore: function () {
      return new Promise(function (ok, bad) {
        if (!window.require || !window.require.defined || !window.require.defined("Magento_Customer/js/customer-data")) return bad(new Error("no store cart code"));
        var timer = setTimeout(function () { bad(new Error("timeout")); }, 25000);
        window.require(["Magento_Customer/js/customer-data"], function (cd) {
          cd.reload(["cart"], true)
            .done(function (d) { clearTimeout(timer); d && d.cart ? ok({ cart: d.cart }) : bad(new Error("empty")); })
            .fail(function () { clearTimeout(timer); bad(new Error("failed")); });
        });
      });
    },
    load: function () {
      return cart.viaStore().catch(function () { return cart.fetchCart(3); }).then(function (j) {
        cart.count = (j.cart && j.cart.summary_count) || 0;
        updateCartBadge();
        return j;
      });
    },
  };
  function updateCartBadge() {
    if (!cartBtn) return;
    var b = cartBtn.querySelector(".count");
    b.textContent = cart.count > 9 ? "9+" : cart.count;
    b.style.display = cart.count ? "" : "none";
  }

  function openProduct(url) {
    openSide("product");
    ui.product = url; saveUi();
    fetch(cfg.server + "/api/product?url=" + encodeURIComponent(url))
      .then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (p) { showProduct(p); })
      .catch(function () {
        pvBody.innerHTML = "<p>I couldn't load this product here. Please try again in a moment.</p>";
      });
  }
  var priceHtml = function (price, mrp, from) {
    if (!price) return "Price not listed";
    var off = mrp > price ? Math.round((1 - price / mrp) * 100) : 0;
    return (from ? "from " : "") + rupee(price) + (mrp > price ? "<s>" + rupee(mrp) + "</s><em>" + off + "% off</em>" : "");
  };
  function showProduct(p) {
    var multi = p.variants.length > 1;
    var chosen = multi ? p.variants.filter(function (v) { return v.inStock; })[0] || null : null;
    var qty = 1;
    var h = "";
    if (p.image) h += '<img class="hero" src="' + esc(p.image) + '" alt="">';
    h += "<h3>" + esc(p.title) + "</h3>";
    if (p.category) h += '<div class="cat">' + esc(p.category) + "</div>";
    h += '<div class="price"></div><span class="badge"></span>';
    if (multi) {
      h += "<h4>Choose an option</h4><div class=\"opts\">" + p.variants.map(function (v, i) {
        return '<button type="button" class="opt' + (v.inStock ? "" : " no") + '" data-i="' + i + '"' + (v.inStock ? "" : " disabled") + "><b>" +
          esc(v.label) + "</b>" + (v.price ? rupee(v.price) : "") + (v.inStock ? "" : " · out of stock") + "</button>";
      }).join("") + "</div>";
    }
    if (onStore) h += '<h4>Quantity</h4><div class="qty"><button type="button" data-d="-1" aria-label="Less">−</button><span>1</span><button type="button" data-d="1" aria-label="More">+</button></div>';
    if (p.keyFeatures.length) h += "<h4>Key features</h4><ul>" + p.keyFeatures.slice(0, 10).map(function (f) { return "<li>" + esc(f) + "</li>"; }).join("") + "</ul>";
    var specs = Object.keys(p.specs).filter(function (k) { return !/country of origin|model name/i.test(k); }).slice(0, 14);
    if (specs.length) h += '<h4>Specifications</h4><table class="specs">' + specs.map(function (k) { return "<tr><td>" + esc(k) + "</td><td>" + esc(p.specs[k]) + "</td></tr>"; }).join("") + "</table>";
    if (p.warranty) h += "<h4>Warranty</h4><p>" + esc(p.warranty) + "</p>";
    if (p.description) h += "<h4>About</h4><p>" + esc(p.description.length > 700 ? p.description.slice(0, 700).replace(/\s\S*$/, "") + "…" : p.description) + "</p>";
    pvBody.innerHTML = h;
    pvBody.scrollTop = 0;
    var img = pvBody.querySelector("img");
    if (img) img.onerror = function () { img.remove(); };

    pvFoot.innerHTML = '<button class="ask" type="button">Ask about this</button>' +
      (onStore ? '<button class="buy add" type="button">Add to cart</button>'
               : '<a class="buy" target="_blank" rel="noopener" href="' + esc(p.url) + '">Buy on website</a>');
    var addBtn = pvFoot.querySelector(".add");

    function refresh() {
      var v = chosen;
      pvBody.querySelector(".price").innerHTML = v ? priceHtml(v.price, v.mrp) : priceHtml(p.price, p.mrp, multi);
      var stock = v ? v.inStock : p.inStock;
      var badge = pvBody.querySelector(".badge");
      badge.className = "badge" + (stock ? "" : " no");
      badge.textContent = stock ? "In stock" : "Out of stock";
      pvBody.querySelectorAll(".opt").forEach(function (b) { b.classList.toggle("sel", chosen === p.variants[+b.dataset.i]); });
      var q = pvBody.querySelector(".qty span");
      if (q) q.textContent = qty;
      if (addBtn) {
        addBtn.disabled = !stock || !p.productId;
        addBtn.textContent = !stock ? "Out of stock" : "Add to cart" + (qty > 1 ? " (" + qty + ")" : "");
      }
    }
    pvBody.querySelectorAll(".opt").forEach(function (b) {
      b.onclick = function () { chosen = p.variants[+b.dataset.i]; refresh(); };
    });
    pvBody.querySelectorAll(".qty button").forEach(function (b) {
      b.onclick = function () { qty = Math.max(1, Math.min(10, qty + +b.dataset.d)); refresh(); };
    });
    refresh();

    $(".ask").onclick = function () {
      if (!panel.classList.contains("big")) closeProduct();
      input.value = "Tell me more about the " + shortName(p.title) + (chosen ? " (" + chosen.label + ")" : "") + ". ";
      sendBtn.disabled = busy;
      input.focus();
    };
    if (addBtn) addBtn.onclick = function () {
      var data = { product: p.productId, qty: String(qty) };
      if (chosen) Object.keys(chosen.options || {}).forEach(function (a) { data["super_attribute[" + a + "]"] = chosen.options[a]; });
      addBtn.disabled = true;
      addBtn.textContent = "Adding…";
      cart.post("/checkout/cart/add/", data)
        .then(function (text) {
          // The store answers [] when it worked, or sends back a page link
          // (backUrl) when it couldn't add the item (e.g. just sold out).
          var j = {};
          try { j = JSON.parse(text); } catch (e) {}
          if (j && j.backUrl) throw new Error("not added");
          cart.count += qty;
          updateCartBadge();
          toast("Added to your cart");
          pvFoot.innerHTML = '<button class="ask" type="button">Keep shopping</button><button class="buy" type="button">View cart</button>';
          pvFoot.querySelector(".ask").onclick = closeProduct;
          pvFoot.querySelector(".buy").onclick = openCart;
          setTimeout(function () { cart.load().catch(function () {}); }, 800);
        })
        .catch(function (e) {
          toast(e && e.message && e.message !== "not added" ? e.message : "Sorry, that didn't go into the cart. Please try again.", true);
          refresh();
        });
    };
  }

  // The cart the store already keeps in this browser, shown instantly while
  // the fresh copy loads (the store can take several seconds to answer).
  function cachedCart() {
    try {
      var cd = window.require && window.require("Magento_Customer/js/customer-data");
      var c = cd && cd.get("cart")();
      return c && c.items ? c : null;
    } catch (e) { return null; }
  }
  function openCart() {
    openSide("cart");
    var cached = cachedCart();
    if (cached) showCart(cached);
    else pvBody.innerHTML = '<p class="cat">Getting your cart…</p>';
    cart.load().then(function (j) { if (ui.side === "cart") showCart(j.cart); }).catch(function () {
      if (!cached) pvBody.innerHTML = "<p>I couldn't load your cart just now. Please try again.</p>";
    });
  }
  function showCart(c) {
    if (!c || !c.items || !c.items.length) {
      pvBody.innerHTML = '<div class="empty"><b>Your cart is empty</b>Ask me for a recommendation and add it from here.</div>';
      pvFoot.innerHTML = '<button class="buy" type="button">Back to chat</button>';
      pvFoot.querySelector(".buy").onclick = closeProduct;
      return;
    }
    pvBody.innerHTML = "<h3>Your cart</h3>" + c.items.map(function (it) {
      var opts = (it.options || []).map(function (o) { return esc(o.value); }).join(", ");
      return '<div class="ci" data-id="' + esc(it.item_id) + '">' +
        (it.product_image && it.product_image.src ? '<img src="' + esc(it.product_image.src) + '" alt="">' : "") +
        '<div class="ci-m"><div class="ci-t">' + esc(it.product_name) + "</div>" + (opts ? '<div class="cat">' + opts + "</div>" : "") +
        '<div class="ci-p">' + rupee(it.product_price_value * it.qty) + "</div>" +
        '<div class="qty"><button type="button" data-d="-1" aria-label="Less">−</button><span>' + it.qty + '</span><button type="button" data-d="1" aria-label="More">+</button>' +
        '<button type="button" class="rm">Remove</button></div></div></div>';
    }).join("") + '<div class="sub"><span>Subtotal</span><b>' + rupee(Math.round(c.subtotalAmount)) + "</b></div>" +
      '<div class="cat">Delivery and any offers are worked out at checkout.</div>';
    pvBody.querySelectorAll(".ci").forEach(function (row) {
      var id = row.dataset.id;
      var item = c.items.filter(function (i) { return i.item_id === id; })[0];
      // Update the screen as soon as the store confirms, then refresh quietly.
      var change = function (path, data) {
        row.style.opacity = ".5";
        cart.post(path, data).then(function (text) {
          var j = {};
          try { j = JSON.parse(text); } catch (e) {}
          if (j.success === false) throw new Error(j.error_message || "failed");
          if (data.item_qty) item.qty = +data.item_qty;
          else c.items = c.items.filter(function (i) { return i !== item; });
          c.subtotalAmount = c.items.reduce(function (sum, i) { return sum + i.product_price_value * i.qty; }, 0);
          cart.count = c.items.reduce(function (n, i) { return n + i.qty; }, 0);
          updateCartBadge();
          showCart(c);
          cart.load().then(function (fresh) { if (ui.side === "cart") showCart(fresh.cart); }).catch(function () {});
        }).catch(function () { row.style.opacity = ""; toast("Couldn't update the cart. Please try again.", true); });
      };
      row.querySelectorAll(".qty button[data-d]").forEach(function (b) {
        b.onclick = function () {
          var q = item.qty + +b.dataset.d;
          if (q < 1) change("/checkout/sidebar/removeItem/", { item_id: id });
          else change("/checkout/sidebar/updateItemQty/", { item_id: id, item_qty: String(q) });
        };
      });
      row.querySelector(".rm").onclick = function () { change("/checkout/sidebar/removeItem/", { item_id: id }); };
    });
    pvFoot.innerHTML = '<button class="ask" type="button">Keep shopping</button><button class="buy" type="button">Checkout · ' + rupee(Math.round(c.subtotalAmount)) + "</button>";
    pvFoot.querySelector(".ask").onclick = closeProduct;
    pvFoot.querySelector(".buy").onclick = openCheckout;
  }

  // Checkout is the store's own secure checkout page, shown inside the widget.
  // Address, delivery and payment all happen there, without leaving the chat.
  function openCheckout() {
    openSide("checkout");
    var frame = document.createElement("iframe");
    frame.name = "prestige-chat-checkout";
    frame.title = "Checkout";
    frame.src = "/checkout/";
    frame.setAttribute("allow", "payment");
    pvBody.innerHTML = "";
    pvBody.appendChild(frame);
    pvFoot.innerHTML = '<button class="ask" type="button">Back to cart</button>';
    pvFoot.querySelector(".ask").onclick = openCart;
    var done = false;
    frame.onload = function () {
      var where = "";
      try {
        where = frame.contentWindow.location.pathname;
        // Hide the store's own header, menu and footer: the widget is the frame.
        var st = frame.contentDocument.createElement("style");
        st.textContent = ".page-header,.header,.nav-sections,.page-footer,footer,.footer,.breadcrumbs,.copyright{display:none!important}";
        frame.contentDocument.head.appendChild(st);
      } catch (e) {}
      if (/\/checkout\/cart\/?$/.test(where)) return openCart(); // cart was empty or changed
      if (!done && /\/checkout\/onepage\/success/.test(where)) {
        done = true;
        var num = "";
        try {
          var el = frame.contentDocument.querySelector(".checkout-success .order-number, .order-number strong, .checkout-success p span");
          num = el ? el.textContent.trim() : "";
        } catch (e) {}
        cart.load().catch(function () {});
        pvFoot.innerHTML = '<button class="buy" type="button">Back to chat</button>';
        pvFoot.querySelector(".buy").onclick = closeProduct;
        var msg = "Your order is placed" + (num ? " (order number " + num + ")" : "") +
          ". You'll get the confirmation by email and SMS. Anything else I can help you with?";
        history.push({ role: "assistant", content: msg });
        save();
        bubble("assistant", msg);
      }
    };
  }

  function renderAll() {
    msgsEl.innerHTML = "";
    bubble("assistant", cfg.greeting);
    history.forEach(function (m, i) {
      if (!m.old && i > 0 && history[i - 1].old) {
        var line = document.createElement("div");
        line.style.cssText = "text-align:center;font-size:11px;color:#999;margin:10px 0";
        line.textContent = "New conversation";
        msgsEl.appendChild(line);
      }
      bubble(m.role, m.content);
      cards(m.cards);
    });
    renderChips();
  }

  function renderChips() {
    chipsEl.innerHTML = "";
    if (history.length) return;
    ["Which pressure cooker for a family of 4?", "Best gas stove under ₹5000", "Induction cooktops", "Mixer grinder suggestions"].forEach(function (q) {
      var b = document.createElement("button");
      b.className = "chip";
      b.textContent = q;
      b.onclick = function () { send(q, "text"); };
      chipsEl.appendChild(b);
    });
  }

  function setStatus(t) { statusEl.textContent = t || ""; }

  // ---------- speech output ----------
  // Browser voices range from near-human (Edge's "Natural" voices, Chrome's
  // Google voices, macOS Premium/Enhanced) to plainly robotic (macOS compact
  // and novelty voices). How human it sounds matters more than the accent,
  // so quality decides first and language only breaks ties.
  var ROBOTIC = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|ralph|kathy|eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley)\b/i;
  var voice = null;
  function pickVoice() {
    if (!canSpeak) return;
    var voices = speechSynthesis.getVoices();
    var base = cfg.lang.split("-")[0];
    // A voice picked on /voices.html wins in that browser, for testing.
    var forced = cfg.voice;
    try { forced = localStorage.getItem("prestige-chat-voice") || forced; } catch (e) {}
    var score = function (v) {
      var s = 0;
      if (forced && v.name.toLowerCase().indexOf(forced.toLowerCase()) >= 0) s += 1000;
      if (ROBOTIC.test(v.name)) s -= 500;
      if (/natural|neural/i.test(v.name)) s += 100;
      else if (/premium/i.test(v.name)) s += 90;
      else if (/enhanced/i.test(v.name)) s += 80;
      else if (/google/i.test(v.name) && !v.localService) s += 70;
      if (v.lang === cfg.lang) s += 30;
      else if (v.lang && v.lang.indexOf(base) === 0) s += 10;
      else s -= 200;
      if (/female|neerja|isha|veena|heera|swara|samantha|ava|karen/i.test(v.name)) s += 5;
      return s;
    };
    voice = voices.slice().sort(function (a, b) { return score(b) - score(a); })[0] || null;
  }
  if (canSpeak) {
    pickVoice();
    speechSynthesis.onvoiceschanged = pickVoice;
  }

  var speakQueue = 0;
  function speakable(t) {
    return t
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[*_#`>•]/g, "")
      .replace(/[\u{1F300}-\u{1FAFF}☀-➿️]/gu, "")
      .replace(/₹\s?([\d,]+)(\.\d+)?/g, "$1 rupees")
      .replace(/₹/g, "rupees")
      // Read sizes the way a person says them: "4 L" -> "4 litre", "550W" -> "550 watt".
      .replace(/(\d(?:\.\d+)?)\s?(?:L|ltr|litres?)\b/g, "$1 litre")
      .replace(/(\d)\s?ml\b/gi, "$1 ml")
      .replace(/(\d)\s?W\b/g, "$1 watt")
      .replace(/(\d)\s?mm\b/g, "$1 millimetre")
      .replace(/(\d)\s?cm\b/g, "$1 centimetre")
      .replace(/(\d+)\s?%/g, "$1 percent")
      .replace(/\s&\s/g, " and ")
      .replace(/([a-z])\/([a-z])/gi, "$1 or $2")
      .replace(/\s[—–]\s/g, ", ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Server voice: the server proxies ElevenLabs or Google Cloud TTS when it
  // has a key. ElevenLabs is always used; Google only when this browser has no
  // human-sounding voice of its own (Chrome and Edge do, so they stay free).
  // Each sentence's audio is fetched as soon as it's ready and played in
  // order; if a fetch fails, that sentence falls back to the browser voice.
  var serverTts = false;
  fetch(cfg.server + "/api/health")
    .then(function (r) { return r.json(); })
    .then(function (h) { serverTts = h.tts || false; })
    .catch(function () {});
  function goodBrowserVoice() {
    pickVoice();
    if (!voice) return false;
    return (cfg.voice && voice.name.toLowerCase().indexOf(cfg.voice.toLowerCase()) >= 0) ||
      /natural|neural|premium|enhanced/i.test(voice.name) ||
      (/google/i.test(voice.name) && !voice.localService);
  }
  function useServerVoice() {
    return serverTts === "elevenlabs" || (serverTts === "google" && !goodBrowserVoice());
  }

  var player = new Audio();
  var SILENT = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
  // Browsers only allow audio that starts from a click; play silence on the
  // user's click so later replies can play after the network round trip.
  function unlockAudio() {
    if (player.src) return;
    player.src = SILENT;
    player.play().catch(function () {});
  }

  var audioQueue = [], playing = false, generation = 0;

  function browserSpeak(text, done) {
    if (!canSpeak) return done();
    pickVoice(); // cheap, and catches a voice just picked on /voices.html
    var u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.lang = (voice && voice.lang) || cfg.lang;
    u.rate = 1.02;
    u.onend = u.onerror = function () { done(); };
    speechSynthesis.speak(u);
  }

  function fetchAudio(text) {
    return fetch(cfg.server + "/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text }),
    }).then(function (r) {
      if (!r.ok) throw new Error("tts " + r.status);
      return r.blob();
    }).then(function (b) { return URL.createObjectURL(b); });
  }

  function playNext() {
    if (playing || !audioQueue.length) return;
    playing = true;
    var item = audioQueue.shift(), gen = generation;
    var finish = function () {
      if (gen !== generation) return;
      playing = false;
      speakQueue--;
      if (item.onDone) item.onDone();
      playNext();
    };
    item.audio.then(function (url) {
      if (gen !== generation) return;
      player.onended = player.onerror = function () { URL.revokeObjectURL(url); finish(); };
      player.src = url;
      return player.play();
    }).catch(function () {
      if (gen === generation) browserSpeak(item.text, finish);
    });
  }

  function speak(text, onDone) {
    text = speakable(text);
    var server = !!serverTts && useServerVoice();
    if (!text || (!canSpeak && !server)) { if (onDone) onDone(); return; }
    speakQueue++;
    if (server) {
      audioQueue.push({ text: text, audio: fetchAudio(text), onDone: onDone });
      return playNext();
    }
    var gen = generation;
    browserSpeak(text, function () {
      if (gen !== generation) return; // cancelled by stopSpeaking(), which reset the count
      speakQueue--;
      if (onDone) onDone();
    });
  }
  function stopSpeaking() {
    generation++;
    audioQueue = [];
    playing = false;
    player.pause();
    if (canSpeak) speechSynthesis.cancel();
    speakQueue = 0;
  }

  // ---------- talking over the assistant (barge-in) ----------
  // In a voice conversation the mic stays on while the assistant thinks and
  // speaks. The mic also hears the assistant's own voice, so what it hears only
  // counts as the customer when it isn't the reply being read out (or is a
  // word like "wait" / "ruko"). Then the voice stops at once, the rest of the
  // reply is dropped, and their words, first ones included, become the next
  // question once they pause.
  var STOP_WORDS = /\b(stop|wait|hold on|one (sec|second|minute)|excuse me|sorry|no no|ruko|ruk|ruko na|bas|suno|suniye|sunie|ek (minute|second)|arre|nahi nahi|hello)\b|रुको|रुकिए|बस|सुनो|सुनिए/i;
  var words = function (t) {
    return (t || "").toLowerCase().replace(/(\d),(\d)/g, "$1$2").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  };
  function isCustomer(heard, replyText) {
    var w = words(heard);
    if (!w.length) return false;
    if (STOP_WORDS.test(heard)) return true;
    var said = {};
    words(speakable(replyText)).forEach(function (x) { said[x] = 1; });
    var fresh = w.filter(function (x) { return !said[x]; });
    return fresh.length >= 3 || (w.length >= 2 && fresh.length / w.length >= 0.6);
  }
  function startBarge() {
    if (!canListen || !voiceMode || barge) return;
    var b = { triggered: false, from: 0, text: "", rec: null, ender: null };
    barge = b;
    function commit(said, ready) {
      if (barge !== b) return;
      stopBarge();
      (function go(tries) {
        // The interrupted reply needs a moment to wind down before the next question.
        if (busy && tries < 30) return setTimeout(function () { go(tries + 1); }, 100);
        silentRetries = 0;
        input.value = "";
        lastTurn = { text: said };
        send(said, "voice", ready);
      })(0);
    }
    function run() {
      if (barge !== b) return;
      var rec = new SR();
      b.rec = rec;
      rec.lang = cfg.lang;
      rec.continuous = true;
      rec.interimResults = true;
      var base = b.text; // text heard by earlier recognizer sessions after the barge-in
      rec.onresult = function (e) {
        if (!b.triggered) {
          // Judge the newest piece only; older pieces were the assistant's echo.
          var latest = e.results[e.results.length - 1][0].transcript;
          if (!isCustomer(latest, current ? current.text() : "")) return;
          b.triggered = true;
          b.from = e.results.length - 1;
          // Talking again before the reply is spoken, or right after their turn
          // was sent, means they hadn't finished: it was cut off, not interrupted.
          var cutOff = !!(lastTurn && current && current.canTakeBack());
          if (cutOff) { learnPause(pauseWait + 500); learnCheck(checkDelay + 300); } // wait longer for this customer next time
          b.ender = turnEnder(cutOff ? lastTurn.text : "", commit);
          if (current) current.stop(cutOff);
          stopSpeaking();
          micBtn.classList.add("live");
          setStatus("Listening… go ahead");
        }
        var mine = "";
        for (var j = b.from; j < e.results.length; j++) mine += e.results[j][0].transcript + " ";
        b.text = (base + " " + mine).replace(/\s+/g, " ").trim();
        input.value = b.ender.full(b.text);
        b.ender.heard(b.text, e.results[e.results.length - 1].isFinal);
      };
      rec.onerror = function (e) {
        if (e.error === "not-allowed" || e.error === "service-not-allowed") { stopBarge(); setVoiceMode(false); }
      };
      rec.onend = function () {
        if (barge !== b) return;
        // Chrome ends recognition now and then; restart at once so no words are lost.
        if (b.triggered) b.from = 0;
        run();
      };
      try { rec.start(); } catch (e) { setTimeout(run, 150); }
    }
    run();
  }
  function stopBarge() {
    var b = barge;
    barge = null;
    if (!b) return;
    if (b.ender) b.ender.cancel();
    if (b.rec) { b.rec.onend = b.rec.onresult = b.rec.onerror = null; try { b.rec.abort(); } catch (e) {} }
  }

  // ---------- knowing when the customer has finished ----------
  // Like a person on a call: a pause alone doesn't end their turn. At each
  // short pause the widget quietly sends what they've said so far. The server
  // first judges, with the chat in mind, whether they've finished ("I want a
  // cooker for my..." hasn't; "5 litre" answering a question has) and, if so,
  // already starts the answer. Finished: the answer is used at once, so the
  // reply also comes sooner. Not finished: it's dropped and the mic waits
  // longer. More words before the verdict: dropped, and it starts again.
  // If the server can't judge, a pause of the customer's learned length ends it.
  var MID_THOUGHT = /\b(and|or|but|so|because|like|um+|uh+|hmm+|the|a|an|my|for|with|of|in|to|is|aur|ya|ki|ke|ka|ko|se|mein|toh|lekin|par|matlab|jaise|woh|wo|ek|mera|meri|mujhe|hai ki|kaunsa)\s*$/i;
  // How long a pause ends their turn, learned per customer: some people stop
  // to think mid-sentence. It grows when they pause long and carry on, and
  // when they had to continue after being cut off; it eases back slowly.
  var PAUSE_KEY = "prestige-pause-ms";
  var pauseWait = (function () { try { return Number(localStorage.getItem(PAUSE_KEY)) || 1800; } catch (e) { return 1800; } })();
  function learnPause(ms) {
    pauseWait = Math.max(1400, Math.min(4000, Math.round(ms)));
    try { localStorage.setItem(PAUSE_KEY, String(pauseWait)); } catch (e) {}
  }
  // How soon after they stop the server is asked whether they've finished.
  // Short, since a pause mid-sentence is judged by the words; it grows only
  // when this customer got cut off anyway.
  var CHECK_KEY = "prestige-check-ms";
  var checkDelay = (function () { try { return Number(localStorage.getItem(CHECK_KEY)) || 650; } catch (e) { return 650; } })();
  function learnCheck(ms) {
    checkDelay = Math.max(650, Math.min(2000, Math.round(ms)));
    try { localStorage.setItem(CHECK_KEY, String(checkDelay)); } catch (e) {}
  }
  function waitFor(text, isFinal) {
    var w = pauseWait;
    if (!isFinal) w += 900; // the recognizer hasn't settled the words yet
    if (MID_THOUGHT.test(text)) w += 1400; // "...for my", "aur", "matlab": more is coming
    else if (words(text).length < 4) w += 700; // "I want..." is rarely the whole thing
    return w;
  }
  // A turn that has just been sent, so words that follow at once can join it
  // instead of becoming a question of their own.
  var lastTurn = null; // { text }

  // Sends what they've said so far, asking the server whether they're done.
  // ready resolves to "done" (the answer is streaming), "more" or "error".
  function prepareAnswer(text) {
    var p = { text: text, aborter: window.AbortController ? new AbortController() : null, reader: null, dec: null, leftover: "" };
    p.ready = fetch(cfg.server + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: context().concat([{ role: "user", content: text }]), mode: "voice", visitor: visitor, verified: verified, turnCheck: true }),
      signal: p.aborter ? p.aborter.signal : undefined,
    }).then(async function (res) {
      if (!res.ok || !res.body) return "error";
      var reader = res.body.getReader(), dec = new TextDecoder(), got = "";
      while (!got) {
        var r = await reader.read();
        if (r.done) break;
        got += dec.decode(r.value, { stream: true });
      }
      if (got.charAt(0) === "\u0015") return "more";
      if (got.charAt(0) !== "\u0006") { p.drop(); return "error"; }
      p.reader = reader;
      p.dec = dec;
      p.leftover = got.slice(1);
      return "done";
    }).catch(function () { return "error"; });
    p.drop = function () { if (p.aborter) p.aborter.abort(); };
    return p;
  }

  // One customer turn. heard() on every recognizer update; commit(text, ready)
  // once they've finished, with the answer already started when there is one.
  // prefix: the start of a sentence that got cut off.
  function turnEnder(prefix, commit) {
    var t = { text: "", lastAt: 0, lastFinal: false, prep: null, verdict: "", wantEnd: false, over: false, prepTimer: null, endTimer: null };
    var full = function (text) { return ((prefix ? prefix + " " : "") + (text == null ? t.text : text)).trim(); };
    function end(ready) {
      if (t.over) return;
      t.over = true;
      clearTimeout(t.prepTimer);
      clearTimeout(t.endTimer);
      if (t.prep && t.prep.p !== ready) t.prep.p.drop();
      commit(full(), ready || null);
    }
    function prepare() {
      var text = full();
      if (t.over || !text || (t.prep && t.prep.text === text)) return;
      if (t.prep) t.prep.p.drop();
      var mine = { text: text, p: prepareAnswer(text) };
      t.prep = mine;
      t.verdict = "";
      mine.p.ready.then(function (v) {
        if (t.over || t.prep !== mine) return v === "done" && mine.p.drop();
        t.verdict = v;
        if (v === "done") return end(mine.p);
        if (v === "more") {
          // Not finished: give them a good while longer to go on. If the words
          // themselves don't dangle, the judgement may be wrong, so wait less.
          setStatus("Listening… go on");
          clearTimeout(t.endTimer);
          var dangling = MID_THOUGHT.test(text) || words(text).length < 3;
          var wait = dangling ? Math.max(4500, pauseWait * 2) : pauseWait + 1500;
          t.endTimer = setTimeout(function () { end(null); }, Math.max(0, t.lastAt + wait - Date.now()));
          return;
        }
        if (t.wantEnd) end(null); // the server couldn't judge: the pause decides
      });
    }
    // The pause has lasted the customer's usual length.
    function paused() {
      if (t.over || t.verdict === "more") return;
      if (t.prep && t.prep.text === full() && !t.verdict) { t.wantEnd = true; return; } // a verdict is on its way
      end(null);
    }
    t.full = full;
    t.heard = function (text, isFinal) {
      if (t.over) return;
      var now = Date.now();
      if (text !== t.text) {
        // They went quiet after a finished phrase and then carried on: learn that pause.
        if (t.lastFinal && now - t.lastAt > pauseWait * 0.6) learnPause(Math.max(pauseWait, (now - t.lastAt) * 1.25));
        if (t.prep) { t.prep.p.drop(); t.prep = null; }
        t.verdict = "";
        t.wantEnd = false;
        setStatus("Listening… take your time");
      }
      t.text = text;
      t.lastAt = now;
      t.lastFinal = isFinal;
      clearTimeout(t.prepTimer);
      clearTimeout(t.endTimer);
      // Check sooner after settled words; a customer who pauses a lot gets more room.
      t.prepTimer = setTimeout(prepare, (isFinal ? 0 : 600) + checkDelay);
      t.endTimer = setTimeout(paused, waitFor(full(), isFinal));
    };
    t.finishNow = function () { if (t.text) end(t.verdict === "done" ? t.prep.p : null); };
    t.cancel = function () {
      t.over = true;
      clearTimeout(t.prepTimer);
      clearTimeout(t.endTimer);
      if (t.prep) t.prep.p.drop();
    };
    return t;
  }

  // ---------- speech input ----------
  // The mic keeps going through pauses ("I want a cooker... for my mother...")
  // until turnEnder says they've finished. Chrome stops its recognizer on its
  // own now and then; it's restarted at once and the words kept.
  var listening = null; // { finish(), cancel() } while the mic is taking the customer's turn
  function listen() {
    if (!canListen || busy) return;
    stopBarge();
    stopSpeaking();
    learnPause(pauseWait - 40);
    learnCheck(checkDelay - 20);
    var turn = { text: "", done: false, rec: null, idle: null };
    listening = turn;
    micBtn.classList.add("live");
    setStatus("Listening… take your time");
    function close() {
      turn.done = true;
      clearTimeout(turn.idle);
      if (listening === turn) listening = null;
      if (turn.rec) { turn.rec.onend = turn.rec.onresult = turn.rec.onerror = null; try { turn.rec.abort(); } catch (e) {} }
      recognition = null;
    }
    turn.ender = turnEnder("", function (text, ready) {
      if (turn.done) return ready && ready.drop();
      close();
      micBtn.classList.toggle("live", voiceMode);
      silentRetries = 0;
      input.value = "";
      lastTurn = { text: text };
      send(text, "voice", ready);
    });
    // Tapping the mic: "I'm done" (or put the mic away if nothing was said).
    turn.finish = function () {
      if (turn.text) return turn.ender.finishNow();
      turn.cancel();
      setVoiceMode(false);
    };
    turn.cancel = function () { turn.ender.cancel(); close(); };
    // Nothing said at all for a while: put the mic away.
    turn.idle = setTimeout(turn.finish, 15000);
    function run() {
      if (turn.done) return;
      var rec = new SR();
      turn.rec = recognition = rec;
      rec.lang = cfg.lang;
      rec.interimResults = true;
      rec.continuous = true;
      var before = turn.text; // words from earlier sessions of this turn
      rec.onresult = function (e) {
        var now = "";
        for (var i = 0; i < e.results.length; i++) now += e.results[i][0].transcript + " ";
        turn.text = (before + " " + now).replace(/\s+/g, " ").trim();
        input.value = turn.text;
        clearTimeout(turn.idle);
        turn.ender.heard(turn.text, e.results[e.results.length - 1].isFinal);
      };
      rec.onerror = function (e) {
        if (e.error === "not-allowed" || e.error === "service-not-allowed") {
          turn.cancel();
          setVoiceMode(false);
          setStatus("Microphone access is blocked. Allow it in your browser to talk.");
        }
      };
      // Restart at once, so words said while Chrome resets aren't lost.
      rec.onend = function () { if (!turn.done) run(); };
      try { rec.start(); } catch (e) { setTimeout(run, 150); }
    }
    run();
  }

  function setVoiceMode(on) {
    voiceMode = on;
    if (micBtn) micBtn.classList.toggle("live", on);
    if (!on) {
      if (listening) listening.cancel();
      if (recognition) { recognition.onend = recognition.onresult = null; try { recognition.abort(); } catch (e) {} recognition = null; }
      stopBarge();
      setStatus("");
    }
  }

  // ---------- WhatsApp number check ----------
  // A number, then the 6-digit code sent to it on WhatsApp; done() once confirmed.
  var waiting = null; // the question and reply bubbles of a question waiting for the check
  function verifyCard(done) {
    var old = msgsEl.querySelector(".verify");
    if (old) old.remove();
    var box = document.createElement("div");
    box.className = "verify";
    msgsEl.appendChild(box);
    var phone = "";
    function post(path, data) {
      return fetch(cfg.server + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
        .then(function (r) { return r.json(); })
        .catch(function () { return { error: "Couldn't connect. Please check your internet and try again." }; });
    }
    function numberStep(err) {
      box.innerHTML = "<b>Your WhatsApp number</b>" +
        '<div class="vr"><span class="cc">+91</span><input type="tel" inputmode="numeric" autocomplete="tel-national" maxlength="14" placeholder="10-digit mobile number"><button>Send code</button></div>' +
        '<div class="err">' + esc(err || "") + '</div><div class="note">Used only to confirm it\'s you. We send one WhatsApp message with the code.</div>';
      var inp = box.querySelector("input"), btn = box.querySelector("button");
      inp.value = phone;
      function go() {
        if (btn.disabled) return;
        phone = inp.value.trim();
        btn.disabled = true;
        post("/api/verify/send", { phone: phone, visitor: visitor }).then(function (r) { r.ok ? codeStep() : numberStep(r.error); });
      }
      btn.onclick = go;
      inp.onkeydown = function (e) { if (e.key === "Enter") go(); };
      msgsEl.scrollTop = msgsEl.scrollHeight;
      inp.focus();
    }
    function codeStep(err) {
      box.innerHTML = "<b>Enter the code sent to +91 " + esc(phone.replace(/\D/g, "").slice(-10)) + " on WhatsApp</b>" +
        '<div class="vr"><input type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6-digit code"><button>Confirm</button></div>' +
        '<div class="err">' + esc(err || "") + '</div><button class="lnk">Change number or send again</button>';
      var inp = box.querySelector("input"), btn = box.querySelector("button");
      function go() {
        if (btn.disabled) return;
        btn.disabled = true;
        post("/api/verify/confirm", { phone: phone, code: inp.value.trim(), visitor: visitor }).then(function (r) {
          if (!r.token) return codeStep(r.error);
          verified = r.token;
          try { localStorage.setItem("prestige-chat-verified", r.token); } catch (e) {}
          box.remove();
          done();
        });
      }
      btn.onclick = go;
      inp.oninput = function () { if (/^\d{6}$/.test(inp.value.trim())) go(); };
      inp.onkeydown = function (e) { if (e.key === "Enter") go(); };
      box.querySelector(".lnk").onclick = function () { numberStep(); };
      msgsEl.scrollTop = msgsEl.scrollHeight;
      inp.focus();
    }
    numberStep();
  }

  // ---------- chat ----------
  // ready: an answer prepared while the customer paused (prepareAnswer).
  async function send(text, mode, ready) {
    text = text.trim();
    if (!text || busy) { if (ready) ready.drop(); return; }
    busy = true;
    sendBtn.disabled = true;
    chipsEl.innerHTML = "";
    var resumed = history.length && history[history.length - 1].old;
    history.push({ role: "user", content: text });
    save();
    if (resumed) renderAll();
    var userEl = resumed ? [].slice.call(msgsEl.querySelectorAll(".m.user")).pop() : bubble("user", text);

    var el = bubble("assistant", "");
    el.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
    setStatus(mode === "voice" ? "Thinking…" : "");

    var shouldSpeak = mode === "voice" || speakReplies;
    // The reply text, then optionally \u001e + JSON product cards at the very end.
    var raw = "", full = "", found = null, gated = false, spokenUpTo = 0, spokenBefore = "", streamDone = false, stopped = false, joined = false, sentAt = Date.now();
    var aborter = ready ? ready.aborter : window.AbortController ? new AbortController() : null;
    var me = {
      // Everything read aloud so far, including words said before a lookup
      // cleared the text, so the mic doesn't mistake their echo for the customer.
      text: function () { return spokenBefore + " " + full; },
      // The customer talked over this reply: stop reading and stop fetching it.
      canTakeBack: function () { return !streamDone && (spokenUpTo === 0 || Date.now() - sentAt < 3500); },
      stop: function (cutOff) {
        stopped = true;
        joined = !!cutOff;
        if (aborter) aborter.abort();
        // Already fully received and only being read out: note the interruption.
        var h = history[history.length - 1];
        if (streamDone && h && h.role === "assistant") { h.content += " [the customer interrupted me while I was still speaking]"; save(); }
      },
      mute: function () { shouldSpeak = false; if (streamDone && current === me) current = null; },
    };
    current = me;
    if (mode === "voice") startBarge();

    // Speak finished sentences while the rest is still streaming in.
    function speakReady(final) {
      if (!shouldSpeak) return;
      var rest = full.slice(spokenUpTo);
      var cut = final ? rest.length : (function () {
        var m, last = -1, re = /[.!?।](\s|$)|\n/g;
        while ((m = re.exec(rest))) last = m.index + 1;
        return last;
      })();
      if (cut > 0) {
        var chunk = rest.slice(0, cut);
        spokenUpTo += cut;
        speak(chunk, afterSpeech);
      } else if (final) {
        afterSpeech();
      }
    }
    function afterSpeech() {
      if (stopped || current !== me) return;
      if (streamDone && speakQueue === 0) {
        current = null;
        setStatus("");
        if (voiceMode) listen();
      }
    }

    function take(piece) {
      raw += piece;
      // \u0007: the free questions are used up; ask for a WhatsApp number.
      if (raw.indexOf("\u0007") >= 0) { gated = true; raw = raw.replace("\u0007", ""); }
      // \u001f: the assistant looked something up; drop what it wrote before.
      var clear = raw.lastIndexOf("\u001f");
      if (clear >= 0) { spokenBefore += " " + full.slice(0, spokenUpTo); raw = raw.slice(clear + 1); spokenUpTo = 0; }
      full = raw.split("\u001e")[0];
      el.innerHTML = md(full);
      msgsEl.scrollTop = msgsEl.scrollHeight;
      speakReady(false);
    }
    try {
      var reader = null, dec = null;
      if (ready) {
        reader = ready.reader;
        dec = ready.dec;
      } else {
        var res = await fetch(cfg.server + "/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: context(), mode: mode, visitor: visitor, verified: verified }),
          signal: aborter ? aborter.signal : undefined,
        });
        if (!res.ok || !res.body) full = (await res.text()) || "Sorry, something went wrong. Please try again.";
        else { reader = res.body.getReader(); dec = new TextDecoder(); }
      }
      if (reader) {
        if (mode === "voice") setStatus("Speaking… just talk to interrupt");
        if (ready && ready.leftover) take(ready.leftover);
        while (!stopped) {
          var r = await reader.read();
          if (r.done) break;
          take(dec.decode(r.value, { stream: true }));
        }
      }
    } catch (e) {
      if (!stopped) full = "Sorry, I couldn't connect. Please check your internet and try again.";
    }

    if (stopped && joined) {
      // They were cut off mid-sentence: take back this half question and the
      // start of the reply; the whole sentence is sent once they finish.
      el.remove();
      userEl.remove();
      if (history.length && history[history.length - 1].role === "user") history.pop();
      save();
      busy = false;
      if (current === me) current = null;
      return;
    }
    if (stopped) {
      // Keep what was shown, and tell the assistant where the customer cut in,
      // so it doesn't assume they heard the rest.
      el.innerHTML = md(full) + (full ? " …" : "");
      if (!full) el.remove();
      else {
        history.push({ role: "assistant", content: full.slice(0, Math.max(spokenUpTo, 1)) + " … [the customer interrupted me here]" });
        save();
      }
      busy = false;
      sendBtn.disabled = !input.value.trim();
      if (current === me) current = null;
      return;
    }

    if (gated) {
      // Not an answer: the question waits, unanswered, until the number is confirmed.
      el.innerHTML = md(full);
      history.pop();
      save();
      busy = false;
      sendBtn.disabled = !input.value.trim();
      streamDone = true;
      var wasVoice = voiceMode;
      if (voiceMode) setVoiceMode(false);
      // Asked again before confirming: only the latest waiting question stays.
      if (waiting) waiting.forEach(function (n) { n.remove(); });
      waiting = [userEl, el];
      verifyCard(function () {
        waiting = null;
        userEl.remove();
        el.remove();
        if (wasVoice) setVoiceMode(true);
        send(text, mode);
      });
      if (shouldSpeak) speakReady(true);
      else if (current === me) current = null;
      return;
    }
    var cut = raw.indexOf("\u001e");
    if (cut >= 0) try { found = JSON.parse(raw.slice(cut + 1)); } catch (e) {}
    el.innerHTML = md(full);
    cards(found);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    history.push(found ? { role: "assistant", content: full, cards: found } : { role: "assistant", content: full });
    save();
    busy = false;
    sendBtn.disabled = !input.value.trim();
    streamDone = true;
    if (shouldSpeak) speakReady(true);
    else {
      if (current === me) current = null;
      if (voiceMode) listen();
      else setStatus("");
    }
  }

  // ---------- events ----------
  launcher.onclick = function () {
    var open = panel.classList.toggle("open");
    launcher.innerHTML = icon(open ? "close" : "chat");
    launcher.classList.toggle("open", open);
    ui.open = open; ui.resume = false; saveUi();
    nudge.classList.remove("on");
    if (open) { track("open"); renderAll(); setTimeout(function () { input.focus(); }, 50); }
    else { setVoiceMode(false); stopSpeaking(); }
  };
  // Reopen as the shopper left it on the previous page.
  if (ui.big) setBig(true);
  if (ui.open) {
    launcher.onclick();
    if (ui.side === "checkout" && onStore) openCheckout();
    else if (ui.side === "cart" && onStore) openCart();
    else if (ui.product) openProduct(ui.product);
  } else if (history.length && (ui.resume || ui.open === undefined)) {
    // Back on the store (after buying, a new tab or another day) with a saved chat.
    setTimeout(function () { nudge.classList.add("on"); }, 1200);
  }
  nudge.onclick = function () { launcher.onclick(); };
  nudge.onkeydown = function (e) { if (e.key === "Enter") launcher.onclick(); };
  $(".nudge .x").onclick = function (e) {
    e.stopPropagation();
    nudge.classList.remove("on");
    ui.open = false; ui.resume = false; saveUi();
  };
  // Keep tabs in step: a message sent in one tab shows up in the others.
  window.addEventListener("storage", function (e) {
    if (e.key !== STORE_KEY || busy) return;
    history = load();
    if (panel.classList.contains("open")) renderAll();
  });
  $(".close").onclick = function () { launcher.onclick(); };
  $(".back").onclick = closeProduct;
  if (cartBtn) {
    cartBtn.onclick = openCart;
    cart.load().catch(function () {});
  }
  if (expandBtn) expandBtn.onclick = function () { setBig(!panel.classList.contains("big")); };
  // Product links and cards open inside the chat instead of leaving it.
  msgsEl.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a");
    if (!a || !/^https:\/\/shop\.ttkprestige\.com\/[^?#]+\.html$/.test(a.href)) return;
    e.preventDefault();
    openProduct(a.href);
  });
  root.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && pv.classList.contains("on")) closeProduct();
  });
  $(".reset").onclick = function () {
    setVoiceMode(false); stopSpeaking();
    history = []; save(); renderAll();
  };
  if (speakerBtn) speakerBtn.onclick = function () {
    unlockAudio();
    speakReplies = !speakReplies;
    speakerBtn.classList.toggle("off", !speakReplies);
    if (!speakReplies) stopSpeaking();
  };
  if (micBtn) micBtn.onclick = function () {
    // Tapping the mic while the assistant is answering means "let me talk".
    if (current) {
      unlockAudio();
      current.stop();
      current = null;
      stopBarge();
      stopSpeaking();
      if (!voiceMode) setVoiceMode(true);
      silentRetries = 0;
      (function go(tries) {
        if (busy && tries < 30) return setTimeout(function () { go(tries + 1); }, 100);
        listen();
      })(0);
      return;
    }
    // Tapping while it listens: "I'm done, answer me" (or put the mic away if nothing was said).
    if (listening) { listening.finish(); return; }
    if (voiceMode) { setVoiceMode(false); stopSpeaking(); return; }
    unlockAudio();
    setVoiceMode(true);
    silentRetries = 0;
    listen();
  };
  input.oninput = function () {
    sendBtn.disabled = busy || !input.value.trim();
    // Starting to type while the assistant is talking: stop talking, switch to text.
    // (Words the mic hears are put in the box by code, which fires no input event.)
    if (input.value) {
      if (current) current.mute();
      stopSpeaking();
      if (voiceMode) setVoiceMode(false);
    }
  };
  form.onsubmit = function (e) {
    e.preventDefault();
    unlockAudio();
    var t = input.value;
    input.value = "";
    sendBtn.disabled = true;
    send(t, "text");
  };

  function icon(name) {
    var p = {
      chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M9 11h.01M12 11h.01M15 11h.01" stroke-width="3"/>',
      close: '<path d="M18 6 6 18M6 6l12 12"/>',
      mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
      send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/>',
      speaker: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
      reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
      expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
      shrink: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
      back: '<path d="M15 18l-6-6 6-6"/>',
      cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.7 12.4a1.5 1.5 0 0 0 1.5 1.1h8.6a1.5 1.5 0 0 0 1.5-1.1L21 7H6"/>',
    }[name];
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + "</svg>";
  }
})();
