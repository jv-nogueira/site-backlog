const SHEET_NAME = "Database";
const SHORTCUTS_SHEET_NAME = "Atalhos";

const REQUIRED_HEADERS = [
  "Categoria",
  "Descrição",
  "Projeto",
  "Status",
  "Observação",
  "Data conclusão",
  "Recebedor",
  "Preço total"
];

const SHORTCUT_HEADERS = [
  "Nome-Button",
  "Categorias-Filtradas",
  "Apenas-Projetos",
  "Status-Selecionados",
  "Categorias-Duplicadas",
  "Colunas",
  "Ativar-Atalho"
];

const VALID_STATUSES = ["Aberto", "Resolvido", "Cancelado"];

function doGet(e) {
  const callback = e && e.parameter ? e.parameter.callback : "";
  try {
    const action = e && e.parameter && e.parameter.action ? e.parameter.action : "list";
    if (action !== "list") throw new Error("Ação GET não suportada.");
    const data = readRecords_();
    const shortcuts = readShortcuts_();
    return jsonpResponse_({
      ok: true,
      records: data.records,
      columns: data.columns,
      shortcuts: shortcuts
    }, callback);
  } catch (error) {
    return jsonpResponse_({ ok: false, error: error.message || String(error) }, callback);
  }
}

function doPost(e) {
  let request = {};
  try {
    const raw = e && e.parameter && e.parameter.payload
      ? e.parameter.payload
      : e && e.postData && e.postData.contents
        ? e.postData.contents
        : "";
    request = JSON.parse(raw);
    if (request.action !== "save") throw new Error("Ação POST não suportada.");
    const result = saveChanges_(request);
    return postMessageResponse_({ ok: true, result: result }, request.nonce);
  } catch (error) {
    return postMessageResponse_({
      ok: false,
      error: error.message || String(error)
    }, request.nonce);
  }
}

function getColumnAliases_() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty("COLUMN_ALIASES");
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function saveColumnAliases_(aliases) {
  PropertiesService.getScriptProperties().setProperty("COLUMN_ALIASES", JSON.stringify(aliases || {}));
}

function readRecords_() {
  const sheet = getDatabaseSheet_();
  const range = sheet.getDataRange();
  const values = range.getValues();
  if (!values.length) throw new Error("A aba Database não contém a linha de cabeçalho.");
  const headers = values[0];
  const columns = getColumnMap_(headers);
  const orderedCols = getOrderedColumns_(headers, columns);
  const records = [];
  for (let index = 1; index < values.length; index += 1) {
    const fields = rowToFields_(values[index], columns);
    if (!String(fields["Categoria"] || "").trim() && !String(fields["Descrição"] || "").trim()) continue;
    records.push({ rowNumber: index + 1, fields: fields });
  }
  return { records: records, columns: orderedCols };
}

function getOrderedColumns_(headers, colMap) {
  const result = [];
  const reverseMap = {};
  Object.keys(colMap).forEach(function (canonical) {
    reverseMap[colMap[canonical]] = canonical;
  });
  headers.forEach(function (h, idx) {
    const colNum = idx + 1;
    const canonical = reverseMap[colNum];
    if (canonical) {
      result.push({ canonical: canonical, label: String(h || canonical).trim() });
    }
  });
  return result;
}

function normalizeHeaderKey_(header) {
  return String(header || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function isTruthyShortcutActive_(value) {
  if (value === "" || value == null) return true;
  if (value === true) return true;
  if (value === false) return false;
  const str = String(value).trim().toUpperCase();
  return str === "TRUE" || str === "VERDADEIRO" || str === "1" || str === "SIM";
}

function readShortcuts_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHORTCUTS_SHEET_NAME);
  if (!sheet) return [];

  const range = sheet.getDataRange();
  const values = range.getValues();
  if (!values || values.length <= 1) return [];

  const headers = values[0];
  const colMap = {};
  headers.forEach((h, idx) => {
    const cleanHeader = String(h || "").trim();
    if (cleanHeader) {
      colMap[cleanHeader] = idx;
      colMap[normalizeHeaderKey_(cleanHeader)] = idx;
    }
  });

  function getColVal(row, canonicalName) {
    const norm = normalizeHeaderKey_(canonicalName);
    const idx = colMap[canonicalName] != null ? colMap[canonicalName] : colMap[norm];
    if (idx != null && idx < row.length) {
      return row[idx];
    }
    return "";
  }

  const shortcuts = [];
  for (let i = 1; i < values.length; i += 1) {
    const row = values[i];
    const shortcutName = String(getColVal(row, "Nome-Button") || "").trim();
    if (!shortcutName) continue;

    const rawActive = getColVal(row, "Ativar-Atalho");
    const active = isTruthyShortcutActive_(rawActive);

    shortcuts.push({
      rowNumber: i + 1,
      fields: {
        "Nome-Button": shortcutName,
        "Categorias-Filtradas": String(getColVal(row, "Categorias-Filtradas") || "").trim(),
        "Apenas-Projetos": String(getColVal(row, "Apenas-Projetos") || "").trim(),
        "Status-Selecionados": String(getColVal(row, "Status-Selecionados") || "").trim(),
        "Categorias-Duplicadas": String(getColVal(row, "Categorias-Duplicadas") || "").trim(),
        "Colunas": String(getColVal(row, "Colunas") || "").trim(),
        "Ativar-Atalho": active
      }
    });
  }
  return shortcuts;
}

function saveChanges_(request) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getDatabaseSheet_();
    const lastColumn = sheet.getLastColumn();
    if (!lastColumn) throw new Error("A aba Database não contém cabeçalhos.");
    const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
    const columns = getColumnMap_(headers);
    const lastRow = sheet.getLastRow();
    const rows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues() : [];
    const updates = Array.isArray(request.updates) ? request.updates : [];
    const newRecords = Array.isArray(request.newRecords) ? request.newRecords : [];
    const seenRows = {};

    updates.forEach(function (update) {
      const rowNumber = Number(update.rowNumber);
      if (!Number.isInteger(rowNumber) || rowNumber < 2 || rowNumber > lastRow) {
        throw new Error("Uma tarefa mudou na planilha. Recarregue antes de salvar.");
      }
      if (seenRows[rowNumber]) throw new Error("A solicitação contém uma tarefa duplicada.");
      seenRows[rowNumber] = true;
      const current = rowToFields_(rows[rowNumber - 2], columns);
      if (fieldSignature_(current) !== fieldSignature_(update.expected || {})) {
        throw new Error("A planilha foi alterada desde o carregamento. Recarregue e reaplique suas mudanças.");
      }
      validateChanges_(update.changes || {});
    });
    newRecords.forEach(validateNewRecord_);

    const now = new Date();
    const preparedUpdates = updates.map(function (update) {
      const rowNumber = Number(update.rowNumber);
      const original = rowToFields_(rows[rowNumber - 2], columns);
      const changes = update.changes || {};
      const statusChanged = Object.prototype.hasOwnProperty.call(changes, "Status") &&
        normalizeStatus_(changes["Status"]) !== original["Status"];
      const values = Object.assign({}, changes);
      if (statusChanged) values["Data conclusão"] = now;
      Object.keys(values).forEach(function (field) {
        values[field] = normalizeWriteValue_(field, values[field]);
      });
      return { rowNumber: rowNumber, values: values };
    });
    const rowsToWrite = newRecords.map(function (record) {
      const row = new Array(lastColumn).fill("");
      REQUIRED_HEADERS.forEach(function (field) {
        let value = record[field];
        if (field === "Data conclusão" && record["Status"] === "Resolvido" && !value) value = now;
        row[columns[field] - 1] = normalizeWriteValue_(field, value);
      });
      return row;
    });

    preparedUpdates.forEach(function (update) {
      Object.keys(update.values).forEach(function (field) {
        sheet.getRange(update.rowNumber, columns[field]).setValue(update.values[field]);
      });
    });
    if (rowsToWrite.length) {
      sheet.insertRowsBefore(2, rowsToWrite.length);
      sheet.getRange(2, 1, rowsToWrite.length, lastColumn).setValues(rowsToWrite);
    }

    // Process shortcuts if present
    const shortcutOps = request.shortcuts;
    if (shortcutOps && typeof shortcutOps === "object") {
      saveShortcuts_(shortcutOps);
    }

    // Process column renames (row 1 + aliases)
    if (request.columnRenames && typeof request.columnRenames === "object") {
      const aliases = getColumnAliases_();
      Object.keys(request.columnRenames).forEach(function (canonical) {
        const newLabel = String(request.columnRenames[canonical] || "").trim();
        if (newLabel && columns[canonical]) {
          sheet.getRange(1, columns[canonical]).setValue(newLabel);
          aliases[canonical] = newLabel;
        }
      });
      saveColumnAliases_(aliases);
    }

    // Process column reorder
    if (Array.isArray(request.columnOrder) && request.columnOrder.length > 0) {
      reorderSheetColumns_(sheet, request.columnOrder);
    }

    SpreadsheetApp.flush();
    return { updated: updates.length, inserted: newRecords.length };
  } finally {
    lock.releaseLock();
  }
}

function getShortcutsSheetOrCreate_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHORTCUTS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHORTCUTS_SHEET_NAME);
    sheet.getRange(1, 1, 1, SHORTCUT_HEADERS.length).setValues([SHORTCUT_HEADERS]);
  }
  return sheet;
}

function saveShortcuts_(shortcutOps) {
  const sheet = getShortcutsSheetOrCreate_();
  let lastColumn = sheet.getLastColumn();
  if (lastColumn < SHORTCUT_HEADERS.length) {
    sheet.getRange(1, 1, 1, SHORTCUT_HEADERS.length).setValues([SHORTCUT_HEADERS]);
    lastColumn = SHORTCUT_HEADERS.length;
  }
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  const colMap = {};
  headers.forEach((h, idx) => {
    const clean = String(h || "").trim();
    if (clean) {
      colMap[clean] = idx + 1;
      colMap[normalizeHeaderKey_(clean)] = idx + 1;
    }
  });

  SHORTCUT_HEADERS.forEach((h) => {
    const norm = normalizeHeaderKey_(h);
    if (!colMap[h] && !colMap[norm]) {
      lastColumn += 1;
      sheet.getRange(1, lastColumn).setValue(h);
      colMap[h] = lastColumn;
      colMap[norm] = lastColumn;
    }
  });

  function resolveShortcutCol(key) {
    return colMap[key] || colMap[normalizeHeaderKey_(key)];
  }

  // Handle deletions first (sorted descending by rowNumber)
  const deletes = Array.isArray(shortcutOps.deletes) ? shortcutOps.deletes : [];
  const rowsToDelete = deletes
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 2)
    .sort((a, b) => b - a);

  rowsToDelete.forEach((r) => {
    if (r <= sheet.getLastRow()) {
      sheet.deleteRow(r);
    }
  });

  // Handle updates
  const updates = Array.isArray(shortcutOps.updates) ? shortcutOps.updates : [];
  updates.forEach((up) => {
    const r = Number(up.rowNumber);
    if (Number.isInteger(r) && r >= 2 && r <= sheet.getLastRow()) {
      const f = up.fields || {};
      Object.keys(f).forEach((key) => {
        const colIdx = resolveShortcutCol(key);
        if (colIdx) {
          let val = f[key];
          if (key === "Ativar-Atalho" || normalizeHeaderKey_(key) === "ativar-atalho") {
            val = isTruthyShortcutActive_(val) ? "TRUE" : "FALSE";
          }
          sheet.getRange(r, colIdx).setValue(val);
        }
      });
    }
  });

  // Handle creates
  const creates = Array.isArray(shortcutOps.creates) ? shortcutOps.creates : [];
  if (creates.length > 0) {
    const rowsToAdd = creates.map((item) => {
      const f = item.fields || item;
      const row = new Array(lastColumn).fill("");
      SHORTCUT_HEADERS.forEach((key) => {
        const colIdx = resolveShortcutCol(key);
        if (colIdx) {
          let val = f[key] != null ? f[key] : "";
          if (key === "Ativar-Atalho") {
            val = isTruthyShortcutActive_(val) ? "TRUE" : "FALSE";
          }
          row[colIdx - 1] = val;
        }
      });
      return row;
    });
    const nextRow = sheet.getLastRow() + 1;
    sheet.getRange(nextRow, 1, rowsToAdd.length, lastColumn).setValues(rowsToAdd);
  }
}

function reorderSheetColumns_(sheet, desiredCanonicalOrder) {
  const lastColumn = sheet.getLastColumn();
  const lastRow = sheet.getLastRow();
  if (!lastColumn || !lastRow) return;

  const currentHeaders = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  const colMap = getColumnMap_(currentHeaders);

  // Build target column index list (1-based)
  const targetSourceCols = [];
  const usedCols = {};
  desiredCanonicalOrder.forEach(function (canonical) {
    if (colMap[canonical] && !usedCols[colMap[canonical]]) {
      targetSourceCols.push(colMap[canonical]);
      usedCols[colMap[canonical]] = true;
    }
  });
  // Append any remaining columns not in desiredCanonicalOrder
  for (let c = 1; c <= lastColumn; c += 1) {
    if (!usedCols[c]) {
      targetSourceCols.push(c);
    }
  }

  // Check if order actually changed
  let changed = false;
  for (let i = 0; i < targetSourceCols.length; i += 1) {
    if (targetSourceCols[i] !== i + 1) {
      changed = true;
      break;
    }
  }
  if (!changed) return;

  const allValues = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  const reorderedValues = allValues.map(function (row) {
    return targetSourceCols.map(function (srcCol) {
      return row[srcCol - 1];
    });
  });
  sheet.getRange(1, 1, lastRow, lastColumn).setValues(reorderedValues);
}

function getDatabaseSheet_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('A aba "' + SHEET_NAME + '" não foi encontrada.');
  return sheet;
}

function getColumnMap_(headers) {
  const aliases = getColumnAliases_(); // canonical -> currentHeaderName
  const reverseAliases = {};
  Object.keys(aliases).forEach(function (canonical) {
    if (aliases[canonical]) {
      reverseAliases[String(aliases[canonical]).trim()] = canonical;
    }
  });

  const map = {};
  headers.forEach(function (header, index) {
    const colName = String(header || "").trim();
    if (!colName) return;
    let canonical = null;
    if (REQUIRED_HEADERS.indexOf(colName) !== -1) {
      canonical = colName;
    } else if (reverseAliases[colName] && REQUIRED_HEADERS.indexOf(reverseAliases[colName]) !== -1) {
      canonical = reverseAliases[colName];
    }
    if (canonical) {
      if (map[canonical]) {
        throw new Error('Cabeçalho obrigatório duplicado: "' + colName + '".');
      }
      map[canonical] = index + 1;
    }
  });
  const missing = REQUIRED_HEADERS.filter(function (colName) {
    return !map[colName];
  });
  if (missing.length) throw new Error("Cabeçalhos obrigatórios ausentes: " + missing.join(", "));
  return map;
}

function rowToFields_(row, columns) {
  const fields = {};
  REQUIRED_HEADERS.forEach(function (fieldName) {
    const value = row[columns[fieldName] - 1];
    if (fieldName === "Projeto") {
      fields[fieldName] = value === true || String(value).toLocaleLowerCase() === "true" ||
        String(value).toLocaleLowerCase() === "verdadeiro";
    } else if (fieldName === "Status") {
      fields[fieldName] = normalizeStatus_(value);
    } else if (fieldName === "Data conclusão" && value instanceof Date) {
      fields[fieldName] = Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
    } else {
      fields[fieldName] = value == null ? "" : value;
    }
  });
  return fields;
}

function normalizeStatus_(value) {
  const status = String(value == null ? "" : value).trim();
  return status ? status : "Aberto";
}

function fieldSignature_(fields) {
  return JSON.stringify(REQUIRED_HEADERS.map(function (fieldName) {
    let value = fields[fieldName];
    if (fieldName === "Status") value = normalizeStatus_(value);
    if (fieldName === "Projeto") value = value === true || String(value).toLocaleLowerCase() === "true" ||
      String(value).toLocaleLowerCase() === "verdadeiro";
    if (value == null) value = "";
    return value instanceof Date
      ? Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss")
      : value;
  }));
}

function validateChanges_(changes) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    throw new Error("Alterações inválidas.");
  }
  Object.keys(changes).forEach(function (field) {
    if (REQUIRED_HEADERS.indexOf(field) === -1) throw new Error("Campo não reconhecido: " + field);
  });
  if (Object.prototype.hasOwnProperty.call(changes, "Status") &&
      VALID_STATUSES.indexOf(normalizeStatus_(changes["Status"])) === -1) {
    throw new Error("Status inválido.");
  }
  if (Object.prototype.hasOwnProperty.call(changes, "Preço total") &&
      changes["Preço total"] !== "" && changes["Preço total"] != null &&
      !isFinite(Number(changes["Preço total"]))) {
    throw new Error("Preço total deve ser um número válido.");
  }
}

function validateNewRecord_(record) {
  if (!record || typeof record !== "object") throw new Error("Nova tarefa inválida.");
  REQUIRED_HEADERS.forEach(function (field) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) throw new Error("Campo ausente: " + field);
  });
  if (!String(record["Categoria"] || "").trim()) throw new Error("Categoria é obrigatória.");
  if (!String(record["Descrição"] || "").trim()) throw new Error("Descrição é obrigatória.");
  if (VALID_STATUSES.indexOf(normalizeStatus_(record["Status"])) === -1) throw new Error("Status inválido.");
  if (record["Preço total"] !== "" && record["Preço total"] != null &&
      !isFinite(Number(record["Preço total"]))) {
    throw new Error("Preço total deve ser um número válido.");
  }
}

function normalizeWriteValue_(field, value) {
  if (field === "Projeto") return value === true || String(value).toLocaleLowerCase() === "true" ||
    String(value).toLocaleLowerCase() === "verdadeiro";
  if (field === "Status") return normalizeStatus_(value);
  if (field === "Preço total" && value !== "" && value != null) {
    const amount = Number(value);
    if (!isFinite(amount)) throw new Error("Preço total deve ser um número válido.");
    return amount;
  }
  if (field === "Data conclusão" && value) {
    if (value instanceof Date) return value;
    const date = new Date(value);
    if (!isNaN(date.getTime())) return date;
  }
  return value == null ? "" : value;
}

function jsonpResponse_(data, callback) {
  if (!callback || !/^[A-Za-z_$][0-9A-Za-z_$]*$/.test(callback)) {
    return ContentService.createTextOutput(JSON.stringify(data))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return ContentService.createTextOutput(callback + "(" + JSON.stringify(data) + ");")
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function postMessageResponse_(result, nonce) {
  const message = JSON.stringify({ nonce: nonce || "", result: result }).replace(/</g, "\\u003c");
  const html = "<!doctype html><html><body><script>window.top.postMessage(" +
    message + ", '*');</script></body></html>";
  return HtmlService.createHtmlOutput(html)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}