"use strict";

const STORAGE_KEY = "oc_posts_v1";
const USER_KEY = "oc_user_v1";
const THEME_KEY = "oc_theme_v1";
const DRAFT_KEY = "oc_draft_v1";

const MAX_POST = 2000;
const MAX_COMMENT = 1000;
const PREVIEW_CHARS = 280;
const VISIBLE_COMMENTS = 2;

const REACTIONS = {
  like:  { emoji: "👍", label: "Like",  color: "#1e63b4" },
  love:  { emoji: "❤️", label: "Love",  color: "#e0245e" },
  haha:  { emoji: "😆", label: "Haha",  color: "#e8a317" },
  wow:   { emoji: "😮", label: "Wow",   color: "#e8a317" },
  sad:   { emoji: "😢", label: "Sad",   color: "#e8a317" },
  angry: { emoji: "😡", label: "Angry", color: "#e9710f" },
};

let posts = load();
let currentUser = localStorage.getItem(USER_KEY) || "";

const ui = {
  query: "",
  filter: "all",
  sort: "newest",
  openReplyForms: new Set(),
  expandedThreads: new Set(),
  expandedPosts: new Set(),
  editingId: null,
  drafts: {},
  pendingFocus: null,
  popId: null,
};

function load() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    for (const p of data) {
      p.reactions ||= {};
      p.comments ||= [];
      p.savedBy ||= [];
    }
    return data;
  } catch {
    return [];
  }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(posts));
}

window.addEventListener("storage", (e) => {
  if (e.key === STORAGE_KEY) { posts = load(); render(); }
});

const $ = (sel, root = document) => root.querySelector(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "style") node.style.cssText = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function avatar(name, small = false) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const h = Math.abs(hash);
  const hue = 160 + (h % 60);
  const sat = 45 + ((h >> 4) % 20);
  const light = 38 + ((h >> 8) % 14);
  return el("div", {
    class: "avatar" + (small ? " sm" : ""),
    style: `background:hsl(${hue},${sat}%,${light}%)`,
    title: name,
  }, name.trim().charAt(0).toUpperCase() || "?");
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "Just now";
  const m = Math.floor(s / 60); if (m < 60) return m + "m";
  const h = Math.floor(m / 60); if (h < 24) return h + "h";
  const d = Math.floor(h / 24); if (d < 7) return d + "d";
  return new Date(ts).toLocaleDateString();
}
const fullDate = (ts) => new Date(ts).toLocaleString();

function findById(id, list = posts) {
  for (const item of list) {
    if (item.id === id) return { item, parentList: list };
    const children = item.comments || item.replies;
    if (children) {
      const found = findById(id, children);
      if (found) return found;
    }
  }
  return null;
}

const childrenOf = (item) => item.comments || item.replies || [];
const countComments = (list) => list.reduce((n, c) => n + 1 + countComments(c.replies || []), 0);

function autoGrow(ta) {
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
}

const TOKEN_RE = /(https?:\/\/[^\s<]+|#[\p{L}\p{N}_]+|@[\p{L}\p{N}_]+)/gu;
function richText(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    let tok = m[0];
    let trailing = "";
    if (tok.startsWith("#")) {
      out.push(el("button", { class: "tag", title: `Search ${tok}`, onclick: () => setQuery(tok) }, tok));
    } else if (tok.startsWith("@")) {
      out.push(el("button", { class: "mention", title: `Search ${tok.slice(1)}`, onclick: () => setQuery(tok.slice(1)) }, tok));
    } else {
      trailing = tok.match(/[.,!?;:)\]]+$/)?.[0] || "";
      tok = tok.slice(0, tok.length - trailing.length);
      out.push(el("a", { class: "link", href: tok, target: "_blank", rel: "noopener noreferrer" }, tok));
      if (trailing) out.push(trailing);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function toast(message, { action, onAction, duration = 4000 } = {}) {
  const host = $("#toasts");
  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    t.classList.add("leaving");
    setTimeout(() => t.remove(), 250);
  };
  const t = el("div", { class: "toast", role: "status" },
    el("span", {}, message),
    action && el("button", { class: "toast-action", onclick: () => { onAction(); dismiss(); } }, action)
  );
  host.append(t);
  while (host.children.length > 3) host.firstElementChild.remove();
  timer = setTimeout(dismiss, duration);
}

function openModal(content, { dismissable = true } = {}) {
  const backdrop = el("div", { class: "modal-backdrop" });
  const box = el("div", { class: "modal", role: "dialog", "aria-modal": "true" }, content);

  function close() {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
  }
  function onKey(e) {
    if (e.key === "Escape" && dismissable) close();
  }

  if (dismissable) {
    box.append(el("button", { class: "modal-close", "aria-label": "Close", onclick: close }, "✕"));
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  }
  document.addEventListener("keydown", onKey);
  backdrop.append(box);
  document.body.append(backdrop);
  return close;
}

function showReactions(id) {
  const item = findById(id)?.item;
  if (!item) return;
  const entries = Object.entries(item.reactions);
  const counts = {};
  for (const [, t] of entries) counts[t] = (counts[t] || 0) + 1;
  const tabDefs = [
    ["all", `All ${entries.length}`],
    ...Object.keys(REACTIONS).filter((t) => counts[t]).map((t) => [t, `${REACTIONS[t].emoji} ${counts[t]}`]),
  ];

  let active = "all";
  const tabs = el("div", { class: "reactor-tabs" });
  const list = el("div", { class: "reactor-list" });

  function draw() {
    tabs.replaceChildren(...tabDefs.map(([key, label]) =>
      el("button", {
        class: "reactor-tab" + (key === active ? " active" : ""),
        onclick: () => { active = key; draw(); },
      }, label)
    ));
    list.replaceChildren(...entries
      .filter(([, t]) => active === "all" || t === active)
      .map(([name, t]) => el("div", { class: "reactor" },
        avatar(name, true),
        el("span", { class: "reactor-name" }, name, name === currentUser && el("span", { class: "you" }, " (you)")),
        el("span", { class: "reactor-emoji", title: REACTIONS[t].label }, REACTIONS[t].emoji)
      ))
    );
  }
  draw();
  openModal(el("div", {}, el("h2", {}, "Reactions"), tabs, list));
}

function showShortcuts() {
  const row = (keys, desc) => el("li", {}, el("span", {}, desc), el("span", {}, keys.map((k) => el("kbd", {}, k))));
  openModal(el("div", {},
    el("h2", {}, "Keyboard shortcuts"),
    el("ul", { class: "shortcut-list" },
      row(["N"], "Write a new post"),
      row(["/"], "Search"),
      row(["Ctrl", "Enter"], "Publish post / save edit"),
      row(["Esc"], "Cancel edit, close reply or dialog"),
      row(["?"], "Show this help"),
    ),
    el("p", { class: "modal-note" }, "Tip: double-click a post to ❤️ it.")
  ));
}

function askName() {
  const first = !currentUser;
  const input = el("input", { type: "text", placeholder: "Your name", maxlength: "40", "aria-label": "Your name" });
  input.value = currentUser;
  let close;
  const form = el("form", {
    onsubmit: (e) => {
      e.preventDefault();
      const name = input.value.trim().replace(/\s+/g, " ");
      if (!name) { input.focus(); return; }
      const changed = name !== currentUser;
      currentUser = name;
      localStorage.setItem(USER_KEY, name);
      ui.editingId = null;
      close();
      render();
      if (changed) toast(first ? `Welcome, ${name}! 👋` : `Now posting as ${name}`);
    },
  },
    el("h2", {}, first ? "Welcome 👋" : "Switch user"),
    el("p", {}, "Choose a display name to post, comment, reply and react."),
    input,
    el("button", { class: "btn-primary", type: "submit" }, "Continue")
  );
  close = openModal(form, { dismissable: !first });
  input.focus();
  input.select();
}

const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
let themePref = localStorage.getItem(THEME_KEY) || "auto";
const THEME_ICONS = { auto: "🌓", light: "☀️", dark: "🌙" };

function applyTheme() {
  const dark = themePref === "dark" || (themePref === "auto" && themeMedia.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const btn = $("#themeBtn");
  btn.textContent = THEME_ICONS[themePref];
  btn.title = `Theme: ${themePref} (click to change)`;
}

function cycleTheme() {
  themePref = { auto: "light", light: "dark", dark: "auto" }[themePref];
  localStorage.setItem(THEME_KEY, themePref);
  applyTheme();
  toast(`Theme: ${themePref === "auto" ? "match system" : themePref}`, { duration: 1800 });
}
themeMedia.addEventListener("change", applyTheme);

function createPost(text) {
  posts.unshift({
    id: uid(), author: currentUser, text, createdAt: Date.now(),
    reactions: {}, comments: [], savedBy: [],
  });
  if (ui.query || ui.filter === "saved") clearFilters(false);
  save();
  render();
  toast("Post published");
}

function addComment(targetId, text) {
  const found = findById(targetId);
  if (!found) return;
  childrenOf(found.item).push({
    id: uid(), author: currentUser, text, createdAt: Date.now(),
    reactions: {}, replies: [],
  });
  ui.openReplyForms.delete(targetId);
  save();
  render();
}

function toggleReaction(targetId, type) {
  const found = findById(targetId);
  if (!found) return;
  const r = found.item.reactions;
  if (r[currentUser] === type) delete r[currentUser];
  else r[currentUser] = type;
  ui.popId = targetId;
  save();
  render();
}

function quickLove(id) {
  const item = findById(id)?.item;
  if (!item) return;
  if (item.reactions[currentUser] !== "love") {
    item.reactions[currentUser] = "love";
    ui.popId = id;
    save();
    render();
  }
  const body = $(`[data-id="${CSS.escape(id)}"] .post-body`);
  if (body) {
    const heart = el("div", { class: "burst", "aria-hidden": "true" }, "❤️");
    body.append(heart);
    setTimeout(() => heart.remove(), 900);
  }
}

function deleteItem(id) {
  const found = findById(id);
  if (!found || found.item.author !== currentUser) return;
  const snapshot = JSON.stringify(posts);
  const isPost = posts.includes(found.item);
  found.parentList.splice(found.parentList.indexOf(found.item), 1);
  if (ui.editingId === id) ui.editingId = null;
  save();
  render();
  toast(isPost ? "Post deleted" : "Comment deleted", {
    action: "Undo",
    duration: 6000,
    onAction: () => {
      posts = JSON.parse(snapshot);
      save();
      render();
      toast("Restored");
    },
  });
}

function startEdit(id) {
  const found = findById(id);
  if (!found || found.item.author !== currentUser) return;
  ui.editingId = id;
  ui.drafts["edit-" + id] = found.item.text;
  ui.pendingFocus = "edit-" + id;
  render();
}

function saveEdit(id) {
  const key = "edit-" + id;
  const text = (ui.drafts[key] || "").trim();
  if (!text) { toast("Text can't be empty"); return; }
  const found = findById(id);
  if (found && found.item.text !== text) {
    found.item.text = text;
    found.item.edited = true;
    save();
    toast("Changes saved");
  }
  delete ui.drafts[key];
  ui.editingId = null;
  render();
}

function cancelEdit() {
  if (!ui.editingId) return;
  delete ui.drafts["edit-" + ui.editingId];
  ui.editingId = null;
  render();
}

function toggleSave(id) {
  const p = posts.find((p) => p.id === id);
  if (!p) return;
  const i = p.savedBy.indexOf(currentUser);
  if (i >= 0) {
    p.savedBy.splice(i, 1);
    toast("Removed from saved");
  } else {
    p.savedBy.push(currentUser);
    toast("Post saved", { action: "View saved", onAction: () => setFilter("saved") });
  }
  save();
  render();
}

async function sharePost(id) {
  const p = posts.find((p) => p.id === id);
  if (!p) return;
  const text = `${p.author} wrote:\n${p.text}`;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = el("textarea", { style: "position:fixed;opacity:0" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast("Post copied to clipboard 📋");
}

function toggleReply(id) {
  if (ui.openReplyForms.has(id)) {
    ui.openReplyForms.delete(id);
  } else {
    ui.openReplyForms.add(id);
    ui.expandedThreads.add(id);
    ui.pendingFocus = "form-" + id;
  }
  render();
}

function focusInput(key) {
  const input = $(`[data-focus="${CSS.escape(key)}"]`);
  if (!input) return;
  input.scrollIntoView({ behavior: "smooth", block: "center" });
  input.focus({ preventScroll: true });
}

function setQuery(q) {
  ui.query = q;
  $("#searchInput").value = q;
  render();
  $(".toolbar").scrollIntoView({ behavior: "smooth", block: "start" });
}

function setFilter(f) {
  ui.filter = f;
  render();
}

function clearFilters(rerender = true) {
  ui.query = "";
  ui.filter = "all";
  $("#searchInput").value = "";
  if (rerender) render();
}

function matches(item, q) {
  return item.text.toLowerCase().includes(q)
    || item.author.toLowerCase().includes(q)
    || childrenOf(item).some((c) => matches(c, q));
}

function visiblePosts() {
  const q = ui.query.trim().toLowerCase();
  const list = posts.filter((p) => {
    if (ui.filter === "mine" && p.author !== currentUser) return false;
    if (ui.filter === "saved" && !p.savedBy.includes(currentUser)) return false;
    return !q || matches(p, q);
  });
  const score = {
    newest: (p) => p.createdAt,
    top: (p) => Object.keys(p.reactions).length,
    discussed: (p) => countComments(p.comments),
  }[ui.sort];
  return list.sort((a, b) => score(b) - score(a) || b.createdAt - a.createdAt);
}

function reactionSummary(reactions) {
  const entries = Object.entries(reactions);
  if (!entries.length) return null;
  const counts = {};
  for (const [, type] of entries) counts[type] = (counts[type] || 0) + 1;
  const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 3);
  const who = entries.map(([name, t]) => `${REACTIONS[t].emoji} ${name}`).join("\n");
  return { top, total: entries.length, who };
}

function closePickers() {
  document.querySelectorAll(".picker.open").forEach((p) => p.classList.remove("open"));
}

function reactionPicker(item, buttonClass, inline) {
  const mine = item.reactions[currentUser];
  const r = mine && REACTIONS[mine];
  const label = inline
    ? (r ? r.label : "Like")
    : (r ? [r.emoji, " " + r.label] : ["👍", " Like"]);

  const picker = el("div", { class: "picker", role: "menu" },
    Object.entries(REACTIONS).map(([type, rx]) =>
      el("button", {
        title: rx.label, "aria-label": rx.label, role: "menuitem",
        onclick: () => toggleReaction(item.id, type),
      }, rx.emoji)
    )
  );

  const btn = el("button", {
    class: buttonClass + (mine ? " active" : "") + (ui.popId === item.id ? " pop" : ""),
    style: r ? `color:${r.color}` : null,
    "aria-pressed": String(!!mine),
  }, label);

  let timer = null;
  let longPressed = false;
  btn.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    longPressed = false;
    timer = setTimeout(() => {
      longPressed = true;
      closePickers();
      picker.classList.add("open");
    }, 450);
  });
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) {
    btn.addEventListener(ev, () => clearTimeout(timer));
  }
  btn.addEventListener("contextmenu", (e) => { if (longPressed) e.preventDefault(); });
  btn.addEventListener("click", () => {
    if (longPressed) { longPressed = false; return; }
    toggleReaction(item.id, mine || "like");
  });

  return el("div", { class: "react-wrap" + (inline ? " inline" : "") }, picker, btn);
}

function editBox(item, small = false) {
  const key = "edit-" + item.id;
  const ta = el("textarea", {
    class: "edit-input" + (small ? " sm" : ""),
    "data-focus": key, rows: "2", "aria-label": "Edit text",
    maxlength: String(small ? MAX_COMMENT : MAX_POST),
  });
  ta.value = ui.drafts[key] ?? item.text;
  ta.addEventListener("input", () => { ui.drafts[key] = ta.value; autoGrow(ta); });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveEdit(item.id); }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelEdit(); }
  });
  return el("div", { class: "edit-box" },
    ta,
    el("div", { class: "edit-actions" },
      el("span", { class: "hint" }, "Esc to cancel · Ctrl+Enter to save"),
      el("button", { class: "btn-ghost", onclick: cancelEdit }, "Cancel"),
      el("button", { class: "btn-primary btn-sm", onclick: () => saveEdit(item.id) }, "Save")
    )
  );
}

function commentForm(targetId, placeholder) {
  const key = "form-" + targetId;
  const input = el("input", {
    type: "text", placeholder, "data-focus": key,
    maxlength: String(MAX_COMMENT), "aria-label": placeholder,
  });
  input.value = ui.drafts[key] || "";
  const btn = el("button", { type: "submit" }, "Send");
  btn.disabled = !input.value.trim();
  input.addEventListener("input", () => {
    ui.drafts[key] = input.value;
    btn.disabled = !input.value.trim();
  });
  return el("form", {
    class: "comment-form",
    onsubmit: (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      delete ui.drafts[key];
      addComment(targetId, text);
    },
  }, avatar(currentUser, true), input, btn);
}

function commentList(parentId, list, noun) {
  const showAll = ui.expandedThreads.has(parentId) || ui.query;
  const hidden = showAll ? 0 : Math.max(0, list.length - VISIBLE_COMMENTS);
  return [
    hidden > 0 && el("button", {
      class: "view-more",
      onclick: () => { ui.expandedThreads.add(parentId); render(); },
    }, `View ${hidden} more ${hidden === 1 ? noun : noun === "reply" ? "replies" : noun + "s"}`),
    list.slice(hidden).map(renderComment),
  ];
}

function renderComment(c) {
  const isMine = c.author === currentUser;
  const replyOpen = ui.openReplyForms.has(c.id);
  const editing = ui.editingId === c.id;
  const summary = reactionSummary(c.reactions);

  return el("div", { class: "comment", "data-id": c.id },
    avatar(c.author, true),
    el("div", { class: "comment-main" },
      editing
        ? editBox(c, true)
        : el("div", { class: "bubble-row" },
            el("div", { class: "bubble" },
              el("button", { class: "name", title: `Search ${c.author}`, onclick: () => setQuery(c.author) }, c.author),
              richText(c.text),
              summary && el("button", {
                class: "bubble-reactions", title: summary.who,
                onclick: () => showReactions(c.id),
              }, summary.top.map((t) => REACTIONS[t].emoji).join("") + " " + summary.total)
            )
          ),
      !editing && el("div", { class: "comment-actions" },
        reactionPicker(c, "btn-link", true),
        el("button", { class: "btn-link" + (replyOpen ? " active" : ""), onclick: () => toggleReply(c.id) }, "Reply"),
        isMine && el("button", { class: "btn-link", onclick: () => startEdit(c.id) }, "Edit"),
        isMine && el("button", { class: "btn-link danger", onclick: () => deleteItem(c.id) }, "Delete"),
        el("span", { title: fullDate(c.createdAt) }, timeAgo(c.createdAt) + (c.edited ? " · Edited" : ""))
      ),
      (c.replies.length || replyOpen) && el("div", { class: "replies" },
        commentList(c.id, c.replies, "reply"),
        replyOpen && commentForm(c.id, `Reply to ${c.author}…`)
      )
    )
  );
}

function postBody(p) {
  const cut = p.text.length > PREVIEW_CHARS && !ui.expandedPosts.has(p.id);
  return el("div", {
    class: "post-body",
    title: "Double-click to ❤️",
    ondblclick: (e) => {
      if (e.target.closest("button, a")) return;
      window.getSelection()?.removeAllRanges();
      quickLove(p.id);
    },
  },
    richText(cut ? p.text.slice(0, PREVIEW_CHARS).trimEnd() + "… " : p.text),
    cut && el("button", {
      class: "see-more",
      onclick: () => { ui.expandedPosts.add(p.id); render(); },
    }, "See more")
  );
}

function renderPost(p) {
  const isMine = p.author === currentUser;
  const saved = p.savedBy.includes(currentUser);
  const editing = ui.editingId === p.id;
  const summary = reactionSummary(p.reactions);
  const nComments = countComments(p.comments);

  return el("article", { class: "card post", "data-id": p.id },
    el("div", { class: "post-head" },
      avatar(p.author),
      el("div", { class: "post-meta" },
        el("button", { class: "post-author", title: `Search ${p.author}`, onclick: () => setQuery(p.author) }, p.author),
        el("div", { class: "post-time", title: fullDate(p.createdAt) },
          timeAgo(p.createdAt) + (p.edited ? " · Edited" : ""))
      ),
      el("button", {
        class: "icon-btn" + (saved ? " active" : ""),
        title: saved ? "Remove from saved" : "Save post",
        "aria-pressed": String(saved),
        onclick: () => toggleSave(p.id),
      }, "🔖"),
      isMine && !editing && el("button", { class: "icon-btn", title: "Edit post", onclick: () => startEdit(p.id) }, "✏️"),
      isMine && el("button", { class: "icon-btn", title: "Delete post", onclick: () => deleteItem(p.id) }, "🗑️")
    ),
    editing ? el("div", { class: "post-edit" }, editBox(p)) : postBody(p),
    el("div", { class: "post-stats" },
      summary
        ? el("button", { class: "reaction-summary", title: summary.who, onclick: () => showReactions(p.id) },
            el("span", { class: "emojis" }, summary.top.map((t) => el("span", {}, REACTIONS[t].emoji))),
            el("span", {}, summary.total))
        : el("span"),
      nComments > 0 && el("button", {
        class: "stat-btn",
        onclick: () => { ui.expandedThreads.add(p.id); render(); },
      }, plural(nComments, "comment"))
    ),
    el("div", { class: "post-actions" },
      reactionPicker(p, "action-btn", false),
      el("button", { class: "action-btn", onclick: () => focusInput("form-" + p.id) }, "💬 Comment"),
      el("button", { class: "action-btn", onclick: () => sharePost(p.id) }, "📋 Share")
    ),
    el("div", { class: "comments" },
      commentList(p.id, p.comments, "comment"),
      commentForm(p.id, "Write a comment…")
    )
  );
}

function emptyState() {
  let msg = "No posts yet. Be the first to share something!";
  if (ui.query) msg = `No posts match "${ui.query}".`;
  else if (ui.filter === "saved") msg = "No saved posts yet. Click 🔖 on a post to save it.";
  else if (ui.filter === "mine") msg = "You haven't posted anything yet.";
  return el("div", { class: "card empty" }, msg);
}

function renderFeedInfo(count) {
  const info = $("#feedInfo");
  if (!ui.query && ui.filter === "all") { info.replaceChildren(); return; }
  const where = ui.filter === "saved" ? " in Saved" : ui.filter === "mine" ? " by you" : "";
  info.replaceChildren(
    el("span", {}, plural(count, "post") + (ui.query ? ` matching "${ui.query}"` : "") + where),
    el("button", { class: "btn-link", onclick: () => clearFilters() }, "Clear ✕")
  );
}

function render() {
  const feed = $("#feed");

  const active = document.activeElement;
  const activeKey = active?.dataset?.focus;
  const restoreKey = ui.pendingFocus || activeKey;
  const selection = !ui.pendingFocus && activeKey && typeof active.selectionStart === "number"
    ? [active.selectionStart, active.selectionEnd]
    : null;

  const list = visiblePosts();
  feed.replaceChildren(...(list.length ? list.map(renderPost) : [emptyState()]));
  renderFeedInfo(list.length);

  $("#currentUser").textContent = currentUser;
  $("#composerAvatar").replaceChildren(avatar(currentUser || "?"));
  document.querySelectorAll("#filterTabs .tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.filter === ui.filter));

  feed.querySelectorAll(".edit-input").forEach(autoGrow);

  if (restoreKey) {
    const input = feed.querySelector(`[data-focus="${CSS.escape(restoreKey)}"]`);
    if (input) {
      input.focus({ preventScroll: !ui.pendingFocus });
      const end = input.value.length;
      input.setSelectionRange(...(selection || [end, end]));
    }
  }
  ui.pendingFocus = null;
  ui.popId = null;
}

const postInput = $("#postInput");
const postBtn = $("#postBtn");
const charCount = $("#charCount");
postInput.maxLength = MAX_POST;
postInput.value = localStorage.getItem(DRAFT_KEY) || "";

function updateComposer() {
  const len = postInput.value.length;
  postBtn.disabled = !postInput.value.trim();
  charCount.textContent = len ? `${len} / ${MAX_POST}` : "";
  charCount.classList.toggle("warn", len > MAX_POST * 0.9);
  autoGrow(postInput);
  localStorage.setItem(DRAFT_KEY, postInput.value);
}

postInput.addEventListener("input", updateComposer);
postInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); postBtn.click(); }
});
postBtn.addEventListener("click", () => {
  const text = postInput.value.trim();
  if (!text) return;
  createPost(text);
  postInput.value = "";
  updateComposer();
});

const searchInput = $("#searchInput");
let searchTimer;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { ui.query = searchInput.value.trim(); render(); }, 150);
});

$("#filterTabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (tab) setFilter(tab.dataset.filter);
});

$("#sortSelect").addEventListener("change", (e) => {
  ui.sort = e.target.value;
  render();
});

$("#changeUser").addEventListener("click", askName);
$("#themeBtn").addEventListener("click", cycleTheme);
$("#helpBtn").addEventListener("click", showShortcuts);

document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest(".react-wrap")) closePickers();
});

document.addEventListener("keydown", (e) => {
  if (document.querySelector(".modal-backdrop")) return;
  const target = e.target instanceof Element ? e.target : document.body;
  const typing = target.closest("input, textarea, select, [contenteditable]");

  if (e.key === "Escape") {
    if (ui.editingId) { cancelEdit(); return; }
    const key = target.dataset?.focus;
    if (key?.startsWith("form-") && ui.openReplyForms.has(key.slice(5))) {
      ui.openReplyForms.delete(key.slice(5));
      render();
      return;
    }
    if (target === searchInput && searchInput.value) { clearFilters(); return; }
    if (typing) target.blur();
    closePickers();
    return;
  }

  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "/") { e.preventDefault(); searchInput.focus(); }
  else if (e.key === "n" || e.key === "N") { e.preventDefault(); postInput.focus(); postInput.scrollIntoView({ behavior: "smooth", block: "center" }); }
  else if (e.key === "?") { e.preventDefault(); showShortcuts(); }
});

applyTheme();
updateComposer();
render();
if (!currentUser) askName();

setInterval(() => {
  const busy = document.activeElement?.dataset?.focus
    || ui.editingId
    || document.querySelector(".picker.open, .react-wrap:hover, .modal-backdrop");
  if (!busy) render();
}, 60000);