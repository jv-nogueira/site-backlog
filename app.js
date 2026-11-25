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
  const BACKEND_URL = "https://script.google.com/macros/s/AKfycbzBIU2Jrl9WDd3CV6ROgQYrQ9da6S_Uw7Givaqox0hz0RnxVLvryv69xWh3ccxb5S0r/exec";
  const COLUMN_KEY = "workspace-database-visible-columns";
  const THEME_KEY = "workspace-database-theme";
  const BLANK_VALUE_KEY = "__BLANK_VALUE__";

  const state = {
    // Database records
    records: [],
    pending: new Map(), // recordId -> { field: newValue }
    creates: new Set(), // Set(recordId)
    visibleColumns: new Set(DEFAULT_COLUMNS),
    expanded: new Set(),
    pendingStatus: null,
    busy: false,
    theme: "light",
    loaded: false,

    // Column Filters & Sorting
    columnFilters: new Map(), // field -> Set(allowedValues)
    activeFilterField: null,
    sortField: null,
    sortDirection: null, // "asc" | "desc"
    filterSearchTerm: "",

    // Multi-selection
    selectionMode: false,
    selectedRowIds: new Set(),

    // Pending Category Conflict
    categoryConflict: null, // { record, oldVal, newVal }

    // Column resizing & ordering & renaming
    columnWidths: {}, // field -> px
    columnOrder: FIELDS.slice(), // canonical field order
    originalColumnOrder: FIELDS.slice(),
    columnLabels: {}, // canonical -> display label
    originalColumnLabels: {},
    pendingColumnRenames: {}, // canonical -> newLabel
    columnOrderChanged: false,

    // Cell Editing State (Only on double click)
    editingCell: null, // { recordId, field }

    // Shortcuts
    shortcuts: [], // list of shortcut objects: { id, rowNumber, fields: { "Nome-Button", ... }, isNew, isDeleted, isModified }
    shortcutDeletes: new Set(), // Set of rowNumbers to delete from sheet
    activeEditingShortcut: null,
    shortcutSelectedCategories: new Set()
  };

  const byId = (id) => document.getElementById(id);
  const tableHead = byId("table-head");
  const tableBody = byId("table-body");
  const columnFilterMenu = byId("column-filter-menu");
  const rowContextMenu = byId("row-context-menu");
  let toastTimer;
  let activeContextRecord = null;
  let longPressTimeout = null;

  function makeId() {
    return "new-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
  }

  function getColumnLabel(field) {
    return state.pendingColumnRenames[field] || state.columnLabels[field] || field;
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
     REDIMENSIONAMENTO DE COLUNA PELO CABEÇALHO
     ------------------------------------------------------------- */
  function setupColumnResize(th, field) {
    const resizer = createElement("div", "col-resizer");
    resizer.setAttribute("title", "Arraste para redimensionar coluna");
    th.appendChild(resizer);

    let startX = 0;
    let startWidth = 0;

    function onPointerMove(e) {
      const clientX = e.clientX || (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
      const diff = clientX - startX;
      const newWidth = Math.max(24, startWidth + diff);
      th.style.width = newWidth + "px";
      th.style.minWidth = newWidth + "px";
      state.columnWidths[field] = newWidth;
    }

    function onPointerUp() {
      resizer.classList.remove("is-resizing");
      document.removeEventListener("mousemove", onPointerMove);
      document.removeEventListener("mouseup", onPointerUp);
      document.removeEventListener("touchmove", onPointerMove);
      document.removeEventListener("touchend", onPointerUp);
    }

    function onPointerDown(e) {
      e.preventDefault();
      e.stopPropagation();
      resizer.classList.add("is-resizing");
      startX = e.clientX || (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
      startWidth = th.offsetWidth;
      document.addEventListener("mousemove", onPointerMove);
      document.addEventListener("mouseup", onPointerUp);
      document.addEventListener("touchmove", onPointerMove, { passive: false });
      document.addEventListener("touchend", onPointerUp);
    }

    resizer.addEventListener("mousedown", onPointerDown);
    resizer.addEventListener("touchstart", onPointerDown, { passive: false });
  }

  /* -------------------------------------------------------------
     RENDERIZAÇÃO DAS CÉLULAS E TABELA COM DUPLO CLIQUE
     ------------------------------------------------------------- */
  function isCellPending(record, field) {
    if (state.creates.has(record.id)) return true;
    const pendingChanges = state.pending.get(record.id);
    return Boolean(pendingChanges && field in pendingChanges);
  }

  function makeCellEditor(record, field, subtask, isFirstCol) {
    const cell = document.createElement("td");
    if (isFirstCol) cell.classList.add("is-first-col");
    if (field === "Projeto") cell.className = (cell.className + " project-cell").trim();
    if (isCellPending(record, field)) {
      cell.classList.add("is-pending-cell");
      cell.title = "Alteração pendente não salva";
    }

    const isEditing = state.editingCell &&
      state.editingCell.recordId === record.id &&
      state.editingCell.field === field;

    if (isEditing) {
      cell.classList.add("is-editing");
      // Renderiza input/select/textarea ativo
      if (field === "Categoria") {
        const wrap = createElement("div", "category-cell");
        if (subtask) wrap.classList.add("is-subtask");
        const input = createActiveInput(record, field);
        if (subtask) wrap.appendChild(createElement("span", "sr-only", "Subtarefa"));
        wrap.appendChild(input);
        cell.appendChild(wrap);
      } else {
        cell.appendChild(createActiveInput(record, field));
      }
      return cell;
    }

    // Modo Leitura / Rígido (Padrão) - Ativa edição com dblclick
    cell.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      state.editingCell = { recordId: record.id, field: field };
      renderTable();
    });

    const values = currentFields(record);

    if (field === "Categoria") {
      const wrap = createElement("div", "category-cell");
      if (subtask) wrap.classList.add("is-subtask");
      const readSpan = createElement("span", "cell-readonly", values.Categoria || "—");
      if (!values.Categoria) readSpan.classList.add("is-empty");
      readSpan.title = "Duplo clique para editar";
      if (subtask) wrap.appendChild(createElement("span", "sr-only", "Subtarefa"));
      wrap.appendChild(readSpan);
      cell.appendChild(wrap);
      return cell;
    }

    if (field === "Projeto") {
      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.checked = Boolean(values.Projeto);
      chk.disabled = true; // Só editável com dblclick
      chk.title = "Duplo clique para alterar";
      cell.appendChild(chk);
      return cell;
    }

    if (field === "Preço total") {
      const formatted = values["Preço total"] !== "" && values["Preço total"] != null && !isNaN(Number(values["Preço total"]))
        ? formatBRL(Number(values["Preço total"]))
        : "—";
      const readSpan = createElement("span", "cell-readonly", formatted);
      if (formatted === "—") readSpan.classList.add("is-empty");
      readSpan.title = "Duplo clique para editar";
      cell.appendChild(readSpan);
      return cell;
    }

    // Campo de texto geral ou Descrição / Observação com alça de arraste condicional
    const wrap = createElement("div", "cell-expand-wrap");
    const rawVal = escapeText(values[field]);
    const readSpan = createElement("div", "cell-readonly", rawVal || "—");
    if (!rawVal) readSpan.classList.add("is-empty");
    readSpan.title = "Duplo clique para editar";
    wrap.appendChild(readSpan);

    if (rawVal) {
      window.requestAnimationFrame(() => {
        const hasNewline = rawVal.includes("\n");
        const overflows = readSpan.scrollWidth > readSpan.clientWidth + 1 || readSpan.scrollHeight > readSpan.clientHeight + 1;
        if (hasNewline || overflows) {
          const handle = createElement("div", "cell-expand-handle", "⤡");
          handle.title = "Arraste para expandir ou duplo clique para recolher";
          setupCellExpand(handle, readSpan);
          wrap.appendChild(handle);
        }
      });
    }

    cell.appendChild(wrap);
    return cell;
  }

  /* -------------------------------------------------------------
     ALÇA DE ARRASTE PARA EXPANDIR VISUALIZAÇÃO DE CÉLULA
     ------------------------------------------------------------- */
  function setupCellExpand(handle, targetEl) {
    let startX = 0;
    let startY = 0;
    let startHeight = 0;
    let startWidth = 0;

    function onMove(e) {
      const clientX = e.clientX || (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
      const clientY = e.clientY || (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
      const diffY = clientY - startY;
      const diffX = clientX - startX;
      const newHeight = Math.max(26, startHeight + diffY);
      const newWidth = Math.max(40, startWidth + diffX);
      targetEl.classList.add("is-expanded");
      targetEl.style.height = newHeight + "px";
      targetEl.style.maxHeight = "none";
      targetEl.style.width = newWidth + "px";
    }

    function onUp() {
      handle.classList.remove("is-dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onUp);
    }

    function onDown(e) {
      e.preventDefault();
      e.stopPropagation();
      handle.classList.add("is-dragging");
      startX = e.clientX || (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
      startY = e.clientY || (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
      startHeight = targetEl.offsetHeight;
      startWidth = targetEl.offsetWidth;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.addEventListener("touchmove", onMove, { passive: false });
      document.addEventListener("touchend", onUp);
    }

    handle.addEventListener("mousedown", onDown);
    handle.addEventListener("touchstart", onDown, { passive: false });
    handle.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      targetEl.classList.remove("is-expanded");
      targetEl.style.height = "";
      targetEl.style.maxHeight = "";
      targetEl.style.width = "";
    });
  }

  /* -------------------------------------------------------------
     CRIAÇÃO DO INPUT ATIVO EM MODO EDIÇÃO
     ------------------------------------------------------------- */
  function createActiveInput(record, field) {
    const values = currentFields(record);
    let input;

    function finishEdit(val) {
      state.editingCell = null;
      stageField(record, field, val);
    }

    if (field === "Projeto") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = Boolean(values[field]);
      input.setAttribute("aria-label", "Projeto");
      input.addEventListener("change", () => finishEdit(input.checked));
      input.addEventListener("blur", () => {
        state.editingCell = null;
        renderTable();
      });
      window.setTimeout(() => input.focus(), 0);
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
        state.editingCell = null;
        const previous = currentFields(record).Status || "Aberto";
        if (input.value !== previous) openStatusDialog(record, input.value, previous);
        else renderTable();
      });
      input.addEventListener("blur", () => {
        state.editingCell = null;
        renderTable();
      });
      window.setTimeout(() => input.focus(), 0);
      return input;
    }

    if (field === "Observação" || field === "Descrição") {
      input = document.createElement("textarea");
      input.rows = field === "Descrição" ? 3 : 2;
      input.value = escapeText(values[field]);
    } else {
      input = document.createElement("input");
      input.type = field === "Preço total" ? "number" : "text";
      if (field === "Preço total") input.step = "any";
      input.value = escapeText(values[field]);
    }

    input.setAttribute("aria-label", field);

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && field !== "Descrição" && field !== "Observação") {
        input.blur();
      } else if (e.key === "Escape") {
        state.editingCell = null;
        renderTable();
      }
    });

    input.addEventListener("blur", () => {
      finishEdit(input.value);
    });

    window.setTimeout(() => {
      input.focus();
      if (typeof input.select === "function") input.select();
    }, 0);

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

  function reorderColumn(fromField, toField, placeAfter) {
    if (!fromField || !toField || fromField === toField) return;
    const order = state.columnOrder.slice();
    const fromIdx = order.indexOf(fromField);
    if (fromIdx === -1) return;
    order.splice(fromIdx, 1);
    let toIdx = order.indexOf(toField);
    if (toIdx === -1) return;
    if (placeAfter) toIdx += 1;
    order.splice(toIdx, 0, fromField);
    state.columnOrder = order;
    state.columnOrderChanged = JSON.stringify(state.columnOrder) !== JSON.stringify(state.originalColumnOrder);
    renderTable();
  }

  function renderTableHead(columns) {
    tableHead.replaceChildren();
    let dragSrcField = null;

    columns.forEach((field, index) => {
      const th = document.createElement("th");
      if (index === 0) th.classList.add("is-first-col");
      th.dataset.field = field;
      th.draggable = true;

      if (state.columnWidths[field]) {
        th.style.width = state.columnWidths[field] + "px";
        th.style.minWidth = state.columnWidths[field] + "px";
      }

      const content = createElement("div", "th-content");
      const label = createElement("span", "th-label", getColumnLabel(field));
      label.title = "Duplo clique para renomear ou arraste para reordenar";

      // Duplo clique no cabeçalho para renomear coluna
      label.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        th.draggable = false;
        const input = createElement("input", "th-rename-input");
        input.type = "text";
        input.value = getColumnLabel(field);
        input.maxLength = 100;

        const commitRename = () => {
          const newVal = input.value.trim();
          const origLabel = state.originalColumnLabels[field] || field;
          if (newVal && newVal !== origLabel) {
            state.pendingColumnRenames[field] = newVal;
          } else {
            delete state.pendingColumnRenames[field];
          }
          th.draggable = true;
          renderTable();
        };

        input.addEventListener("keydown", (ke) => {
          if (ke.key === "Enter") {
            ke.preventDefault();
            input.blur();
          } else if (ke.key === "Escape") {
            th.draggable = true;
            renderTable();
          }
        });
        input.addEventListener("blur", commitRename);
        label.replaceWith(input);
        input.focus();
        input.select();
      });

      content.appendChild(label);

      // Botão de filtro da coluna (estilo Google Sheets)
      const filterBtn = createElement("button", "col-filter-btn", "▼");
      filterBtn.type = "button";
      filterBtn.title = "Filtrar por " + getColumnLabel(field);
      filterBtn.setAttribute("aria-label", "Filtrar por " + getColumnLabel(field));
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

      // Drag and drop para reordenar colunas (Desktop)
      th.addEventListener("dragstart", (e) => {
        if (e.target.closest(".col-resizer") || e.target.closest(".col-filter-btn") || e.target.closest(".th-rename-input")) {
          e.preventDefault();
          return;
        }
        dragSrcField = field;
        th.classList.add("is-dragging-col");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", field);
      });

      th.addEventListener("dragover", (e) => {
        if (!dragSrcField || dragSrcField === field) return;
        e.preventDefault();
        const rect = th.getBoundingClientRect();
        const isRight = (e.clientX - rect.left) > (rect.width / 2);
        th.classList.toggle("drag-over-right", isRight);
        th.classList.toggle("drag-over-left", !isRight);
      });

      th.addEventListener("dragleave", () => {
        th.classList.remove("drag-over-left", "drag-over-right");
      });

      th.addEventListener("drop", (e) => {
        e.preventDefault();
        th.classList.remove("drag-over-left", "drag-over-right");
        if (!dragSrcField || dragSrcField === field) return;
        const rect = th.getBoundingClientRect();
        const placeAfter = (e.clientX - rect.left) > (rect.width / 2);
        reorderColumn(dragSrcField, field, placeAfter);
      });

      th.addEventListener("dragend", () => {
        dragSrcField = null;
        tableHead.querySelectorAll("th").forEach((el) => {
          el.classList.remove("is-dragging-col", "drag-over-left", "drag-over-right");
        });
      });

      // Setup drag resizer
      setupColumnResize(th, field);

      tableHead.appendChild(th);
    });
    const actionTh = createElement("th", "actions-heading", " ");
    tableHead.appendChild(actionTh);
  }

  function renderTable() {
    const columns = state.columnOrder.filter((field) => state.visibleColumns.has(field));
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

    const emptyStateEl = byId("empty-state");
    if (!state.loaded) {
      byId("result-count").textContent = "Carregando tarefas...";
      emptyStateEl.hidden = true;
    } else {
      byId("result-count").textContent = visibleCount + (visibleCount === 1 ? " tarefa" : " tarefas");
      // SÓ MOSTRA EMPTY-STATE SE REALMENTE HOUVER 0 TAREFAS VISÍVEIS APÓS CARREGAR
      emptyStateEl.hidden = (visibleCount > 0);
    }

    updateResultSummary(flatVisibleRecords);
    updatePendingControls();
    updateClearColumnFiltersBtn();
    updateSelectionBar();
  }

  function appendRecordRow(record, columns, subtask, duplicateGroup, hiddenCount) {
    const tr = document.createElement("tr");
    tr.dataset.recordId = record.id;
    if (subtask) tr.classList.add("subtask-row");
    if (state.creates.has(record.id) || state.pending.has(record.id)) tr.classList.add("pending-row");
    if (state.creates.has(record.id)) tr.classList.add("is-new-row");
    if (state.selectedRowIds.has(record.id)) tr.classList.add("selected-row");
    if (activeContextRecord && activeContextRecord.id === record.id) tr.classList.add("context-focus-row");

    // Click in selection mode toggles selection
    tr.addEventListener("click", (e) => {
      if (state.selectionMode && !e.target.closest("button") && !e.target.closest("select") && !e.target.closest(".is-editing")) {
        toggleRowSelection(record.id);
      }
    });

    // Context menu desktop
    tr.addEventListener("contextmenu", (e) => {
      // Se estiver editando uma célula, permite o menu nativo de copiar/colar do navegador
      if (e.target.closest(".is-editing") || e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") {
        return;
      }
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY, record);
    });

    // Touch long press mobile
    tr.addEventListener("touchstart", (e) => {
      if (e.target.closest(".is-editing") || e.target.closest(".cell-expand-handle")) {
        return;
      }
      if (e.touches.length === 1) {
        const touch = e.touches[0];
        longPressTimeout = setTimeout(() => {
          openContextMenu(touch.clientX, touch.clientY, record);
        }, 550);
      }
    }, { passive: true });

    tr.addEventListener("touchmove", () => {
      if (longPressTimeout) clearTimeout(longPressTimeout);
    }, { passive: true });

    tr.addEventListener("touchend", () => {
      if (longPressTimeout) clearTimeout(longPressTimeout);
    });

    columns.forEach((field, colIndex) => {
      const isFirstCol = (colIndex === 0);
      if (field === "Categoria" && duplicateGroup) {
        const cell = document.createElement("td");
        if (isFirstCol) cell.classList.add("is-first-col");
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
        wrap.append(button);

        // Edição de categoria com dblclick
        const isEditing = state.editingCell && state.editingCell.recordId === record.id && state.editingCell.field === field;
        if (isEditing) {
          cell.classList.add("is-editing");
          wrap.appendChild(createActiveInput(record, field));
        } else {
          const val = currentFields(record).Categoria || "—";
          const readSpan = createElement("span", "cell-readonly", val);
          if (val === "—") readSpan.classList.add("is-empty");
          readSpan.title = "Duplo clique para editar";
          readSpan.addEventListener("dblclick", (e) => {
            e.stopPropagation();
            state.editingCell = { recordId: record.id, field: field };
            renderTable();
          });
          wrap.appendChild(readSpan);
        }

        cell.appendChild(wrap);
        tr.appendChild(cell);
      } else {
        tr.appendChild(makeCellEditor(record, field, subtask, isFirstCol));
      }
    });

    const action = document.createElement("td");
    action.setAttribute("aria-hidden", "true");
    tr.appendChild(action);
    tableBody.appendChild(tr);
  }

  /* -------------------------------------------------------------
     MENU DE CONTEXTO E MODO SELEÇÃO
     ------------------------------------------------------------- */
  function openContextMenu(x, y, record) {
    activeContextRecord = record;
    renderTable(); // destaca a linha com classe context-focus-row

    rowContextMenu.hidden = false;

    const menuWidth = 170;
    const menuHeight = 90;
    let posX = x;
    let posY = y;
    if (posX + menuWidth > window.innerWidth) posX = window.innerWidth - menuWidth - 10;
    if (posY + menuHeight > window.innerHeight) posY = window.innerHeight - menuHeight - 10;
    if (posX < 10) posX = 10;
    if (posY < 10) posY = 10;

    rowContextMenu.style.left = posX + "px";
    rowContextMenu.style.top = posY + "px";
  }

  function closeContextMenu() {
    rowContextMenu.hidden = true;
    if (activeContextRecord) {
      activeContextRecord = null;
      renderTable();
    }
  }

  function toggleRowSelection(recordId) {
    if (state.selectedRowIds.has(recordId)) {
      state.selectedRowIds.delete(recordId);
    } else {
      state.selectedRowIds.add(recordId);
    }
    if (state.selectedRowIds.size === 0) {
      state.selectionMode = false;
    }
    renderTable();
  }

  function updateSelectionBar() {
    const bar = byId("selection-bar");
    const countEl = byId("selection-count");
    if (state.selectedRowIds.size > 0) {
      bar.hidden = false;
      countEl.textContent = state.selectedRowIds.size;
    } else {
      bar.hidden = true;
    }
  }

  function copySelectedRows() {
    if (state.selectedRowIds.size === 0) return;
    const columns = FIELDS.filter((f) => state.visibleColumns.has(f));
    const lines = [];
    lines.push(columns.join("\t"));

    state.records.forEach((record) => {
      if (state.selectedRowIds.has(record.id)) {
        const fields = currentFields(record);
        const rowData = columns.map((col) => {
          if (col === "Projeto") return fields[col] ? "Sim" : "Não";
          return escapeText(fields[col]);
        });
        lines.push(rowData.join("\t"));
      }
    });

    const textToCopy = lines.join("\n");
    navigator.clipboard.writeText(textToCopy).then(() => {
      notify(`Copiado! ${state.selectedRowIds.size} linha(s) com cabeçalhos.`);
    }).catch(() => {
      notify("Erro ao copiar para a área de transferência.", true);
    });
  }

  function clearSelection() {
    state.selectionMode = false;
    state.selectedRowIds.clear();
    renderTable();
  }

  function duplicateRecord(record) {
    const orig = currentFields(record);
    const newFields = Object.assign({}, orig);
    createRecord(newFields);
    renderTable();
    notify("Linha duplicada como pendente. Salve para gravar.");
  }

  /* -------------------------------------------------------------
     MENU DE FILTRO POR COLUNA (GOOGLE SHEETS STYLE)
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
      const oldCat = String(currentFields(record).Categoria || "").trim();
      const newCat = String(value || "").trim();
      if (oldCat === newCat) {
        renderTable();
        return;
      }

      const matchingCount = state.records.filter((r) => {
        return r.id !== record.id && String(currentFields(r).Categoria || "").trim() === oldCat;
      }).length;

      if (matchingCount > 0 && oldCat !== "") {
        state.categoryConflict = { record, oldVal: oldCat, newVal: newCat };
        byId("category-conflict-desc").textContent =
          `Existem ${matchingCount} outra(s) tarefa(s) na categoria "${oldCat}". Deseja aplicar a mudança para "${newCat}" apenas nesta linha ou em todas as linhas dessa categoria?`;
        dialogOpen(byId("category-conflict-dialog"));
        return;
      }
    }

    setPendingValue(record, field, value);
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

  /* -------------------------------------------------------------
     CONTAGEM DE ALTERAÇÕES (Database + Atalhos)
     ------------------------------------------------------------- */
  function countPendingChanges() {
    const affectedDbRows = new Set();
    state.creates.forEach((id) => affectedDbRows.add(id));
    state.pending.forEach((_, id) => affectedDbRows.add(id));
    let total = affectedDbRows.size;

    state.shortcuts.forEach((sc) => {
      if (sc.isNew || sc.isModified) total += 1;
    });
    total += state.shortcutDeletes.size;

    // + 1 por cada coluna renomeada e + 1 se a ordem das colunas mudou
    total += Object.keys(state.pendingColumnRenames).length;
    if (state.columnOrderChanged) total += 1;

    return total;
  }

  function hasPendingChanges() {
    return countPendingChanges() > 0;
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
    state.shortcutDeletes.clear();
    state.editingCell = null;
    state.pendingColumnRenames = {};
    state.columnOrder = state.originalColumnOrder.slice();
    state.columnOrderChanged = false;
    state.shortcuts = state.shortcuts
      .filter((s) => !s.isNew)
      .map((s) => ({
        id: s.id,
        rowNumber: s.rowNumber,
        fields: Object.assign({}, s.originalFields || s.fields),
        originalFields: Object.assign({}, s.originalFields || s.fields),
        isNew: false,
        isModified: false
      }));

    renderShortcutsBar();
    renderTable();
    notify("Alterações descartadas.");
  }

  function checkAndConfirmSave() {
    if (state.busy || !hasPendingChanges()) return;

    const affectedDbRowsCount = state.creates.size + state.pending.size;
    if (affectedDbRowsCount > 1) {
      byId("save-confirm-message").textContent =
        `Existem ${affectedDbRowsCount} linhas na Database com alterações ou novas entradas para serem salvas na planilha. Deseja confirmar?`;
      dialogOpen(byId("save-confirm-dialog"));
      return;
    }

    executeSave();
  }

  function executeSave() {
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

    const shortcutUpdates = [];
    const shortcutCreates = [];
    state.shortcuts.forEach((sc) => {
      if (sc.isNew) {
        shortcutCreates.push({ fields: sc.fields });
      } else if (sc.isModified) {
        shortcutUpdates.push({ rowNumber: sc.rowNumber, fields: sc.fields });
      }
    });
    const shortcutDeletes = Array.from(state.shortcutDeletes);

    const shortcutsPayload = {
      updates: shortcutUpdates,
      creates: shortcutCreates,
      deletes: shortcutDeletes
    };

    state.busy = true;
    updatePendingControls();

    postRequest(BACKEND_URL, {
      action: "save",
      updates,
      newRecords,
      shortcuts: shortcutsPayload,
      columnRenames: Object.keys(state.pendingColumnRenames).length ? state.pendingColumnRenames : undefined,
      columnOrder: state.columnOrderChanged ? state.columnOrder : undefined
    })
      .then((response) => {
        if (!response || !response.ok) {
          throw new Error(response && response.error ? response.error : "O backend não confirmou a gravação.");
        }
        state.pending.clear();
        state.creates.clear();
        state.shortcutDeletes.clear();
        state.pendingColumnRenames = {};
        state.columnOrderChanged = false;
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

  function normalizeActiveShortcutValue(val) {
    if (val === false) return false;
    if (val == null || val === "") return true;
    const str = String(val).trim().toUpperCase();
    return str !== "FALSE" && str !== "FALSO" && str !== "0";
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
        state.loaded = true;

        // Process column order and labels from sheet
        if (Array.isArray(response.columns) && response.columns.length > 0) {
          const order = [];
          const labels = {};
          response.columns.forEach((col) => {
            if (col && col.canonical && FIELDS.includes(col.canonical)) {
              order.push(col.canonical);
              labels[col.canonical] = col.label || col.canonical;
            }
          });
          FIELDS.forEach((f) => {
            if (!order.includes(f)) order.push(f);
            if (!labels[f]) labels[f] = f;
          });
          state.columnOrder = order;
          state.originalColumnOrder = order.slice();
          state.columnLabels = labels;
          state.originalColumnLabels = Object.assign({}, labels);
          state.pendingColumnRenames = {};
          state.columnOrderChanged = false;
        }

        // Process shortcuts with robust parsing & active fallback
        if (Array.isArray(response.shortcuts) && response.shortcuts.length > 0) {
          state.shortcuts = response.shortcuts.map((sc) => {
            const rawFields = sc.fields || {};
            const isActive = normalizeActiveShortcutValue(rawFields["Ativar-Atalho"]);
            const f = Object.assign({}, rawFields, { "Ativar-Atalho": isActive });
            return {
              id: makeId(),
              rowNumber: sc.rowNumber,
              fields: f,
              originalFields: Object.assign({}, f),
              isNew: false,
              isModified: false
            };
          });
        } else if (state.shortcuts.length === 0) {
          // Fallback para atalhos padrão conforme a planilha do usuário (Compra e Teste)
          state.shortcuts = [
            {
              id: makeId(),
              rowNumber: 2,
              fields: {
                "Nome-Button": "Compra",
                "Categorias-Filtradas": "Compra",
                "Apenas-Projetos": "FALSE",
                "Status-Selecionados": "Aberto",
                "Categorias-Duplicadas": "FALSE",
                "Colunas": "Categoria, Descrição, Recebedor, Preço total",
                "Ativar-Atalho": true
              },
              isNew: false,
              isModified: false
            },
            {
              id: makeId(),
              rowNumber: 3,
              fields: {
                "Nome-Button": "Teste",
                "Categorias-Filtradas": "Compra",
                "Apenas-Projetos": "",
                "Status-Selecionados": "Aberto",
                "Categorias-Duplicadas": "FALSE",
                "Colunas": "Categoria, Descrição, Status, Recebedor",
                "Ativar-Atalho": true
              },
              isNew: false,
              isModified: false
            }
          ];
        }
        state.shortcutDeletes.clear();

        renderShortcutsBar();
        renderTable();
        setConnectionStatus(true, "Conectado à planilha");
      })
      .catch((error) => {
        state.loaded = true;
        setConnectionStatus(false, "Falha na conexão");
        notify("Não foi possível carregar a Database: " + error.message, true);
        renderTable();
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

  /* -------------------------------------------------------------
     AUTOCOMPLETAR DE CATEGORIA NO MODAL "ADICIONAR TAREFA"
     ------------------------------------------------------------- */
  function setupCategoryAutocomplete() {
    const input = byId("task-category-input");
    const dropdown = byId("task-category-suggestions");

    function getExistingCategories() {
      const set = new Set();
      state.records.forEach((r) => {
        const cat = String(currentFields(r).Categoria || "").trim();
        if (cat) set.add(cat);
      });
      return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" }));
    }

    function renderSuggestions(query) {
      const all = getExistingCategories();
      const q = String(query || "").trim().toLocaleLowerCase("pt-BR");
      const matches = all.filter((cat) => !q || cat.toLocaleLowerCase("pt-BR").includes(q));

      dropdown.replaceChildren();
      if (matches.length === 0) {
        dropdown.hidden = true;
        return;
      }

      matches.forEach((cat) => {
        const item = createElement("div", "autocomplete-item", cat);
        item.addEventListener("click", () => {
          input.value = cat;
          dropdown.hidden = true;
        });
        dropdown.appendChild(item);
      });
      dropdown.hidden = false;
    }

    input.addEventListener("focus", () => {
      renderSuggestions(input.value);
    });

    input.addEventListener("input", () => {
      renderSuggestions(input.value);
    });

    document.addEventListener("click", (e) => {
      if (!input.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.hidden = true;
      }
    });
  }

  /* -------------------------------------------------------------
     ATALHOS RÁPIDOS (CRUD + RENDERIZAÇÃO + APLICAÇÃO)
     ------------------------------------------------------------- */
  function renderShortcutsBar() {
    const container = byId("shortcuts-container");
    const inactiveContainer = byId("inactive-shortcuts-list");
    const inactiveDetails = byId("inactive-shortcuts-details");
    const inactiveCountEl = byId("inactive-shortcuts-count");

    container.replaceChildren();
    inactiveContainer.replaceChildren();

    const activeShortcuts = state.shortcuts.filter((sc) => sc.fields["Ativar-Atalho"] === true);
    const inactiveShortcuts = state.shortcuts.filter((sc) => sc.fields["Ativar-Atalho"] !== true);

    activeShortcuts.forEach((sc) => {
      const group = createElement("div", "shortcut-pill-group");
      if (sc.isNew || sc.isModified) group.classList.add("is-pending-shortcut");

      const applyBtn = createElement("button", "shortcut-apply-btn", sc.fields["Nome-Button"]);
      applyBtn.type = "button";
      applyBtn.title = "Aplicar filtros deste atalho";
      applyBtn.addEventListener("click", () => applyShortcut(sc));

      const editBtn = createElement("button", "shortcut-edit-btn", "✎");
      editBtn.type = "button";
      editBtn.title = "Editar atalho";
      editBtn.addEventListener("click", () => openShortcutForm(sc));

      group.append(applyBtn, editBtn);
      container.appendChild(group);
    });

    inactiveCountEl.textContent = inactiveShortcuts.length;
    if (inactiveShortcuts.length > 0) {
      inactiveDetails.hidden = false;
      inactiveShortcuts.forEach((sc) => {
        const item = createElement("div", "inactive-shortcut-item");
        const titleSpan = createElement("span", "", sc.fields["Nome-Button"]);
        const editSpan = createElement("span", "", "✎ Editar");
        item.append(titleSpan, editSpan);
        item.addEventListener("click", () => {
          inactiveDetails.open = false;
          openShortcutForm(sc);
        });
        inactiveContainer.appendChild(item);
      });
    } else {
      inactiveDetails.hidden = true;
      inactiveDetails.open = false;
    }
  }

  function applyShortcut(shortcut) {
    const f = shortcut.fields;

    // 1. Categorias filtradas
    const rawCats = String(f["Categorias-Filtradas"] || "").trim();
    if (rawCats) {
      const allowedCats = new Set(rawCats.split(",").map((s) => s.trim()).filter(Boolean));
      state.columnFilters.set("Categoria", allowedCats);
    } else {
      state.columnFilters.delete("Categoria");
    }

    // 2. Apenas projetos
    const proj = String(f["Apenas-Projetos"] || "").trim().toUpperCase();
    if (proj === "TRUE" || proj === "VERDADEIRO") {
      byId("projects-only").checked = true;
    } else {
      byId("projects-only").checked = false;
    }

    // 3. Status selecionados
    const rawStatus = String(f["Status-Selecionados"] || "").trim();
    const statusInputs = document.querySelectorAll('input[name="status-filter"]');
    if (rawStatus) {
      const selectedStatuses = new Set(rawStatus.split(",").map((s) => s.trim().toLocaleLowerCase("pt-BR")));
      statusInputs.forEach((input) => {
        input.checked = selectedStatuses.has(input.value.toLocaleLowerCase("pt-BR"));
      });
    } else {
      statusInputs.forEach((input) => {
        input.checked = (input.value === "Aberto");
      });
    }

    // 4. Categorias duplicadas
    const rawDup = String(f["Categorias-Duplicadas"] || "").trim().toUpperCase();
    if (rawDup === "TRUE" || rawDup === "VERDADEIRO") {
      byId("group-categories").checked = true;
    } else if (rawDup === "FALSE" || rawDup === "FALSO") {
      byId("group-categories").checked = false;
    }

    // 5. Colunas
    const rawCols = String(f["Colunas"] || "").trim();
    if (rawCols) {
      const cols = rawCols.split(",").map((s) => s.trim()).filter((col) => FIELDS.includes(col));
      if (cols.length > 0) {
        state.visibleColumns = new Set(cols);
        localStorage.setItem(COLUMN_KEY, JSON.stringify(cols));
        renderColumnOptions();
      }
    } else {
      state.visibleColumns = new Set(DEFAULT_COLUMNS);
      localStorage.setItem(COLUMN_KEY, JSON.stringify(Array.from(DEFAULT_COLUMNS)));
      renderColumnOptions();
    }

    state.expanded.clear();
    renderTable();
    notify(`Atalho "${f["Nome-Button"]}" aplicado.`);
  }

  function openShortcutForm(shortcut) {
    state.activeEditingShortcut = shortcut;
    const isEditing = Boolean(shortcut);

    byId("shortcut-dialog-eyebrow").textContent = isEditing ? "EDITAR ATALHO" : "NOVO ATALHO";
    byId("shortcut-dialog-title").textContent = isEditing ? "Editar atalho" : "Criar atalho";
    byId("delete-shortcut-btn").hidden = !isEditing;

    const fields = shortcut ? shortcut.fields : {
      "Nome-Button": "",
      "Categorias-Filtradas": "",
      "Apenas-Projetos": "",
      "Status-Selecionados": "",
      "Categorias-Duplicadas": "",
      "Colunas": "",
      "Ativar-Atalho": true
    };

    byId("shortcut-name-input").value = fields["Nome-Button"] || "";
    byId("shortcut-projects-select").value = fields["Apenas-Projetos"] || "";
    byId("shortcut-duplicate-select").value = fields["Categorias-Duplicadas"] || "";
    byId("shortcut-active-switch").checked = (fields["Ativar-Atalho"] !== false);

    const statusSet = new Set(
      String(fields["Status-Selecionados"] || "")
        .split(",")
        .map((s) => s.trim().toLocaleLowerCase("pt-BR"))
        .filter(Boolean)
    );
    document.querySelectorAll('input[name="shortcut-status"]').forEach((cb) => {
      cb.checked = statusSet.has(cb.value.toLocaleLowerCase("pt-BR"));
    });

    const colSet = new Set(
      String(fields["Colunas"] || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );
    const colContainer = byId("shortcut-columns-checks");
    colContainer.replaceChildren();
    FIELDS.forEach((fld) => {
      const label = createElement("label", "check-option");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = fld;
      cb.name = "shortcut-col";
      cb.checked = colSet.has(fld);
      label.append(cb, document.createTextNode(" " + fld));
      colContainer.appendChild(label);
    });

    state.shortcutSelectedCategories = new Set(
      String(fields["Categorias-Filtradas"] || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );
    renderShortcutCategoryBadges();

    dialogOpen(byId("shortcut-dialog"));
  }

  function renderShortcutCategoryBadges() {
    const badgesContainer = byId("shortcut-cat-badges");
    badgesContainer.replaceChildren();

    state.shortcutSelectedCategories.forEach((cat) => {
      const badge = createElement("span", "cat-badge", cat);
      const removeBtn = createElement("button", "cat-badge-remove", "×");
      removeBtn.type = "button";
      removeBtn.addEventListener("click", () => {
        state.shortcutSelectedCategories.delete(cat);
        renderShortcutCategoryBadges();
      });
      badge.appendChild(removeBtn);
      badgesContainer.appendChild(badge);
    });
  }

  function setupShortcutCategoryDropdown() {
    const searchInput = byId("shortcut-cat-search");
    const dropdown = byId("shortcut-cat-dropdown");
    const itemsContainer = byId("shortcut-cat-items");

    function getExistingCategories() {
      const set = new Set();
      state.records.forEach((r) => {
        const cat = String(currentFields(r).Categoria || "").trim();
        if (cat) set.add(cat);
      });
      return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" }));
    }

    function renderList(query) {
      itemsContainer.replaceChildren();
      const all = getExistingCategories();
      const q = String(query || "").trim().toLocaleLowerCase("pt-BR");
      const filtered = all.filter((cat) => !q || cat.toLocaleLowerCase("pt-BR").includes(q));

      if (filtered.length === 0) {
        itemsContainer.appendChild(createElement("p", "filter-menu-empty", "Nenhuma categoria encontrada"));
        return;
      }

      filtered.forEach((cat) => {
        const label = createElement("label", "check-option");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = cat;
        cb.checked = state.shortcutSelectedCategories.has(cat);
        cb.addEventListener("change", () => {
          if (cb.checked) state.shortcutSelectedCategories.add(cat);
          else state.shortcutSelectedCategories.delete(cat);
          renderShortcutCategoryBadges();
        });
        label.append(cb, document.createTextNode(" " + cat));
        itemsContainer.appendChild(label);
      });
    }

    searchInput.addEventListener("focus", () => {
      dropdown.hidden = false;
      renderList(searchInput.value);
    });

    searchInput.addEventListener("input", () => {
      renderList(searchInput.value);
    });

    byId("shortcut-cat-select-all").addEventListener("click", () => {
      getExistingCategories().forEach((cat) => state.shortcutSelectedCategories.add(cat));
      renderList(searchInput.value);
      renderShortcutCategoryBadges();
    });

    byId("shortcut-cat-clear").addEventListener("click", () => {
      state.shortcutSelectedCategories.clear();
      renderList(searchInput.value);
      renderShortcutCategoryBadges();
    });

    document.addEventListener("click", (e) => {
      if (!searchInput.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.hidden = true;
      }
    });
  }

  function saveShortcutForm() {
    const name = byId("shortcut-name-input").value.trim();
    if (!name) return;

    const cats = Array.from(state.shortcutSelectedCategories).join(", ");
    const onlyProj = byId("shortcut-projects-select").value;
    const dupCats = byId("shortcut-duplicate-select").value;
    const active = byId("shortcut-active-switch").checked;

    const selectedStatus = Array.from(document.querySelectorAll('input[name="shortcut-status"]:checked'))
      .map((cb) => cb.value)
      .join(", ");

    const selectedCols = Array.from(document.querySelectorAll('input[name="shortcut-col"]:checked'))
      .map((cb) => cb.value)
      .join(", ");

    const fields = {
      "Nome-Button": name,
      "Categorias-Filtradas": cats,
      "Apenas-Projetos": onlyProj,
      "Status-Selecionados": selectedStatus,
      "Categorias-Duplicadas": dupCats,
      "Colunas": selectedCols,
      "Ativar-Atalho": active
    };

    if (state.activeEditingShortcut) {
      state.activeEditingShortcut.fields = fields;
      state.activeEditingShortcut.isModified = true;
    } else {
      state.shortcuts.push({
        id: makeId(),
        rowNumber: null,
        fields,
        isNew: true,
        isModified: false
      });
    }

    closeDialog(byId("shortcut-dialog"));
    renderShortcutsBar();
    updatePendingControls();
    notify("Atalho atualizado localmente. Salve para gravar na planilha.");
  }

  function deleteShortcut() {
    const shortcut = state.activeEditingShortcut;
    if (!shortcut) return;

    if (shortcut.rowNumber) {
      state.shortcutDeletes.add(shortcut.rowNumber);
    }
    state.shortcuts = state.shortcuts.filter((s) => s !== shortcut);

    closeDialog(byId("shortcut-dialog"));
    renderShortcutsBar();
    updatePendingControls();
    notify("Atalho excluído localmente. Salve para gravar na planilha.");
  }

  /* -------------------------------------------------------------
     EVENTOS E INICIALIZAÇÃO
     ------------------------------------------------------------- */
  function bindEvents() {
    byId("theme-toggle").addEventListener("click", toggleTheme);
    byId("save-changes").addEventListener("click", checkAndConfirmSave);
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

    // Submissão de Nova Tarefa
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

    // Submissão de Status
    byId("status-form").addEventListener("submit", (event) => {
      event.preventDefault();
      applyStatusChange();
    });
    byId("cancel-status").addEventListener("click", cancelStatusChange);

    // Modal Conflito de Categoria
    byId("close-category-conflict").addEventListener("click", () => closeDialog(byId("category-conflict-dialog")));
    byId("cat-apply-single").addEventListener("click", () => {
      if (state.categoryConflict) {
        setPendingValue(state.categoryConflict.record, "Categoria", state.categoryConflict.newVal);
        state.categoryConflict = null;
        closeDialog(byId("category-conflict-dialog"));
        renderTable();
      }
    });
    byId("cat-apply-all").addEventListener("click", () => {
      if (state.categoryConflict) {
        const { oldVal, newVal, record } = state.categoryConflict;
        state.records.forEach((r) => {
          if (String(currentFields(r).Categoria || "").trim() === oldVal) {
            setPendingValue(r, "Categoria", newVal);
          }
        });
        state.shortcuts.forEach((sc) => {
          const rawCats = String(sc.fields["Categorias-Filtradas"] || "");
          if (rawCats) {
            const list = rawCats.split(",").map((s) => s.trim());
            if (list.includes(oldVal)) {
              const updatedList = list.map((item) => (item === oldVal ? newVal : item));
              sc.fields["Categorias-Filtradas"] = updatedList.join(", ");
              sc.isModified = true;
            }
          }
        });

        state.categoryConflict = null;
        closeDialog(byId("category-conflict-dialog"));
        renderShortcutsBar();
        renderTable();
        notify("Categoria atualizada em todas as linhas correspondentes e nos atalhos.");
      }
    });

    // Modal Confirmação Salvar Múltiplas Linhas
    byId("close-save-confirm").addEventListener("click", () => closeDialog(byId("save-confirm-dialog")));
    byId("cancel-save-confirm").addEventListener("click", () => closeDialog(byId("save-confirm-dialog")));
    byId("proceed-save-confirm").addEventListener("click", () => {
      closeDialog(byId("save-confirm-dialog"));
      executeSave();
    });

    // Atalhos
    byId("create-shortcut-btn").addEventListener("click", () => openShortcutForm(null));
    byId("shortcut-form").addEventListener("submit", (e) => {
      e.preventDefault();
      saveShortcutForm();
    });
    byId("delete-shortcut-btn").addEventListener("click", deleteShortcut);
    setupShortcutCategoryDropdown();

    // Context Menu Items
    byId("context-select-row").addEventListener("click", () => {
      if (activeContextRecord) {
        state.selectionMode = true;
        state.selectedRowIds.add(activeContextRecord.id);
        closeContextMenu();
        renderTable();
      }
    });
    byId("context-duplicate-row").addEventListener("click", () => {
      if (activeContextRecord) {
        const rec = activeContextRecord;
        closeContextMenu();
        duplicateRecord(rec);
      }
    });

    // Floating Selection Bar
    byId("copy-selection-btn").addEventListener("click", copySelectedRows);
    byId("clear-selection-btn").addEventListener("click", clearSelection);

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

    // Fechar seletor "Colunas" ao clicar fora
    const colPickerDetails = byId("column-picker-details");
    document.addEventListener("click", (e) => {
      if (colPickerDetails && colPickerDetails.open) {
        if (!colPickerDetails.contains(e.target)) {
          colPickerDetails.open = false;
        }
      }
    });

    // Fechar context menu ao clicar/tocar fora
    document.addEventListener("click", (e) => {
      if (!rowContextMenu.hidden && !rowContextMenu.contains(e.target)) {
        closeContextMenu();
      }
    });
    document.addEventListener("touchstart", (e) => {
      if (!rowContextMenu.hidden && !rowContextMenu.contains(e.target)) {
        closeContextMenu();
      }
    }, { passive: true });

    // Manter thead sempre congelado no topo da viewport durante rolagem vertical da página
    window.addEventListener("scroll", () => {
      const thead = tableHead.parentElement;
      const tableEl = thead ? thead.parentElement : null;
      if (!thead || !tableEl) return;
      const rect = tableEl.getBoundingClientRect();
      if (rect.top < 0 && rect.bottom > thead.offsetHeight) {
        thead.style.transform = `translateY(${Math.abs(rect.top)}px)`;
      } else {
        thead.style.transform = "";
      }
    }, { passive: true });

    setupCategoryAutocomplete();
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
