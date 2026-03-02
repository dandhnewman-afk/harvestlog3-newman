// --------------------
// CONFIGURATION (REQUIRED)
// --------------------

// 1) READ (Published Google Sheet -> CSV URL)
// Example format:
// https://docs.google.com/spreadsheets/d/e/XXXXXXXXXXXX/pub?gid=0&single=true&output=csv
const GOOGLE_SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTQXwIKkUSH-No_wz2RIiDJm0FerHYnTMeRdb-_mWIqHIoWbfaRsihuTg8JBa6vUL0oKpXxYiIy9Mer/pub?output=csv';

// 2) WRITE (SheetDB API Base URL)
// Example format:
// https://sheetdb.io/api/v1/abc123xyz
const SHEETDB_API_BASE_URL = 'https://sheetdb.io/api/v1/6nubs02neily4';

// Column name used to uniquely identify rows for updates.
// Must match your sheet header exactly.
const UID_COLUMN_NAME = 'UID';

// --------------------
// STATE
// --------------------
let currentRow = null;
let allTasks = [];
let taskMap = {}; // keyed by _row (CSV row index), not UID

// --------------------
// UTILITY FUNCTIONS
// --------------------
function normalizeDate(d) {
  if (!d) return '';
  try {
    return d.trim()
      .replace(/["']/g, '')
      .replace(/\r/g, '')
      .replace(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, (_, m, day, y) =>
        `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      );
  } catch (error) {
    console.error('Error normalizing date:', d, error);
    return '';
  }
}

// Convert an object of updates into query params for SheetDB PATCH.
// SheetDB supports PATCH /api/v1/{API_ID}/{COLUMN}/{VALUE}?name=Emma&age=28 ...
function toQueryString(obj) {
  const params = new URLSearchParams();
  Object.entries(obj).forEach(([k, v]) => {
    // Skip undefined/null/empty-string updates
    if (v === undefined || v === null) return;
    const valueStr = String(v).trim();
    if (valueStr === '') return;
    params.append(k, valueStr);
  });
  return params.toString();
}

// --------------------
// RENDER: SUMMARY VIEW
// --------------------
function renderTasks(tasksToRender) {
  const container = document.getElementById('task-list');
  container.innerHTML = '';

  if (!tasksToRender || tasksToRender.length === 0) {
    container.innerHTML = '<p>No tasks to display for this date. / No hay tareas para esta fecha.</p>';
    return;
  }

  tasksToRender.forEach(task => {
    const div = document.createElement('div');
    div.className = 'task-card';

    div.innerHTML = `
      <strong>${task['Crop'] || 'N/A'}</strong><br>
      <strong>Location / Ubicación:</strong> ${task['Location'] || '-'}<br>
      <strong>Quantity / Cantidad:</strong> ${task['Units to Harvest'] || 'N/A'} ${task['Harvest Units'] || ''}<br>
      <strong>Assigned To / Asignado a:</strong> ${task['Assignee(s)'] || 'Unassigned / Sin asignar'}<br>
      <button onclick="openForm(${task._row || 0})">Open / Abrir</button>
    `;
    container.appendChild(div);
  });
}

// --------------------
// RENDER: DETAIL VIEW
// --------------------
function openForm(rowId) {
  const task = taskMap[rowId];
  if (!task) {
    console.error('Task not found for rowId:', rowId);
    alert('Could not open task (row not found).');
    return;
  }

  currentRow = task;

  document.getElementById('detail-title').innerText = task['Crop'] || 'N/A';
  document.getElementById('detail-location').innerText = task['Location'] || '-';
  document.getElementById('detail-quantity').innerText =
    `${task['Units to Harvest'] || 'N/A'} ${task['Harvest Units'] || ''}`;

  const breakdown = document.getElementById('sales-breakdown');
  breakdown.innerHTML = `
    <strong>Sales Breakdown / Desglose de Ventas:</strong>
    <span>CSA / CSA: ${task['CSA'] || 0}</span>
    <span>Parkdale Bins / Contenedores Parkdale: ${task['Parkdale Bins'] || 0}</span>
    <span>Cobourg Farmers Market / Mercado de Agricultores de Cobourg: ${task['Cobourg Farmers Market'] || 0}</span>
    <span>Kitchen / Cocina: ${task['Kitchen'] || 0}</span>
    <span>Online / En línea: ${task['Online'] || 0}</span>
  `;

  document.getElementById('assignee').value = task['Assignee(s)'] || '';
  document.getElementById('harvestTime').value = task['Time to Harvest (min)'] || '';
  document.getElementById('weight').value = task['Harvest Weight (kg)'] || '';
  document.getElementById('washPackTime').value = task['Time to Wash & Pack (mins)'] || '';
  document.getElementById('notes').value = task['Field Crew Notes'] || '';

  document.getElementById('detail-form').style.display = 'block';
}

function closeForm() {
  document.getElementById('detail-form').style.display = 'none';
}

// --------------------
// DATA FETCH & PARSE (READ FROM CSV)
// --------------------
function fetchAndParseCsv() {
  return fetch(GOOGLE_SHEET_CSV_URL)
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status} while fetching Google CSV`);
      return res.text();
    })
    .then(csv => {
      if (!csv || csv.trim() === '') throw new Error('Fetched CSV data is empty.');

      const rows = csv.trim().split('\n').map(row => {
        const cells = [];
        let inQuotes = false, value = '';

        for (let i = 0; i < row.length; i++) {
          const char = row[i];
          const nextChar = row[i + 1];

          if (char === '"' && inQuotes && nextChar === '"') {
            value += '"'; i++;
          } else if (char === '"') {
            inQuotes = !inQuotes;
          } else if (char === ',' && !inQuotes) {
            cells.push(value);
            value = '';
          } else {
            value += char;
          }
        }
        cells.push(value);
        return cells.map(c => c.trim());
      });

      const headers = rows.shift();
      if (!headers || headers.length === 0) throw new Error('CSV headers are missing or empty.');

      const parsedTasks = rows.map((row, i) => {
        const obj = {};
        headers.forEach((h, j) => {
          const key = h.trim();
          let value = row[j] ? row[j].trim().replace(/^"|"$/g, '') : '';

          if (key === 'Harvest Date') value = normalizeDate(value);
          obj[key] = value;
        });

        // CSV row numbers: header row is row 1 in sheet, first data row is row 2.
        obj._row = i + 2;
        return obj;
      });

      // Filter: only show tasks that are harvestable and not completed
      allTasks = parsedTasks.filter(row =>
        row['Crop'] &&
        row['Harvest Date'] &&
        row['Harvest Date'] !== '' &&
        row['Status'] !== 'Completed' &&
        !isNaN(parseFloat(row['Units to Harvest'])) &&
        parseFloat(row['Units to Harvest']) > 0
      );

      taskMap = {};
      allTasks.forEach(t => { taskMap[t._row] = t; });

      document.dispatchEvent(new Event('tasksLoaded'));
    })
    .catch(error => {
      console.error('Error fetching/parsing CSV:', error);
      const container = document.getElementById('task-list');
      if (container) {
        container.innerHTML = `<p style="color:red;">Error loading tasks: ${error.message}</p>`;
      }
      allTasks = [];
      taskMap = {};
      document.dispatchEvent(new Event('tasksLoaded'));
    });
}

// --------------------
// WRITE BACK (UPDATE VIA SHEETDB)
// --------------------
function patchRowByUid(uid, updatesObj) {
  const query = toQueryString(updatesObj);
  const url = `${SHEETDB_API_BASE_URL}/${encodeURIComponent(UID_COLUMN_NAME)}/${encodeURIComponent(uid)}${query ? '?' + query : ''}`;

  return fetch(url, {
    method: 'PATCH',
    mode: 'cors'
  }).then(res => {
    if (!res.ok) throw new Error(`SheetDB update failed (HTTP ${res.status})`);
    return res.json();
  });
}

// --------------------
// DOM READY BINDINGS
// --------------------
document.addEventListener('DOMContentLoaded', () => {
  const dateInput = document.getElementById('date-selector');

  if (!dateInput) {
    alert('Error: date selector not found.');
    return;
  }

  // Set date selector to today
  const today = new Date().toISOString().split('T')[0];
  dateInput.value = today;

  // Load tasks
  fetchAndParseCsv();

  document.addEventListener('tasksLoaded', () => {
    const selectedDate = dateInput.value;
    const tasksToFilter = Array.isArray(allTasks) ? allTasks : [];

    const filteredTasks = tasksToFilter.filter(row => normalizeDate(row['Harvest Date']) === selectedDate);
    renderTasks(filteredTasks);
  });

  dateInput.addEventListener('change', () => {
    const selectedDate = dateInput.value;
    const tasksToFilter = Array.isArray(allTasks) ? allTasks : [];
    const filteredTasks = tasksToFilter.filter(row => normalizeDate(row['Harvest Date']) === selectedDate);
    renderTasks(filteredTasks);
  });

  const updateBtn = document.getElementById('update-btn');
  const completeBtn = document.getElementById('complete-btn');

  if (updateBtn) {
    updateBtn.addEventListener('click', () => handleSubmit(false));
  }

  if (completeBtn) {
    completeBtn.addEventListener('click', () => handleSubmit(true));
  }

  function handleSubmit(requireAllFields) {
    if (!currentRow) {
      alert('Error: No task selected.');
      return;
    }

    const uid = (currentRow[UID_COLUMN_NAME] || '').toString().trim();
    if (!uid) {
      alert(`Error: This row is missing a ${UID_COLUMN_NAME} value. Add a unique UID in the sheet and reload.`);
      return;
    }

    const harvestTime = document.getElementById('harvestTime').value.trim();
    const weight = document.getElementById('weight').value.trim();
    const washPackTime = document.getElementById('washPackTime').value.trim();
    const assignee = document.getElementById('assignee').value.trim();
    const notes = document.getElementById('notes').value.trim();

    if (requireAllFields && (!assignee || !harvestTime || !weight || !washPackTime)) {
      alert('Please complete all fields before marking as completed.');
      return;
    }

    // Build updates (keys must match sheet headers exactly)
    const updates = {};
    if (assignee) updates['Assignee(s)'] = assignee;
    if (harvestTime) updates['Time to Harvest (min)'] = harvestTime;
    if (weight) updates['Harvest Weight (kg)'] = weight;
    if (washPackTime) updates['Time to Wash & Pack (mins)'] = washPackTime;
    if (notes) updates['Field Crew Notes'] = notes;

    if (requireAllFields) {
      updates['Status'] = 'Completed';
      updates['Harvest Date'] = new Date().toISOString().split('T')[0];
    } else if (assignee) {
      // Optional: mark Assigned if partially updated
      updates['Status'] = 'Assigned';
    }

    patchRowByUid(uid, updates)
      .then(() => {
        // Update local copy so the UI reflects changes immediately
        Object.assign(currentRow, updates);
        taskMap[currentRow._row] = currentRow;

        // If completed, remove from allTasks and close form
        if (updates['Status'] === 'Completed') {
          allTasks = allTasks.filter(t => t._row !== currentRow._row);
          closeForm();
          document.dispatchEvent(new Event('tasksLoaded'));
          alert('Task marked Completed!');
          return;
        }

        alert('Task updated!');
        openForm(currentRow._row);
        document.dispatchEvent(new Event('tasksLoaded'));
      })
      .catch(err => {
        console.error('Update failed:', err);
        alert(`Error updating task: ${err.message}\n\nMost common causes:\n- Wrong SheetDB API URL\n- SheetDB update permissions disabled\n- Wrong Chrome profile / authorization`);
      });
  }
});