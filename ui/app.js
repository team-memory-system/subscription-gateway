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

function loginRow(entry) {
  const row = el("div", "row");
  row.append(el("div", "name", entry.label));
  row.append(el("span", `badge ${entry.loggedIn ? "on" : "off"}`, entry.loggedIn ? "로그인됨" : "로그인 안 됨"));
  const parts = [];
  if (entry.method) parts.push(entry.method);
  if (entry.plan) parts.push(entry.plan);
  if (entry.account) parts.push(entry.account);
  if (!entry.cliAvailable) parts.push(entry.error || "명령을 찾을 수 없습니다");
  else if (entry.error) parts.push(entry.error);
  parts.push(entry.directory);
  row.append(el("div", "detail", parts.join("  ·  ")));

  const buttons = el("div", "buttons");
  if (entry.loggedIn) {
    buttons.append(button("로그아웃", "", async () => {
      const result = await call("/api/logout", { backend: entry.backend });
      say(result.ok ? "" : result.error || "로그아웃하지 못했습니다");
      await refresh();
    }));
  } else if (entry.cliAvailable) {
    buttons.append(button("로그인", "primary", async () => {
      const result = await call("/api/login", { backend: entry.backend });
      if (!result.ok) return say(result.error || "로그인을 시작하지 못했습니다");
      say(`${entry.label} 로그인을 브라우저에서 끝내 주세요. 끝나면 이 화면이 알아서 바뀝니다.`);
      watchFor(() => entry.backend);
    }));
  }
  row.append(buttons);
  return row;
}

function serviceRow(entry) {
  const row = el("div", "row");
  row.append(el("div", "name", entry.label));
  row.append(el("span", `badge ${entry.running ? "on" : "off"}`, entry.running ? "실행 중" : "멈춤"));
  const parts = [entry.url];
  if (entry.running && !entry.managed) parts.push("이 화면이 시작한 것이 아닙니다");
  if (!entry.dependenciesReady) parts.push("의존성 미설치");
  if (!entry.running && entry.health && entry.health.error) parts.push(entry.health.error);
  row.append(el("div", "detail", parts.join("  ·  ")));

  const buttons = el("div", "buttons");
  if (entry.running) {
    buttons.append(button("정지", "", async () => {
      const result = await call("/api/stop", { service: entry.name });
      say(result.ok ? "" : result.error || (result.unmanaged ? "이 화면이 시작하지 않은 서비스라서 정지할 수 없습니다" : "정지하지 못했습니다"));
      await refresh();
    }));
  } else {
    buttons.append(button("시작", "primary", async () => {
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
    target.append(el("p", "muted", "라우터가 아는 모델이 없습니다. 백엔드가 모델 목록을 내주는지 보세요."));
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

async function refresh() {
  const report = await call("/api/status");
  if (!report.ok) {
    say(report.error || "상태를 읽지 못했습니다");
    return report;
  }
  document.getElementById("app-home").textContent = report.appHome;
  const logins = document.getElementById("logins");
  logins.textContent = "";
  for (const entry of Object.values(report.logins)) logins.append(loginRow(entry));
  const services = document.getElementById("services");
  services.textContent = "";
  for (const entry of report.services) services.append(serviceRow(entry));
  fillModelChoices(renderModels(report.models));
  return report;
}

/**
 * A login finishes in the browser, so the screen cannot be told; it has to look.
 * Polling stops as soon as the backend reports a login, and gives up after five
 * minutes so an abandoned login does not leave a timer running.
 */
function watchFor(pickBackend) {
  if (polling) clearInterval(polling);
  const deadline = Date.now() + 5 * 60 * 1000;
  polling = setInterval(async () => {
    const report = await refresh();
    const name = pickBackend();
    if (report.ok && report.logins[name] && report.logins[name].loggedIn) {
      clearInterval(polling);
      polling = null;
      say("");
      return;
    }
    if (Date.now() > deadline) {
      clearInterval(polling);
      polling = null;
      say("로그인이 5분 안에 끝나지 않았습니다. 다시 눌러 주세요.");
    }
  }, 3000);
}

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
