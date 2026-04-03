const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─────────────────────────────
// DATA STORE (JSON flat-file DB)
// ─────────────────────────────
const DATA_FILE = path.join(__dirname, 'skywar_users.json');

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { users: {}, stats: { totalLogins: 0, totalBattles: 0 } };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch(e) { return { users: {} }; }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function hashPass(p) {
  return crypto.createHash('sha256').update(p + 'skywar_salt_v1').digest('hex');
}

// ─────────────────────────────
// HTTP SERVER (REST API)
// ─────────────────────────────
const PORT = 3000;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, ngrok-skip-browser-warning');
  res.setHeader('ngrok-skip-browser-warning', '1');
}

function json(res, data, code=200) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise(res => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => { try { res(JSON.parse(body)); } catch(e) { res({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];
  const db = loadData();

  // ── POST /register
  if (req.method === 'POST' && url === '/register') {
    const body = await readBody(req);
    const { username, password } = body;
    if (!username || username.length < 3) return json(res, { ok: false, msg: 'Callsign too short (min 3 chars)' });
    if (!password || password.length < 6) return json(res, { ok: false, msg: 'Password too short (min 6 chars)' });
    if (db.users[username]) return json(res, { ok: false, msg: 'Callsign already taken' });

    db.users[username] = {
      username,
      password: hashPass(password),
      team: null,
      teamLockedUntil: null,
      credits: 500,
      wins: 0,
      kills: 0,
      losses: 0,
      fleet: ['c1'],
      equippedFighter: null,
      equippedCargo: 'c1',
      equippedTanker: null,
      createdAt: new Date().toISOString(),
      lastLogin: null,
    };
    saveData(db);
    log(`[REGISTER] New pilot: ${username}`);
    updateDashboard();
    return json(res, { ok: true });
  }

  // ── POST /login
  if (req.method === 'POST' && url === '/login') {
    const body = await readBody(req);
    const { username, password } = body;
    const user = db.users[username];
    if (!user) return json(res, { ok: false, msg: 'Unknown callsign' });
    if (user.password !== hashPass(password)) return json(res, { ok: false, msg: 'Incorrect password' });
    user.lastLogin = new Date().toISOString();
    db.stats = db.stats || {};
    db.stats.totalLogins = (db.stats.totalLogins || 0) + 1;
    saveData(db);
    log(`[LOGIN] ${username} authenticated`);
    updateDashboard();
    const safe = { ...user, password: undefined };
    return json(res, { ok: true, user: safe });
  }

  // ── PUT /user/:username
  if (req.method === 'PUT' && url.startsWith('/user/')) {
    const username = decodeURIComponent(url.split('/')[2]);
    const body = await readBody(req);
    if (!db.users[username]) return json(res, { ok: false, msg: 'User not found' });
    const protected_fields = ['password', 'createdAt'];
    protected_fields.forEach(f => delete body[f]);
    Object.assign(db.users[username], body);
    saveData(db);
    updateDashboard();
    return json(res, { ok: true });
  }

  // ── GET /leaderboard
  if (req.method === 'GET' && url === '/leaderboard') {
    const users = Object.values(db.users).map(u => ({
      username: u.username,
      team: u.team,
      wins: u.wins || 0,
      kills: u.kills || 0,
      credits: u.credits || 0,
    }));
    return json(res, { ok: true, users });
  }

  // ── GET /admin/users (admin panel)
  if (req.method === 'GET' && url === '/admin/users') {
    const users = Object.values(db.users).map(u => ({ ...u, password: '[HASHED]' }));
    return json(res, { ok: true, users });
  }

  // ── DELETE /admin/user/:username
  if (req.method === 'DELETE' && url.startsWith('/admin/user/')) {
    const username = decodeURIComponent(url.split('/')[3]);
    if (!db.users[username]) return json(res, { ok: false, msg: 'Not found' });
    delete db.users[username];
    saveData(db);
    log(`[ADMIN] Deleted user: ${username}`);
    updateDashboard();
    return json(res, { ok: true });
  }

  // ── GET /admin/stats
  if (req.method === 'GET' && url === '/admin/stats') {
    const users = Object.values(db.users);
    return json(res, {
      ok: true,
      totalUsers: users.length,
      vacuPlayers: users.filter(u => u.team === 'vacu').length,
      nstroPlayers: users.filter(u => u.team === 'nstro').length,
      totalWins: users.reduce((s,u) => s + (u.wins||0), 0),
      totalKills: users.reduce((s,u) => s + (u.kills||0), 0),
      totalLogins: (db.stats || {}).totalLogins || 0,
    });
  }

  // ── GET / (serve dashboard HTML)
  if (req.method === 'GET' && (url === '/' || url === '/dashboard')) {
    cors(res);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(getDashboardHTML());
    return;
  }

  json(res, { ok: false, msg: 'Not found' }, 404);
});

server.listen(PORT, () => {
  log(`[SERVER] SKYWAR Server running on http://localhost:${PORT}`);
  log(`[SERVER] Dashboard: http://localhost:${PORT}/dashboard`);
  updateDashboard();
});

// ─────────────────────────────
// SERVER-SIDE LOGGING
// ─────────────────────────────
const LOG_FILE = path.join(__dirname, 'skywar_server.log');
const logBuffer = [];

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logBuffer.push(line);
  if (logBuffer.length > 200) logBuffer.shift();
  const fullLine = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, fullLine);
  // Update dashboard if open
  updateDashboard();
}

// ─────────────────────────────
// DASHBOARD HTML (served at /)
// ─────────────────────────────
let dashboardClients = []; // SSE clients for live updates

function updateDashboard() {
  // Push SSE update to connected dashboards
  dashboardClients = dashboardClients.filter(c => !c.destroyed);
  dashboardClients.forEach(c => { try { c.write('data: update\n\n'); } catch(e) {} });
}

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>SKYWAR Server Dashboard</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Share+Tech+Mono&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
body{background:#02080f;color:#c0d8f0;font-family:'Share Tech Mono',monospace;min-height:100vh}
:root{--vacu:#00c8ff;--nstro:#ff4400;--green:#00ff88;--gold:#ffd700;--red:#ff3344;--panel:#060d18;--border:#1a2a3a}
.header{background:#040a14;border-bottom:2px solid var(--vacu);padding:16px 32px;display:flex;align-items:center;gap:20px}
.header h1{font-family:'Orbitron',sans-serif;font-size:20px;font-weight:900;letter-spacing:4px;color:var(--vacu);text-shadow:0 0 20px var(--vacu)}
.status-dot{width:10px;height:10px;border-radius:50%;background:var(--green);box-shadow:0 0 8px var(--green);animation:pulse 2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
.status-text{font-size:12px;color:var(--green);letter-spacing:2px}
.port-badge{margin-left:auto;background:rgba(0,200,255,0.1);border:1px solid rgba(0,200,255,0.3);padding:6px 16px;font-size:12px;color:var(--vacu);letter-spacing:2px}
.main{display:grid;grid-template-columns:280px 1fr;gap:0;min-height:calc(100vh - 60px)}
.sidebar{background:#030910;border-right:1px solid var(--border);padding:0}
.sidebar-section{padding:20px;border-bottom:1px solid var(--border)}
.sidebar-label{font-size:9px;letter-spacing:3px;color:#4a6a8a;margin-bottom:12px;text-transform:uppercase}
.stat-card{margin-bottom:12px}
.stat-label{font-size:10px;color:#4a6a8a;letter-spacing:2px;margin-bottom:4px}
.stat-value{font-family:'Orbitron',sans-serif;font-size:22px;font-weight:700}
.stat-vacu{color:var(--vacu)}
.stat-nstro{color:var(--nstro)}
.stat-gold{color:var(--gold)}
.stat-green{color:var(--green)}
.btn{padding:8px 16px;background:rgba(0,200,255,0.1);border:1px solid var(--border);color:var(--vacu);font-family:'Share Tech Mono',monospace;font-size:11px;letter-spacing:2px;cursor:pointer;width:100%;margin-bottom:8px;transition:all 0.2s;text-align:center}
.btn:hover{background:rgba(0,200,255,0.2);border-color:var(--vacu)}
.btn-danger{background:rgba(255,50,68,0.1);color:var(--red);border-color:#3a1a1a}
.btn-danger:hover{background:rgba(255,50,68,0.2);border-color:var(--red)}
.content{padding:24px;overflow-y:auto}
.section-title{font-family:'Orbitron',sans-serif;font-size:14px;font-weight:700;letter-spacing:3px;color:white;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--border)}
.users-table{width:100%;border-collapse:collapse;margin-bottom:32px}
.users-table th{font-size:9px;letter-spacing:3px;color:#4a6a8a;padding:10px 12px;text-align:left;border-bottom:1px solid var(--border);text-transform:uppercase}
.users-table td{padding:12px;font-size:12px;border-bottom:1px solid rgba(26,42,58,0.4)}
.users-table tr:hover td{background:rgba(255,255,255,0.02)}
.team-badge{display:inline-block;padding:2px 8px;font-size:10px;letter-spacing:2px}
.badge-vacu{background:rgba(0,200,255,0.1);color:var(--vacu);border:1px solid rgba(0,200,255,0.3)}
.badge-nstro{background:rgba(255,68,0,0.1);color:var(--nstro);border:1px solid rgba(255,68,0,0.3)}
.badge-none{background:rgba(255,255,255,0.05);color:#4a6a8a;border:1px solid #1a2a3a}
.log-box{background:#020810;border:1px solid var(--border);padding:16px;height:220px;overflow-y:auto;font-size:11px;line-height:1.8;margin-top:12px}
.log-line{color:#4a6a8a}
.log-line.login{color:var(--green)}
.log-line.reg{color:var(--vacu)}
.log-line.admin{color:var(--gold)}
.log-line.server{color:white}
.del-btn{padding:4px 12px;background:rgba(255,50,68,0.1);border:1px solid rgba(255,50,68,0.3);color:var(--red);font-family:'Share Tech Mono',monospace;font-size:10px;cursor:pointer;transition:all 0.2s}
.del-btn:hover{background:rgba(255,50,68,0.2)}
.search-bar{width:100%;background:#030810;border:1px solid var(--border);color:var(--vacu);font-family:'Share Tech Mono',monospace;font-size:12px;padding:10px 14px;outline:none;margin-bottom:16px;letter-spacing:1px}
.search-bar:focus{border-color:var(--vacu)}
.bar-wrap{height:6px;background:rgba(255,255,255,0.05);border-radius:3px;overflow:hidden;margin-top:6px}
.bar{height:100%;border-radius:3px;transition:width 0.5s}
.bar-vacu{background:var(--vacu)}
.bar-nstro{background:var(--nstro)}
.toast{position:fixed;bottom:24px;right:24px;background:var(--panel);border:1px solid var(--green);border-left:3px solid var(--green);padding:12px 20px;font-size:12px;color:var(--green);letter-spacing:1px;transform:translateY(60px);opacity:0;transition:all 0.3s;z-index:100}
.toast.show{transform:translateY(0);opacity:1}
.toast.err{color:var(--red);border-color:var(--red);border-left-color:var(--red)}
</style>
</head>
<body>
<div id="toast" class="toast"></div>
<div class="header">
  <div class="status-dot"></div>
  <h1>SKYWAR</h1>
  <div class="status-text">SERVER ONLINE</div>
  <div class="port-badge">PORT 3000</div>
</div>
<div class="main">
  <div class="sidebar">
    <div class="sidebar-section">
      <div class="sidebar-label">Server Stats</div>
      <div class="stat-card">
        <div class="stat-label">TOTAL PILOTS</div>
        <div class="stat-value stat-green" id="statTotal">0</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">VACU ENLISTED</div>
        <div class="stat-value stat-vacu" id="statVacu">0</div>
        <div class="bar-wrap"><div class="bar bar-vacu" id="barVacu" style="width:50%"></div></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">NSTRO ENLISTED</div>
        <div class="stat-value stat-nstro" id="statNstro">0</div>
        <div class="bar-wrap"><div class="bar bar-nstro" id="barNstro" style="width:50%"></div></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">TOTAL WINS LOGGED</div>
        <div class="stat-value stat-gold" id="statWins">0</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">TOTAL LOGINS</div>
        <div class="stat-value" id="statLogins" style="color:white">0</div>
      </div>
    </div>
    <div class="sidebar-section">
      <div class="sidebar-label">Actions</div>
      <button class="btn" onclick="refreshAll()">↻ REFRESH DATA</button>
      <button class="btn" onclick="exportUsers()">⬇ EXPORT USERS</button>
      <button class="btn btn-danger" onclick="confirmClearLog()">✕ CLEAR LOG</button>
    </div>
    <div class="sidebar-section">
      <div class="sidebar-label">Server Info</div>
      <div style="font-size:11px;color:#4a6a8a;line-height:2">
        Node.js ${typeof process !== 'undefined' ? process.version : ''}<br>
        Data: skywar_users.json<br>
        Log: skywar_server.log
      </div>
    </div>
  </div>

  <div class="content">
    <div class="section-title">PILOT ROSTER</div>
    <input class="search-bar" type="text" placeholder="Search pilots by callsign..." oninput="filterUsers(this.value)" id="searchBar">
    <table class="users-table" id="usersTable">
      <thead>
        <tr>
          <th>CALLSIGN</th>
          <th>TEAM</th>
          <th>CREDITS</th>
          <th>WINS</th>
          <th>KILLS</th>
          <th>FLEET</th>
          <th>LAST LOGIN</th>
          <th>LOCK EXP</th>
          <th>ACTION</th>
        </tr>
      </thead>
      <tbody id="usersTbody"></tbody>
    </table>

    <div class="section-title">SERVER LOG</div>
    <div class="log-box" id="logBox">
      <div class="log-line server">[SERVER] Waiting for activity...</div>
    </div>
  </div>
</div>

<script>
let allUsers = [];
let toastTimer;

function showToast(msg, type='') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.className='toast', 3000);
}

async function fetchStats() {
  try {
    const r = await fetch('/admin/stats');
    const d = await r.json();
    if(!d.ok) return;
    document.getElementById('statTotal').textContent = d.totalUsers;
    document.getElementById('statVacu').textContent = d.vacuPlayers;
    document.getElementById('statNstro').textContent = d.nstroPlayers;
    document.getElementById('statWins').textContent = d.totalWins;
    document.getElementById('statLogins').textContent = d.totalLogins;
    const total = d.vacuPlayers + d.nstroPlayers || 1;
    document.getElementById('barVacu').style.width = (d.vacuPlayers/total*100) + '%';
    document.getElementById('barNstro').style.width = (d.nstroPlayers/total*100) + '%';
  } catch(e){}
}

async function fetchUsers() {
  try {
    const r = await fetch('/admin/users');
    const d = await r.json();
    if(!d.ok) return;
    allUsers = d.users;
    renderUsers(allUsers);
  } catch(e){}
}

function renderUsers(users) {
  const tbody = document.getElementById('usersTbody');
  tbody.innerHTML = users.map(u => {
    const teamBadge = u.team
      ? \`<span class="team-badge badge-\${u.team}">\${u.team.toUpperCase()}</span>\`
      : '<span class="team-badge badge-none">NONE</span>';
    const lastLogin = u.lastLogin ? new Date(u.lastLogin).toLocaleDateString() : '—';
    const lockExp = u.teamLockedUntil ? new Date(u.teamLockedUntil).toLocaleDateString() : '—';
    const fleet = (u.fleet||[]).length;
    return \`<tr>
      <td style="font-family:'Orbitron',sans-serif;font-size:12px;letter-spacing:1px;color:white">\${u.username}</td>
      <td>\${teamBadge}</td>
      <td style="color:#ffd700">\${(u.credits||0).toLocaleString()}c</td>
      <td style="color:#00ff88">\${u.wins||0}</td>
      <td style="color:#ff3344">\${u.kills||0}</td>
      <td style="color:#4a6a8a">\${fleet} planes</td>
      <td style="color:#4a6a8a">\${lastLogin}</td>
      <td style="color:#4a6a8a">\${lockExp}</td>
      <td><button class="del-btn" onclick="deleteUser('\${u.username}')">DELETE</button></td>
    </tr>\`;
  }).join('') || '<tr><td colspan="9" style="text-align:center;color:#4a6a8a;padding:32px">No pilots registered yet</td></tr>';
}

function filterUsers(query) {
  const filtered = allUsers.filter(u => u.username.toLowerCase().includes(query.toLowerCase()));
  renderUsers(filtered);
}

async function deleteUser(username) {
  if(!confirm(\`Delete pilot "\${username}"? This cannot be undone.\`)) return;
  const r = await fetch(\`/admin/user/\${encodeURIComponent(username)}\`, {method:'DELETE'});
  const d = await r.json();
  if(d.ok) { showToast(\`\${username} deleted\`); refreshAll(); }
  else showToast('Delete failed', 'err');
}

function exportUsers() {
  const csv = ['Callsign,Team,Credits,Wins,Kills,Fleet,LastLogin,LockUntil',
    ...allUsers.map(u => [u.username,u.team||'',u.credits||0,u.wins||0,u.kills||0,(u.fleet||[]).length,u.lastLogin||'',u.teamLockedUntil||''].join(','))
  ].join('\\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = 'skywar_pilots.csv';
  a.click();
  showToast('Exported skywar_pilots.csv');
}

function confirmClearLog() {
  if(!confirm('Clear the server log display?')) return;
  document.getElementById('logBox').innerHTML = '<div class="log-line server">[LOG CLEARED]</div>';
}

async function refreshAll() {
  await fetchStats();
  await fetchUsers();
  showToast('Data refreshed');
}

// ─── SSE for live updates ───
const evtSrc = new EventSource('/sse');
evtSrc.onmessage = () => refreshAll();
evtSrc.onerror = () => {};

// Append log lines via polling
let lastLogLen = 0;
async function pollLog() {
  try {
    const r = await fetch('/admin/log');
    const d = await r.json();
    if(d.ok && d.lines) {
      const box = document.getElementById('logBox');
      const newLines = d.lines.slice(lastLogLen);
      lastLogLen = d.lines.length;
      newLines.forEach(line => {
        const div = document.createElement('div');
        div.className = 'log-line' +
          (line.includes('LOGIN') ? ' login' : line.includes('REGISTER') ? ' reg' : line.includes('ADMIN') ? ' admin' : line.includes('SERVER') ? ' server' : '');
        div.textContent = line;
        box.appendChild(div);
        box.scrollTop = box.scrollHeight;
      });
    }
  } catch(e){}
}

refreshAll();
setInterval(refreshAll, 10000);
setInterval(pollLog, 2000);
pollLog();
</script>
</body>
</html>`;
}

// ─────────────────────────────
// EXTRA ENDPOINTS FOR DASHBOARD
// ─────────────────────────────
const _origOnRequest = server.listeners('request')[0];
server.removeAllListeners('request');
server.on('request', async (req, res) => {
  const url = req.url.split('?')[0];

  // SSE endpoint for live dashboard updates
  if (url === '/sse') {
    cors(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('data: connected\n\n');
    dashboardClients.push(res);
    req.on('close', () => {
      dashboardClients = dashboardClients.filter(c => c !== res);
    });
    return;
  }

  // Log endpoint
  if (url === '/admin/log') {
    cors(res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, lines: logBuffer }));
    return;
  }

  _origOnRequest(req, res);
});

// ─────────────────────────────
// STARTUP
// ─────────────────────────────
log('[SERVER] SKYWAR Backend initialized');
log('[SERVER] Data file: ' + DATA_FILE);
log('[SERVER] Dashboard available at http://localhost:3000');
log('[SERVER] Game client should connect to http://localhost:3000');
