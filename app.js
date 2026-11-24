(function () {
  "use strict";

  const FIELDS = [
    "Categoria",
    "Descrição",
    "Projeto",
    "Status",
    "Observação",
    "Data conclusão",
    "Recebedor",
    "Preço total"
  ];
  const DEFAULT_COLUMNS = new Set(["Categoria", "Descrição", "Recebedor", "Preço total"]);
  const STATUSES = ["Aberto", "Resolvido", "Cancelado"];
  const BACKEND_URL = "https://script.google.com/macros/s/AKfycbwBEPZ4VDLjlu5YYm_DZ18_wa3UDWSUpKgkmW-Skv-95_uw4TrXOnzIAgCB6yw1ACmb/exec";
  const COLUMN_KEY = "workspace-database-visible-columns";
  const state = {
    records: [],
    pending: new Map(),
    creates: new Set(),
    visibleColumns: new Set(DEFAULT_COLUMNS),
    expanded: new Set(),
    pendingStatus: null,
    busy: false
  };

  const byId = (id) => document.getElementById(id);
  const tableHead = byId("table-head");
  const tableBody = byId("table-body");
  let toastTimer;

  function makeId() {
    return "new-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
  }

  function currentFields(record) {
    return Object.assign({}, record.fields, state.pending.get(record.id) || {});
  }

  function setConnectionStatus(connected, message) {
    const el = byId("connection-status");
    el.textContent = message;
    el.classList.toggle("is-connected", connected);
  }

  function notify(message, isError) {
    const toast = byId("toast");
    toast.textContent = message;
    toast.classList.toggle("is-error", Boolean(isError));
    toast.classList.add("is-visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 4200);
  }

  function escapeText(value) {
    return value == null ? "" : String(value);
  }

  function createElement(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function dialogOpen(dialog) {
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function closeDialog(dialog) {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }

  function renderColumnOptions() {
    const container = byId("column-options");
    container.replaceChildren();
    FIELDS.forEach((field) => {
      const label = createElement("label", "check-option");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = field;
      checkbox.checked = state.visibleColumns.has(field);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) state.visibleColumns.add(field);
        else state.visibleColumns.delete(field);
        localStorage.setItem(COLUMN_KEY, JSON.stringify(Array.from(state.visibleColumns)));
        renderTable();
      });
      label.append(checkbox, document.createTextNode(" " + field));
      container.appendChild(label);
    });
  }

  function matchingRecords() {
    const statuses = new Set(
      Array.from(document.querySelectorAll('input[name="status-filter"]:checked')).map((input) => input.value)
    );
    const onlyProjects = byId("projects-only").checked;
    const query = byId("search-input").value.trim().toLocaleLowerCase("pt-BR");
    return state.records.filter((record) => {
      const fields = currentFields(record);
      if (!statuses.has(fields.Status || "Aberto")) return false;
      if (onlyProjects && !fields.Projeto) return false;
      return !query || FIELDS.some((field) => escapeText(fields[field]).toLocaleLowerCase("pt-BR").includes(query));
    });
  }

  function buildGroups(records) {
    const groups = [];
    const seen = new Map();
    records.forEach((record) => {
      const category = String(currentFields(record).Categoria || "").trim();
      const key = category.toLocaleLowerCase("pt-BR");
      if (!byId("group-categories").checked || !key) {
        groups.push([record]);
        return;
      }
      if (seen.has(key)) {
        groups[seen.get(key)].push(record);
      } else {
        seen.set(key, groups.length);
        groups.push([record]);
      }
    });
    return groups;
  }

  function makeCellEditor(record, field, subtask) {
    const cell = document.createElement("td");
    if (field === "Projeto") cell.className = "project-cell";
    if (field === "Categoria") {
      const wrap = createElement("div", "category-cell");
      if (subtask) wrap.classList.add("is-subtask");
      const value = createInput(record, field);
      value.setAttribute("aria-label", "Categoria");
      if (subtask) wrap.appendChild(createElement("span", "sr-only", "Subtarefa"));
      wrap.appendChild(value);
      cell.appendChild(wrap);
      return cell;
    }
    cell.appendChild(createInput(record, field));
    return cell;
  }

  function createInput(record, field) {
    const values = currentFields(record);
    let input;
    if (field === "Projeto") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = Boolean(values[field]);
      input.setAttribute("aria-label", "Projeto");
      input.addEventListener("change", () => stageField(record, field, input.checked));
      return input;
    }
    if (field === "Status") {
      input = document.createElement("select");
      STATUSES.forEach((status) => {
        const option = document.createElement("option");
        option.value = status;
        option.textContent = status;
        input.appendChild(option);
      });
      input.value = values.Status || "Aberto";
      input.setAttribute("aria-label", "Status");
      input.addEventListener("change", () => {
        const previous = currentFields(record).Status || "Aberto";
        if (input.value !== previous) openStatusDialog(record, input.value, previous);
      });
      return input;
    }
    if (field === "Observação") {
      input = document.createElement("textarea");
      input.rows = 1;
      input.value = escapeText(values[field]);
    } else {
      input = document.createElement("input");
      input.type = field === "Preço total" ? "number" : "text";
      if (field === "Preço total") input.step = "any";
      input.value = escapeText(values[field]);
    }
    input.setAttribute("aria-label", field);
    input.addEventListener("change", () => stageField(record, field, input.value));
    return input;
  }

  function renderTable() {
    const columns = FIELDS.filter((field) => state.visibleColumns.has(field));
    tableHead.replaceChildren();
    columns.forEach((field) => tableHead.appendChild(createElement("th", "", field)));
    tableHead.appendChild(createElement("th", "actions-heading", " "));

    const groups = buildGroups(matchingRecords());
    tableBody.replaceChildren();
    let visibleCount = 0;
    groups.forEach((group) => {
      const [primary] = group;
      const duplicateGroup = group.length > 1 && byId("group-categories").checked;
      const expanded = duplicateGroup && state.expanded.has(primary.id);
      appendRecordRow(primary, columns, false, duplicateGroup, expanded ? group.length - 1 : 0);
      visibleCount += 1;
      if (expanded) {
        group.slice(1).forEach((record) => {
          appendRecordRow(record, columns, true, false, 0);
          visibleCount += 1;
        });
      }
    });
    byId("result-count").textContent = visibleCount + (visibleCount === 1 ? " tarefa" : " tarefas");
    byId("empty-state").hidden = visibleCount > 0;
    updatePendingControls();
  }

  function appendRecordRow(record, columns, subtask, duplicateGroup, hiddenCount) {
    const tr = document.createElement("tr");
    if (subtask) tr.classList.add("subtask-row");
    if (state.creates.has(record.id) || state.pending.has(record.id)) tr.classList.add("pending-row");
    columns.forEach((field) => {
      if (field === "Categoria" && duplicateGroup) {
        const cell = document.createElement("td");
        const wrap = createElement("div", "category-cell");
        const button = createElement("button", "expand-button", state.expanded.has(record.id) ? "−" : "+");
        button.type = "button";
        button.setAttribute("aria-label", state.expanded.has(record.id) ? "Recolher subtarefas" : "Expandir subtarefas");
        button.title = hiddenCount ? hiddenCount + " subtarefa(s)" : "Recolher subtarefas";
        button.addEventListener("click", () => {
          if (state.expanded.has(record.id)) state.expanded.delete(record.id);
          else state.expanded.add(record.id);
          renderTable();
        });
        wrap.append(button, createInput(record, field));
        cell.appendChild(wrap);
        tr.appendChild(cell);
      } else {
        tr.appendChild(makeCellEditor(record, field, subtask));
      }
    });
    const action = document.createElement("td");
    action.setAttribute("aria-hidden", "true");
    tr.appendChild(action);
    tableBody.appendChild(tr);
  }

  function stageField(record, field, value) {
    if (field === "Categoria") {
      const oldCategory = String(currentFields(record).Categoria || "");
      state.records.forEach((candidate) => {
        if (String(currentFields(candidate).Categoria || "") === oldCategory) {
          setPendingValue(candidate, field, value);
        }
      });
    } else {
      setPendingValue(record, field, value);
    }
    renderTable();
  }

  function setPendingValue(record, field, value) {
    if (state.creates.has(record.id)) {
      record.fields[field] = value;
      return;
    }
    const changes = state.pending.get(record.id) || {};
    if (Object.is(record.fields[field], value)) delete changes[field];
    else changes[field] = value;
    if (Object.keys(changes).length) state.pending.set(record.id, changes);
    else state.pending.delete(record.id);
  }

  function openStatusDialog(record, newStatus, oldStatus) {
    state.pendingStatus = { record, newStatus, oldStatus };
    byId("status-observation").value = escapeText(currentFields(record).Observação);
    dialogOpen(byId("status-dialog"));
    window.setTimeout(() => byId("status-observation").focus(), 0);
  }

  function applyStatusChange() {
    const pending = state.pendingStatus;
    if (!pending) return;
    setPendingValue(pending.record, "Status", pending.newStatus);
    setPendingValue(pending.record, "Observação", byId("status-observation").value);
    setPendingValue(pending.record, "Data conclusão", new Date().toISOString());
    state.pendingStatus = null;
    closeDialog(byId("status-dialog"));
    renderTable();
  }

  function cancelStatusChange() {
    state.pendingStatus = null;
    closeDialog(byId("status-dialog"));
    renderTable();
  }

  function createRecord(fields) {
    const record = { id: makeId(), rowNumber: null, fields };
    state.records.unshift(record);
    state.creates.add(record.id);
    return record;
  }

  function hasPendingChanges() {
    return state.pending.size > 0 || state.creates.size > 0;
  }

  function updatePendingControls() {
    const pending = hasPendingChanges();
    byId("save-changes").disabled = !pending || state.busy;
    byId("cancel-changes").disabled = !pending || state.busy;
    byId("save-changes").textContent = state.busy ? "Salvando..." : "Salvar alterações";
  }

  function cancelAllChanges() {
    state.records = state.records.filter((record) => !state.creates.has(record.id));
    state.pending.clear();
    state.creates.clear();
    state.expanded.clear();
    renderTable();
    notify("Alterações descartadas.");
  }

  function saveChanges() {
    if (state.busy || !hasPendingChanges()) return;
    const updates = [];
    state.records.forEach((record) => {
      if (state.creates.has(record.id)) return;
      const changes = state.pending.get(record.id);
      if (changes && Object.keys(changes).length) {
        updates.push({
          rowNumber: record.rowNumber,
          expected: record.fields,
          changes
        });
      }
    });
    const newRecords = state.records
      .filter((record) => state.creates.has(record.id))
      .map((record) => record.fields);

    state.busy = true;
    updatePendingControls();
    postRequest(BACKEND_URL, { action: "save", updates, newRecords })
      .then((response) => {
        if (!response || !response.ok) throw new Error(response && response.error ? response.error : "O backend não confirmou a gravação.");
        state.pending.clear();
        state.creates.clear();
        return loadRecords();
      })
      .then(() => notify("Alterações salvas na planilha."))
      .catch((error) => notify("Não foi possível salvar: " + error.message, true))
      .finally(() => {
        state.busy = false;
        updatePendingControls();
      });
  }

  function postRequest(url, payload) {
    return new Promise((resolve, reject) => {
      const nonce = makeId();
      const frame = byId("transport-frame");
      const form = byId("transport-form");
      let timeout;
      const cleanup = () => {
        window.removeEventListener("message", onMessage);
        window.clearTimeout(timeout);
      };
      const onMessage = (event) => {
        if (!event.data || event.data.nonce !== nonce) return;
        let host = "";
        try {
          host = new URL(event.origin).hostname;
        } catch (error) {
          return;
        }
        const fromFrame = event.source === frame.contentWindow;
        const fromAppsScript = host === "script.google.com" ||
          host === "script.googleusercontent.com" ||
          host.endsWith(".script.googleusercontent.com") ||
          host.endsWith("-script.googleusercontent.com");
        if (!fromFrame && !fromAppsScript) return;
        cleanup();
        if (event.data.result && event.data.result.ok) resolve(event.data.result);
        else reject(new Error(event.data.result && event.data.result.error || "Falha ao processar a solicitação."));
      };
      window.addEventListener("message", onMessage);
      timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error("Tempo esgotado aguardando resposta do Apps Script. Verifique a implantação e tente novamente."));
      }, 45000);
      form.action = url;
      form.elements.payload.value = JSON.stringify(Object.assign({}, payload, { nonce }));
      form.submit();
    });
  }

  function loadRecords() {
    setConnectionStatus(false, "Conectando...");
    return jsonp(BACKEND_URL, { action: "list" })
      .then((response) => {
        if (!response || !response.ok || !Array.isArray(response.records)) {
          throw new Error(response && response.error || "Resposta inválida do backend.");
        }
        state.records = response.records.map((item) => ({
          id: "row-" + item.rowNumber,
          rowNumber: item.rowNumber,
          fields: item.fields
        }));
        state.pending.clear();
        state.creates.clear();
        renderTable();
        setConnectionStatus(true, "Conectado à planilha");
      })
      .catch((error) => {
        setConnectionStatus(false, "Falha na conexão");
        notify("Não foi possível carregar a Database: " + error.message, true);
        throw error;
      });
  }

  function jsonp(url, params) {
    return new Promise((resolve, reject) => {
      const callbackName = "__workspaceDatabaseCallback_" + makeId().replace(/-/g, "");
      const script = document.createElement("script");
      const endpoint = new URL(url);
      Object.keys(params).forEach((key) => endpoint.searchParams.set(key, params[key]));
      endpoint.searchParams.set("callback", callbackName);
      const cleanup = () => {
        delete window[callbackName];
        script.remove();
        window.clearTimeout(timeout);
      };
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error("Tempo esgotado. Verifique a URL e as permissões do Web App."));
      }, 20000);
      window[callbackName] = (data) => {
        cleanup();
        resolve(data);
      };
      script.onerror = () => {
        cleanup();
        reject(new Error("Falha ao acessar o Web App. Confira a URL publicada e o acesso."));
      };
      script.src = endpoint.toString();
      document.head.appendChild(script);
    });
  }

  function bindEvents() {
    byId("save-changes").addEventListener("click", saveChanges);
    byId("cancel-changes").addEventListener("click", cancelAllChanges);
    byId("add-task").addEventListener("click", () => dialogOpen(byId("task-dialog")));
    byId("search-input").addEventListener("input", renderTable);
    document.querySelectorAll('input[name="status-filter"]').forEach((input) => input.addEventListener("change", renderTable));
    byId("projects-only").addEventListener("change", renderTable);
    byId("group-categories").addEventListener("change", () => {
      state.expanded.clear();
      renderTable();
    });
    document.querySelectorAll("[data-close]").forEach((button) => {
      button.addEventListener("click", () => closeDialog(byId(button.dataset.close)));
    });
    byId("task-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const formData = new FormData(form);
      const status = String(formData.get("Status") || "Aberto");
      const fields = {
        "Categoria": String(formData.get("Categoria") || "").trim(),
        "Descrição": String(formData.get("Descrição") || "").trim(),
        "Projeto": form.elements.Projeto.checked,
        "Status": status,
        "Observação": String(formData.get("Observação") || ""),
        "Data conclusão": status === "Resolvido" ? new Date().toISOString() : "",
        "Recebedor": String(formData.get("Recebedor") || "").trim(),
        "Preço total": formData.get("Preço total") === "" ? "" : Number(formData.get("Preço total"))
      };
      createRecord(fields);
      form.reset();
      closeDialog(byId("task-dialog"));
      renderTable();
      notify("Tarefa adicionada à lista. Salve para gravar na planilha.");
    });
    byId("status-form").addEventListener("submit", (event) => {
      event.preventDefault();
      applyStatusChange();
    });
    byId("cancel-status").addEventListener("click", cancelStatusChange);
    byId("status-dialog").addEventListener("cancel", () => {
      state.pendingStatus = null;
      renderTable();
    });
    byId("status-dialog").addEventListener("close", () => {
      if (state.pendingStatus) {
        state.pendingStatus = null;
        renderTable();
      }
    });
    byId("task-dialog").addEventListener("cancel", (event) => event.preventDefault());
  }

  function initialize() {
    try {
      const savedColumns = JSON.parse(localStorage.getItem(COLUMN_KEY) || "null");
      if (Array.isArray(savedColumns)) {
        state.visibleColumns = new Set(savedColumns.filter((field) => FIELDS.includes(field)));
      }
    } catch (error) {
      localStorage.removeItem(COLUMN_KEY);
    }
    bindEvents();
    renderColumnOptions();
    renderTable();
    loadRecords().catch(() => {});
  }

  initialize();
})();
