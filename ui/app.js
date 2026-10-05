"use strict";

const notice = document.getElementById("notice");
let polling = null;

function say(message) {
  if (!message) {
    notice.hidden = true;
    notice.textContent = "";
    return;
  }
  notice.hidden = false;
  notice.textContent = message;
}

async function call(path, body) {
  const options = body === undefined
    ? {}
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const response = await fetch(path, options);
  const parsed = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok && !parsed.error) parsed.error = `HTTP ${response.status}`;
  return parsed;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, className, handler) {
  const node = el("button", className, text);
  node.addEventListener("click", async () => {
    const original = node.textContent;
    node.disabled = true;
    node.textContent = "…";
    try {
      await handler();
    } finally {
      node.disabled = false;
      node.textContent = original;
    }
  });
  return node;
}

const MODE_TEXT = {
  drain: { title: "다 쓰고 넘기기", detail: "위 계정부터 한도까지 쓰고, 한도에 걸리면 다음 계정으로 넘어갑니다." },
  balance: { title: "골고루 쓰기", detail: "최근 5시간 동안 가장 덜 쓴 계정부터 씁니다. 한도에 걸린 계정은 풀릴 때까지 뺍니다." },
};

function accountName(account, backends) {
  const backend = backends.find(entry => entry.name === account.backend);
  return `${backend ? backend.label : account.backend} ${account.id.split("-").pop()}`;
}

function clock(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

/** What the router last said about this account, in words. */
function routingText(routing) {
  if (!routing) return "";
  const parts = [];
  if (routing.cooldown_until && new Date(routing.cooldown_until).getTime() > Date.now()) {
    parts.push(`한도에 걸림 · ${clock(routing.cooldown_until)}에 다시 씀`);
  }
  if (Number.isFinite(routing.requests_in_window)) parts.push(`최근 5시간 ${routing.requests_in_window}회`);
  return parts.join("  ·  ");
}

function renderModes(report) {
  const target = document.getElementById("modes");
  target.textContent = "";
  for (const mode of report.modes) {
    const text = MODE_TEXT[mode] || { title: mode, detail: "" };
    const option = el("button", "mode");
    option.type = "button";
    option.setAttribute("role", "radio");
    option.setAttribute("aria-checked", String(report.mode === mode));
    option.append(el("strong", "", text.title), el("span", "", text.detail));
    option.addEventListener("click", async () => {
      if (report.mode === mode) return;
      const result = await call("/api/mode", { mode });
      if (!result.ok) return say(result.error || "방식을 바꾸지 못했습니다");
      // The router reads the mode once, at start; restarting it is what applies it.
      if (report.ready) await connectNow({ quiet: true });
      else await refresh();
    });
    target.append(option);
  }
}

function accountRow(account, siblings, report) {
  const row = el("div", "row");
  const login = account.login || {};
  row.append(el("div", "name", accountName(account, report.backends)));
  row.append(el("span", `badge ${login.loggedIn ? "on" : "off"}`, login.loggedIn ? "로그인됨" : "로그인 안 됨"));
  const cooling = account.routing && account.routing.cooldown_until
    && new Date(account.routing.cooldown_until).getTime() > Date.now();
  if (login.loggedIn && account.service) {
    if (account.service.foreign) row.append(el("span", "badge off", "포트 막힘"));
    else if (cooling) row.append(el("span", "badge wait", "쉬는 중"));
    else row.append(el("span", `badge ${account.service.running ? "on" : "off"}`, account.service.running ? "쓰는 중" : "안 뜸"));
  }

  const parts = [];
  if (login.account) parts.push(login.account);
  if (login.plan) parts.push(login.plan);
  const duplicate = login.account && siblings.some(other =>
    other.id !== account.id && other.login && other.login.account === login.account);
  if (duplicate) parts.push("같은 계정이 두 번 들어가 있습니다");
  if (!login.cliAvailable) parts.push(login.error || `${account.backend} 명령을 찾을 수 없습니다`);
  else if (login.error) parts.push(login.error);
  // Its port is held by a program that refuses this gateway's key, most likely
  // an adapter an earlier install left running: say so, on the account it blocks.
  if (account.service && account.service.foreign && account.service.error) parts.push(account.service.error);
  const routing = routingText(account.routing);
  if (routing) parts.push(routing);
  row.append(el("div", "detail", parts.join("  ·  ")));

  const buttons = el("div", "buttons");
  if (login.loggedIn) {
    buttons.append(button("로그아웃", "", async () => {
      const result = await call("/api/logout", { account: account.id });
      if (!result.ok) return say(result.error || "로그아웃하지 못했습니다");
      // What was serving this account has to go with it.
      await call("/api/stop", { service: account.id });
      await connectNow({ quiet: true });
    }));
  } else if (login.cliAvailable) {
    buttons.append(button("로그인", "primary", async () => {
      const result = await call("/api/login", { account: account.id });
      if (!result.ok) return say(result.error || "로그인을 시작하지 못했습니다");
      startedLogin(account.id, accountName(account, report.backends), result.prompt);
      watchFor(account.id);
    }));
  }
  if (siblings.length > 1) {
    const index = siblings.findIndex(other => other.id === account.id);
    const up = button("↑", "", () => move(account.id, "up"));
    const down = button("↓", "", () => move(account.id, "down"));
    up.title = "먼저 쓰기";
    down.title = "나중에 쓰기";
    if (index === 0) up.disabled = true;
    if (index === siblings.length - 1) down.disabled = true;
    buttons.append(up, down);
  }
  buttons.append(button("삭제", "", async () => {
    const name = accountName(account, report.backends);
    if (!window.confirm(`${name}을 지울까요? 로그아웃하고 이 계정의 로그인 폴더를 지웁니다.`)) return;
    const result = await call("/api/accounts/remove", { account: account.id });
    if (!result.ok) return say(result.error || "지우지 못했습니다");
    await connectNow({ quiet: true });
  }));
  row.append(buttons);
  return row;
}

async function move(id, direction) {
  const result = await call("/api/accounts/move", { account: id, direction });
  if (!result.ok) return say(result.error || "순서를 바꾸지 못했습니다");
  // Order is priority, and the router reads it at start.
  await connectNow({ quiet: true });
}

function renderAccounts(report) {
  const target = document.getElementById("accounts");
  target.textContent = "";
  for (const backend of report.backends) {
    const group = el("div", "group");
    group.append(el("h3", "", backend.label));
    const siblings = report.accounts.filter(account => account.backend === backend.name);
    if (!siblings.length) group.append(el("p", "muted", "아직 계정이 없습니다."));
    const rows = el("div", "rows");
    for (const account of siblings) rows.append(accountRow(account, siblings, report));
    if (siblings.length) group.append(rows);
    group.append(button(`${backend.label} 계정 추가`, siblings.length ? "" : "primary", async () => {
      const result = await call("/api/accounts/add", { backend: backend.name });
      if (!result.ok) {
        await refresh();
        return say(result.error || "계정을 추가하지 못했습니다");
      }
      await refresh();
      startedLogin(result.account.id, accountName(result.account, report.backends), result.login && result.login.prompt);
      watchFor(result.account.id);
    }));
    target.append(group);
  }
}

function serviceRow(entry) {
  const row = el("div", "row");
  row.append(el("div", "name", entry.label));
  row.append(el("span", `badge ${entry.running ? "on" : "off"}`, entry.running ? "실행 중" : entry.foreign ? "포트 막힘" : "멈춤"));
  const parts = [entry.url];
  if (entry.foreign && entry.error) parts.push(entry.error);
  if (entry.running && !entry.managed) parts.push("이 화면이 시작한 것이 아닙니다");
  if (!entry.dependenciesReady) parts.push("의존성 미설치");
  // A stopped service has nothing listening, and the badge already says so. The
  // probe's own words are only worth showing when we started it and it still
  // will not answer, which is a different problem from "not started".
  if (!entry.running && entry.managed && entry.health && entry.health.error) {
    parts.push(`시작했지만 응답이 없습니다: ${entry.health.error}`);
  }
  row.append(el("div", "detail", parts.join("  ·  ")));

  const buttons = el("div", "buttons");
  if (entry.running) {
    buttons.append(button("정지", "", async () => {
      const result = await call("/api/stop", { service: entry.name });
      say(result.ok ? "" : result.error || "정지하지 못했습니다");
      await refresh();
    }));
  } else {
    buttons.append(button("시작", "", async () => {
      const result = await call("/api/start", { service: entry.name });
      say(result.ok ? "" : result.error || "시작하지 못했습니다");
      await refresh();
    }));
  }
  row.append(buttons);
  return row;
}

function renderModels(models) {
  const target = document.getElementById("models");
  target.textContent = "";
  if (!models.ok) {
    target.append(el("p", "muted", models.reason || "모델 목록을 가져오지 못했습니다"));
    return [];
  }
  if (!models.models.length) {
    target.append(el("p", "muted", models.reason || "라우터가 아는 모델이 없습니다."));
    return [];
  }
  for (const model of models.models) {
    const chip = el("div", "chip", model.id);
    if (model.ownedBy) chip.append(el("span", "", `  ${model.ownedBy}`));
    target.append(chip);
  }
  return models.models.map(model => model.id);
}

function fillModelChoices(ids) {
  const select = document.getElementById("chat-model");
  const previous = select.value;
  select.textContent = "";
  for (const id of ids) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = id;
    select.append(option);
  }
  if (ids.includes(previous)) select.value = previous;
  const empty = ids.length === 0;
  select.disabled = empty;
  document.getElementById("chat-send").disabled = empty;
}

function renderHeadline(report) {
  const badge = document.getElementById("connect-badge");
  const text = document.getElementById("connect-text");
  document.getElementById("endpoint-url").textContent = report.endpoint;
  // A login the router does not answer with yet: after a reboot, after a login
  // that finished once the screen stopped watching, or one whose start failed.
  // Only a click starts anything, so a failing adapter is not respawned on every
  // refresh.
  const waiting = report.accounts.filter(account =>
    account.login && account.login.loggedIn && !report.servingAccounts.includes(account.id));
  document.getElementById("connect-now").hidden = waiting.length === 0;
  if (report.connected) {
    badge.className = "badge on";
    badge.textContent = "연결됨";
    const names = report.accounts
      .filter(account => report.servingAccounts.includes(account.id))
      .map(account => accountName(account, report.backends))
      .join(", ");
    const pending = waiting.map(account => accountName(account, report.backends)).join(", ");
    text.textContent = pending
      ? `${names} 로 답합니다. ${pending} 는 아직 안 떴습니다`
      : `${names} 로 답합니다`;
    return;
  }
  badge.className = "badge off";
  badge.textContent = "연결 안 됨";
  text.textContent = report.ready
    ? "로그인은 돼 있는데 아직 안 떴습니다. 연결을 누르세요. 그래도 안 뜨면 자세히에서 이유를 볼 수 있습니다"
    : "아래에서 계정을 추가하고 로그인하세요";
}

async function refresh() {
  const report = await call("/api/status");
  if (!report.ok) {
    say(report.error || "상태를 읽지 못했습니다");
    return report;
  }
  renderHeadline(report);
  document.getElementById("app-home").textContent = report.appHome;
  renderModes(report);
  renderAccounts(report);
  const services = document.getElementById("services");
  services.textContent = "";
  for (const entry of report.services) services.append(serviceRow(entry));
  fillModelChoices(renderModels(report.models));
  return report;
}

/** Logging in is the whole decision; bringing up what it implies is not the user's job. */
async function connectNow({ quiet = false } = {}) {
  if (!quiet) say("연결하는 중입니다…");
  // A body is what makes `call` a POST; without one this was a GET, which the
  // server answers 404, so no login ever led to a connection.
  const result = await call("/api/connect", {});
  await refresh();
  if (result.ok) say("");
  else if (!quiet) say(result.error || "연결하지 못했습니다");
  return result;
}

/**
 * A login finishes in the browser, so the screen cannot be told; it has to look.
 * Once the backend reports a login, connecting follows without another click.
 * Five minutes and it gives up, so an abandoned login leaves no timer running.
 */
function watchFor(accountId) {
  if (polling) clearInterval(polling);
  const deadline = Date.now() + 5 * 60 * 1000;
  polling = setInterval(async () => {
    const report = await refresh();
    const account = report.ok ? report.accounts.find(entry => entry.id === accountId) : null;
    if (account && account.login && account.login.loggedIn) {
      clearInterval(polling);
      polling = null;
      closeLoginPanel(accountId);
      await connectNow();
      return;
    }
    if (account) updateLoginPanel(accountId, account.pendingLogin);
    if (Date.now() > deadline) {
      clearInterval(polling);
      polling = null;
      say("로그인이 5분 안에 끝나지 않았습니다. 다시 눌러 주세요.");
    }
  }, 3000);
}

// ------------------------------------------------------------ login panel
//
// One login at a time, outside the account rows, so a refresh never wipes what
// is being typed. On the same computer the browser finishes the login by itself
// and the panel just closes; from another computer (this screen opened through
// an ssh tunnel) it is where the sign-in link is, and where the code (Claude) or
// the address the browser stopped at (Codex) comes back.

const LOGIN_TEXT = {
  code: {
    hint: "아래 링크를 열어 로그인하세요. 게이트웨이가 도는 컴퓨터의 브라우저라면 그걸로 끝납니다. 다른 컴퓨터라면 로그인 뒤 나오는 코드를 복사해 붙여 넣으세요.",
    label: "코드",
    placeholder: "로그인 페이지에 나온 코드",
    sent: "코드를 보냈습니다. 확인하는 중입니다…",
  },
  callback: {
    hint: "아래 링크를 열어 로그인하세요. 게이트웨이가 도는 컴퓨터의 브라우저라면 그걸로 끝납니다. 다른 컴퓨터라면 로그인 뒤 브라우저가 열지 못한 localhost:1455 주소를 주소창에서 통째로 복사해 붙여 넣으세요.",
    label: "브라우저가 멈춘 주소",
    placeholder: "http://localhost:1455/auth/callback?code=…",
    sent: "주소를 넘겼습니다. 확인하는 중입니다…",
  },
};
let loginPanel = null;

function buildLoginPanel() {
  const panel = el("div", "row");
  panel.id = "login-panel";
  panel.style.display = "grid";
  const title = el("div", "name");
  const hint = el("p", "muted");
  const link = el("a", "mono");
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.style.wordBreak = "break-all";
  const form = el("form");
  const label = el("label");
  label.htmlFor = "login-input";
  const input = el("input");
  input.id = "login-input";
  input.autocomplete = "off";
  input.spellcheck = false;
  const send = el("button", "primary", "보내기");
  send.type = "submit";
  form.append(label, input, send);
  const status = el("p", "muted");
  const cancel = el("button", "", "취소");
  cancel.type = "button";
  panel.append(title, hint, link, form, status, cancel);
  document.getElementById("accounts").after(panel);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const current = loginPanel;
    if (!current || !current.kind || !input.value.trim()) return;
    send.disabled = true;
    try {
      const result = current.kind === "code"
        ? await call("/api/login/code", { account: current.accountId, code: input.value })
        : await call("/api/login/callback", { account: current.accountId, address: input.value });
      if (!result.ok) {
        status.textContent = result.error || "보내지 못했습니다";
        return;
      }
      input.value = "";
      status.textContent = LOGIN_TEXT[current.kind].sent;
      watchFor(current.accountId);
    } finally {
      send.disabled = false;
    }
  });
  cancel.addEventListener("click", async () => {
    const current = loginPanel;
    if (!current) return;
    if (polling) clearInterval(polling);
    polling = null;
    await call("/api/login/cancel", { account: current.accountId });
    closeLoginPanel(current.accountId);
    say("");
  });
  return { panel, title, hint, link, form, label, input, status };
}

/** A screen server from before the panel sends no prompt: then only the old notice. */
function startedLogin(accountId, name, prompt) {
  if (!prompt) return say(`${name} 로그인을 브라우저에서 끝내 주세요. 끝나면 알아서 연결합니다.`);
  say("");
  openLoginPanel(accountId, name, prompt);
}

function openLoginPanel(accountId, name, prompt) {
  if (!loginPanel) loginPanel = buildLoginPanel();
  const view = loginPanel;
  view.accountId = accountId;
  view.kind = null;
  view.panel.hidden = false;
  view.panel.style.display = "grid";
  view.title.textContent = `${name} 로그인`;
  view.input.value = "";
  view.link.removeAttribute("href");
  view.link.textContent = "";
  view.status.textContent = "";
  updateLoginPanel(accountId, prompt);
}

function updateLoginPanel(accountId, prompt) {
  const view = loginPanel;
  if (!view || view.accountId !== accountId || view.panel.hidden) return;
  if (prompt && prompt.url && view.link.getAttribute("href") !== prompt.url) {
    view.link.href = prompt.url;
    view.link.textContent = prompt.url;
  }
  if (!view.link.getAttribute("href")) view.link.textContent = "로그인 주소를 기다리는 중입니다…";
  // The kind is set once; a refresh that finds the CLI gone must not hide a box mid-typing.
  if (!view.kind && prompt && prompt.input && LOGIN_TEXT[prompt.input]) {
    const text = LOGIN_TEXT[prompt.input];
    view.kind = prompt.input;
    view.label.textContent = text.label;
    view.input.placeholder = text.placeholder;
    view.hint.textContent = text.hint;
  }
  view.form.hidden = !view.kind;
  view.form.style.display = view.kind ? "" : "none";
  if (!view.kind) view.hint.textContent = "아래 링크를 게이트웨이가 도는 컴퓨터의 브라우저에서 열어 로그인하세요.";
  if (prompt && prompt.running === false) {
    view.status.textContent = `로그인이 끝났지만 되지 않았습니다${prompt.message ? `: ${prompt.message}` : ""}. 로그인을 다시 누르세요.`;
  }
}

function closeLoginPanel(accountId) {
  if (!loginPanel || (accountId && loginPanel.accountId !== accountId)) return;
  loginPanel.panel.hidden = true;
  loginPanel.panel.style.display = "none";
  loginPanel.accountId = null;
  loginPanel.kind = null;
}

document.getElementById("connect-now").addEventListener("click", async (event) => {
  event.target.disabled = true;
  try {
    await connectNow();
  } finally {
    event.target.disabled = false;
  }
});

document.getElementById("copy-endpoint").addEventListener("click", async (event) => {
  const address = document.getElementById("endpoint-url").textContent;
  try {
    await navigator.clipboard.writeText(address);
    event.target.textContent = "복사됨";
    setTimeout(() => { event.target.textContent = "복사"; }, 1500);
  } catch {
    // Clipboard access is refused in some browsers; selecting it is the fallback.
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("endpoint-url"));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
});

document.getElementById("chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const model = document.getElementById("chat-model").value;
  const prompt = document.getElementById("chat-prompt").value;
  const send = document.getElementById("chat-send");
  const result = document.getElementById("chat-result");
  send.disabled = true;
  send.textContent = "기다리는 중…";
  result.hidden = false;
  result.className = "result";
  result.textContent = "보냈습니다. 어댑터가 CLI 를 돌리기 때문에 몇 분 걸릴 수 있습니다.";
  try {
    const answer = await call("/api/chat", { model, prompt });
    result.textContent = "";
    if (answer.ok) {
      const seconds = (answer.elapsedMs / 1000).toFixed(1);
      result.append(el("span", "meta", `${answer.model}  ·  ${seconds}초`));
      result.append(document.createTextNode(answer.reply));
    } else {
      result.className = "result bad";
      result.append(el("span", "meta", answer.status ? `HTTP ${answer.status}` : "실패"));
      result.append(document.createTextNode(answer.error || "답을 받지 못했습니다"));
    }
  } finally {
    send.disabled = false;
    send.textContent = "보내기";
  }
});

refresh().catch(error => say(String(error && error.message ? error.message : error)));
