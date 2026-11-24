const SHEET_NAME = "Database";
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
const VALID_STATUSES = ["Aberto", "Resolvido", "Cancelado"];

function doGet(e) {
  const callback = e && e.parameter ? e.parameter.callback : "";
  try {
    const action = e && e.parameter && e.parameter.action ? e.parameter.action : "list";
    if (action !== "list") throw new Error("Ação GET não suportada.");
    const records = readRecords_();
    return jsonpResponse_({ ok: true, records: records }, callback);
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

function readRecords_() {
  const sheet = getDatabaseSheet_();
  const range = sheet.getDataRange();
  const values = range.getValues();
  if (!values.length) throw new Error("A aba Database não contém a linha de cabeçalho.");
  const columns = getColumnMap_(values[0]);
  const records = [];
  for (let index = 1; index < values.length; index += 1) {
    const fields = rowToFields_(values[index], columns);
    if (!String(fields["Categoria"] || "").trim() && !String(fields["Descrição"] || "").trim()) continue;
    records.push({ rowNumber: index + 1, fields: fields });
  }
  return records;
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
    SpreadsheetApp.flush();
    return { updated: updates.length, inserted: newRecords.length };
  } finally {
    lock.releaseLock();
  }
}

function getDatabaseSheet_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('A aba "' + SHEET_NAME + '" não foi encontrada.');
  return sheet;
}

function getColumnMap_(headers) {
  const map = {};
  headers.forEach(function (header, index) {
    const name = String(header);
    if (REQUIRED_HEADERS.indexOf(name) !== -1 && map[name]) {
      throw new Error('Cabeçalho obrigatório duplicado: "' + name + '".');
    }
    if (name) map[name] = index + 1;
  });
  const missing = REQUIRED_HEADERS.filter(function (name) {
    return !map[name];
  });
  if (missing.length) throw new Error("Cabeçalhos obrigatórios ausentes: " + missing.join(", "));
  return map;
}

function rowToFields_(row, columns) {
  const fields = {};
  REQUIRED_HEADERS.forEach(function (name) {
    const value = row[columns[name] - 1];
    if (name === "Projeto") {
      fields[name] = value === true || String(value).toLocaleLowerCase() === "true" ||
        String(value).toLocaleLowerCase() === "verdadeiro";
    } else if (name === "Status") {
      fields[name] = normalizeStatus_(value);
    } else if (name === "Data conclusão" && value instanceof Date) {
      fields[name] = Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
    } else {
      fields[name] = value == null ? "" : value;
    }
  });
  return fields;
}

function normalizeStatus_(value) {
  const status = String(value == null ? "" : value).trim();
  return status ? status : "Aberto";
}

function fieldSignature_(fields) {
  return JSON.stringify(REQUIRED_HEADERS.map(function (name) {
    let value = fields[name];
    if (name === "Status") value = normalizeStatus_(value);
    if (name === "Projeto") value = value === true || String(value).toLocaleLowerCase() === "true" ||
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
