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
  const THEME_KEY = "workspace-database-theme";
  const BLANK_VALUE_KEY = "__BLANK_VALUE__";

  const state = {
    records: [],
    pending: new Map(),
    creates: new Set(),
    visibleColumns: new Set(DEFAULT_COLUMNS),
    expanded: new Set(),
    pendingStatus: null,
    busy: false,
    theme: "light",
    columnFilters: new Map(), // field -> Set(allowedValues)
    activeFilterField: null,
    sortField: null,
    sortDirection: null, // "asc" | "desc"
    filterSearchTerm: ""
  };

  const byId = (id) => document.getElementById(id);
  const tableHead = byId("table-head");
  const tableBody = byId("table-body");
  const columnFilterMenu = byId("column-filter-menu");
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

  /* -------------------------------------------------------------
     0. TEMA (MODO ESCURO / MODO CLARO)
     ------------------------------------------------------------- */
  function applyTheme(theme) {
    state.theme = theme;
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
    const themeBtn = byId("theme-toggle");
    const themeText = byId("theme-text");
    const themeIcon = themeBtn.querySelector(".theme-icon");
    const isDark = theme === "dark";
    if (themeText) themeText.textContent = isDark ? "Modo claro" : "Modo escuro";
    if (themeIcon) themeIcon.textContent = isDark ? "☀️" : "🌙";
    themeBtn.setAttribute("aria-pressed", String(isDark));
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.setAttribute("content", isDark ? "#0f1521" : "#f5f7fb");
  }

  function toggleTheme() {
    applyTheme(state.theme === "dark" ? "light" : "dark");
  }

  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "dark" || saved === "light") {
      applyTheme(saved);
    } else {
      const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      applyTheme(prefersDark ? "dark" : "light");
    }
  }

  /* -------------------------------------------------------------
     COLUNAS VISÍVEIS
     ------------------------------------------------------------- */
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

  /* -------------------------------------------------------------
     FILTROS E ORDENAÇÃO
     ------------------------------------------------------------- */
  function getNormalizedFieldValue(val, field) {
    if (field === "Projeto") return Boolean(val);
    if (val == null) return "";
    return String(val).trim();
  }

  function getUniqueFieldValues(field) {
    const values = new Set();
    state.records.forEach((record) => {
      const val = currentFields(record)[field];
      if (field === "Projeto") {
        values.add(Boolean(val) ? "VERDADEIRO" : "FALSO");
      } else {
        const str = val == null ? "" : String(val).trim();
        values.add(str === "" ? BLANK_VALUE_KEY : str);
      }
    });
    return Array.from(values).sort((a, b) => {
      if (a === BLANK_VALUE_KEY) return 1;
      if (b === BLANK_VALUE_KEY) return -1;
      return a.localeCompare(b, "pt-BR", { numeric: true, sensitivity: "base" });
    });
  }

  function matchesColumnFilters(record) {
    if (state.columnFilters.size === 0) return true;
    const fields = currentFields(record);
    for (const [colField, allowedValues] of state.columnFilters.entries()) {
      let valKey;
      if (colField === "Projeto") {
        valKey = Boolean(fields.Projeto) ? "VERDADEIRO" : "FALSO";
      } else {
        const str = fields[colField] == null ? "" : String(fields[colField]).trim();
        valKey = str === "" ? BLANK_VALUE_KEY : str;
      }
      if (!allowedValues.has(valKey)) return false;
    }
    return true;
  }

  function compareRecords(a, b, field, direction) {
    const valA = currentFields(a)[field];
    const valB = currentFields(b)[field];
    let cmp = 0;
    if (field === "Preço total") {
      const numA = (valA === "" || valA == null) ? -Infinity : Number(valA);
      const numB = (valB === "" || valB == null) ? -Infinity : Number(valB);
      cmp = numA - numB;
    } else if (field === "Projeto") {
      cmp = (Boolean(valA) ? 1 : 0) - (Boolean(valB) ? 1 : 0);
    } else {
      const strA = valA == null ? "" : String(valA);
      const strB = valB == null ? "" : String(valB);
      cmp = strA.localeCompare(strB, "pt-BR", { numeric: true, sensitivity: "base" });
    }
    return direction === "desc" ? -cmp : cmp;
  }

  function matchingRecords() {
    const statuses = new Set(
      Array.from(document.querySelectorAll('input[name="status-filter"]:checked')).map((input) => input.value)
    );
    const onlyProjects = byId("projects-only").checked;
    const query = byId("search-input").value.trim().toLocaleLowerCase("pt-BR");

    let filtered = state.records.filter((record) => {
      const fields = currentFields(record);
      if (!statuses.has(fields.Status || "Aberto")) return false;
      if (onlyProjects && !fields.Projeto) return false;
      if (!matchesColumnFilters(record)) return false;
      return !query || FIELDS.some((field) => escapeText(fields[field]).toLocaleLowerCase("pt-BR").includes(query));
    });

    if (state.sortField && state.sortDirection) {
      filtered = filtered.slice().sort((a, b) => compareRecords(a, b, state.sortField, state.sortDirection));
    }

    return filtered;
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

  /* -------------------------------------------------------------
     RENDERIZAÇÃO DAS CÉLULAS E TABELA
     ------------------------------------------------------------- */
  function isCellPending(record, field) {
    if (state.creates.has(record.id)) return true;
    const pendingChanges = state.pending.get(record.id);
    return Boolean(pendingChanges && field in pendingChanges);
  }

  function makeCellEditor(record, field, subtask) {
    const cell = document.createElement("td");
    if (field === "Projeto") cell.className = "project-cell";
    if (isCellPending(record, field)) {
      cell.classList.add("is-pending-cell");
      cell.title = "Alteração pendente não salva";
    }

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

    if (field === "Descrição") {
      const wrap = createElement("div", "desc-cell-wrap");
      const textarea = document.createElement("textarea");
      textarea.className = "desc-textarea";
      textarea.value = escapeText(currentFields(record).Descrição);
      textarea.setAttribute("aria-label", "Descrição");
      textarea.setAttribute("title", "Arraste o canto inferior direito para redimensionar/expandir");
      textarea.addEventListener("change", () => stageField(record, field, textarea.value));
      wrap.appendChild(textarea);
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

  function formatBRL(amount) {
    try {
      return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(amount);
    } catch (e) {
      return "R$ " + amount.toFixed(2);
    }
  }

  function updateResultSummary(records) {
    const summaryContainer = byId("result-summary");
    summaryContainer.replaceChildren();

    let totalPrice = 0;
    let hasPrice = false;
    let projectCount = 0;

    records.forEach((record) => {
      const f = currentFields(record);
      if (f.Projeto) projectCount++;
      if (f["Preço total"] !== "" && f["Preço total"] != null && !isNaN(Number(f["Preço total"]))) {
        totalPrice += Number(f["Preço total"]);
        hasPrice = true;
      }
    });

    if (hasPrice) {
      const pillPrice = createElement("span", "stat-pill stat-price");
      pillPrice.appendChild(document.createTextNode("Total: "));
      const strongPrice = createElement("strong", "", formatBRL(totalPrice));
      pillPrice.appendChild(strongPrice);
      summaryContainer.appendChild(pillPrice);
    }

    const pillProj = createElement("span", "stat-pill stat-projects");
    pillProj.appendChild(document.createTextNode("Projetos: "));
    const strongProj = createElement("strong", "", String(projectCount));
    pillProj.appendChild(strongProj);
    summaryContainer.appendChild(pillProj);
  }

  function renderTableHead(columns) {
    tableHead.replaceChildren();
    columns.forEach((field) => {
      const th = document.createElement("th");
      const content = createElement("div", "th-content");
      const label = createElement("span", "th-label", field);
      content.appendChild(label);

      // Botão de filtro da coluna (estilo Google Sheets)
      const filterBtn = createElement("button", "col-filter-btn", "▼");
      filterBtn.type = "button";
      filterBtn.title = "Filtrar por " + field;
      filterBtn.setAttribute("aria-label", "Filtrar por " + field);
      if (state.columnFilters.has(field)) {
        filterBtn.classList.add("is-active");
        filterBtn.textContent = "✓";
      } else if (state.sortField === field) {
        filterBtn.classList.add("is-active");
        filterBtn.textContent = state.sortDirection === "asc" ? "▲" : "▼";
      }

      filterBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openColumnFilterMenu(field, filterBtn);
      });

      content.appendChild(filterBtn);
      th.appendChild(content);
      tableHead.appendChild(th);
    });
    tableHead.appendChild(createElement("th", "actions-heading", " "));
  }

  function renderTable() {
    const columns = FIELDS.filter((field) => state.visibleColumns.has(field));
    renderTableHead(columns);

    const matched = matchingRecords();
    const groups = buildGroups(matched);
    tableBody.replaceChildren();
    let visibleCount = 0;
    const flatVisibleRecords = [];

    groups.forEach((group) => {
      const [primary] = group;
      const duplicateGroup = group.length > 1 && byId("group-categories").checked;
      const expanded = duplicateGroup && state.expanded.has(primary.id);
      appendRecordRow(primary, columns, false, duplicateGroup, expanded ? group.length - 1 : 0);
      visibleCount += 1;
      flatVisibleRecords.push(primary);
      if (expanded) {
        group.slice(1).forEach((record) => {
          appendRecordRow(record, columns, true, false, 0);
          visibleCount += 1;
          flatVisibleRecords.push(record);
        });
      }
    });

    byId("result-count").textContent = visibleCount + (visibleCount === 1 ? " tarefa" : " tarefas");
    byId("empty-state").hidden = visibleCount > 0;
    updateResultSummary(flatVisibleRecords);
    updatePendingControls();
    updateClearColumnFiltersBtn();
  }

  function appendRecordRow(record, columns, subtask, duplicateGroup, hiddenCount) {
    const tr = document.createElement("tr");
    if (subtask) tr.classList.add("subtask-row");
    if (state.creates.has(record.id) || state.pending.has(record.id)) tr.classList.add("pending-row");
    if (state.creates.has(record.id)) tr.classList.add("is-new-row");

    columns.forEach((field) => {
      if (field === "Categoria" && duplicateGroup) {
        const cell = document.createElement("td");
        if (isCellPending(record, field)) {
          cell.classList.add("is-pending-cell");
          cell.title = "Alteração pendente não salva";
        }
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

  /* -------------------------------------------------------------
     4. MENU DE FILTRO POR COLUNA (GOOGLE SHEETS STYLE)
     ------------------------------------------------------------- */
  let tempSelectedValues = new Set();

  function openColumnFilterMenu(field, buttonEl) {
    state.activeFilterField = field;
    state.filterSearchTerm = "";
    byId("column-filter-title").textContent = "Filtro: " + field;
    byId("column-filter-search").value = "";

    const allValues = getUniqueFieldValues(field);
    if (state.columnFilters.has(field)) {
      tempSelectedValues = new Set(state.columnFilters.get(field));
    } else {
      tempSelectedValues = new Set(allValues);
    }

    renderColumnFilterValuesList(allValues);

    // Posicionar popover
    const rect = buttonEl.getBoundingClientRect();
    columnFilterMenu.hidden = false;
    columnFilterMenu.style.position = "fixed";
    let top = rect.bottom + 6;
    let left = rect.left - 120;
    if (left + 270 > window.innerWidth) left = window.innerWidth - 280;
    if (left < 10) left = 10;
    if (top + 340 > window.innerHeight) top = rect.top - 340;
    if (top < 10) top = 10;

    columnFilterMenu.style.top = top + "px";
    columnFilterMenu.style.left = left + "px";
  }

  function closeColumnFilterMenu() {
    columnFilterMenu.hidden = true;
    state.activeFilterField = null;
  }

  function renderColumnFilterValuesList(allValues) {
    const listContainer = byId("column-filter-values");
    listContainer.replaceChildren();

    const searchTerm = state.filterSearchTerm.toLocaleLowerCase("pt-BR");
    const visibleValues = allValues.filter((val) => {
      const label = val === BLANK_VALUE_KEY ? "(Espaços em branco)" : val;
      return !searchTerm || label.toLocaleLowerCase("pt-BR").includes(searchTerm);
    });

    byId("select-all-values").textContent = "Selecionar tudo (" + visibleValues.length + ")";

    if (visibleValues.length === 0) {
      listContainer.appendChild(createElement("p", "filter-menu-empty", "Nenhum valor correspondente"));
      return;
    }

    visibleValues.forEach((val) => {
      const label = createElement("label", "check-option");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = val;
      checkbox.checked = tempSelectedValues.has(val);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) tempSelectedValues.add(val);
        else tempSelectedValues.delete(val);
      });
      const textLabel = val === BLANK_VALUE_KEY ? "(Espaços em branco)" : val;
      label.append(checkbox, document.createTextNode(" " + textLabel));
      listContainer.appendChild(label);
    });
  }

  function updateClearColumnFiltersBtn() {
    const btn = byId("clear-column-filters");
    const hasColFilters = state.columnFilters.size > 0 || state.sortField !== null;
    btn.disabled = !hasColFilters;
  }

  /* -------------------------------------------------------------
     ESTADOS PENDENTES E SALVAMENTO
     ------------------------------------------------------------- */
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

  function countPendingChanges() {
    let count = state.creates.size;
    state.pending.forEach((changes) => {
      count += Object.keys(changes).length;
    });
    return count;
  }

  function updatePendingControls() {
    const pending = hasPendingChanges();
    const count = countPendingChanges();
    const saveBtn = byId("save-changes");
    const cancelBtn = byId("cancel-changes");

    saveBtn.disabled = !pending || state.busy;
    cancelBtn.disabled = !pending || state.busy;

    saveBtn.classList.toggle("has-pending-badge", pending);
    cancelBtn.classList.toggle("has-pending-badge", pending);

    if (state.busy) {
      saveBtn.textContent = "Salvando...";
    } else if (pending) {
      saveBtn.innerHTML = `Salvar alterações <span class="button-badge">${count}</span>`;
      cancelBtn.innerHTML = `Cancelar <span class="button-badge">${count}</span>`;
    } else {
      saveBtn.textContent = "Salvar alterações";
      cancelBtn.textContent = "Cancelar";
    }
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
    byId("theme-toggle").addEventListener("click", toggleTheme);
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

    byId("clear-column-filters").addEventListener("click", () => {
      state.columnFilters.clear();
      state.sortField = null;
      state.sortDirection = null;
      renderTable();
      notify("Filtros de coluna e ordenações foram limpos.");
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

    // Filtro por Coluna Eventos
    byId("close-column-filter").addEventListener("click", closeColumnFilterMenu);
    byId("sort-asc-btn").addEventListener("click", () => {
      if (state.activeFilterField) {
        state.sortField = state.activeFilterField;
        state.sortDirection = "asc";
        closeColumnFilterMenu();
        renderTable();
      }
    });
    byId("sort-desc-btn").addEventListener("click", () => {
      if (state.activeFilterField) {
        state.sortField = state.activeFilterField;
        state.sortDirection = "desc";
        closeColumnFilterMenu();
        renderTable();
      }
    });
    byId("select-all-values").addEventListener("click", () => {
      if (!state.activeFilterField) return;
      const allValues = getUniqueFieldValues(state.activeFilterField);
      allValues.forEach((val) => tempSelectedValues.add(val));
      renderColumnFilterValuesList(allValues);
    });
    byId("clear-values").addEventListener("click", () => {
      if (!state.activeFilterField) return;
      tempSelectedValues.clear();
      renderColumnFilterValuesList(getUniqueFieldValues(state.activeFilterField));
    });
    byId("column-filter-search").addEventListener("input", (e) => {
      state.filterSearchTerm = e.target.value;
      if (state.activeFilterField) {
        renderColumnFilterValuesList(getUniqueFieldValues(state.activeFilterField));
      }
    });
    byId("reset-this-col-filter").addEventListener("click", () => {
      if (state.activeFilterField) {
        state.columnFilters.delete(state.activeFilterField);
        if (state.sortField === state.activeFilterField) {
          state.sortField = null;
          state.sortDirection = null;
        }
        closeColumnFilterMenu();
        renderTable();
      }
    });
    byId("apply-col-filter").addEventListener("click", () => {
      if (state.activeFilterField) {
        const allValues = getUniqueFieldValues(state.activeFilterField);
        if (tempSelectedValues.size === allValues.length) {
          // Se todos estão selecionados, não precisa filtrar
          state.columnFilters.delete(state.activeFilterField);
        } else {
          state.columnFilters.set(state.activeFilterField, new Set(tempSelectedValues));
        }
        closeColumnFilterMenu();
        renderTable();
      }
    });

    // Fechar popover de filtro ao clicar fora
    document.addEventListener("click", (e) => {
      if (!columnFilterMenu.hidden && !columnFilterMenu.contains(e.target) && !e.target.closest(".col-filter-btn")) {
        closeColumnFilterMenu();
      }
    });

    byId("task-dialog").addEventListener("cancel", (event) => event.preventDefault());
  }

  function initialize() {
    initTheme();
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
