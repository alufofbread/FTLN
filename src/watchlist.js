const fs = require('node:fs');
const path = require('node:path');

const key = value => String(value || '').trim().replace(/^@/, '').toLowerCase();
function member(value) {
  const username = key(value.username);
  if (!/^[a-z0-9_.]{2,24}$/.test(username)) throw Error('Invalid watchlist username.');
  return { username, displayName: String(value.displayName || username).trim().slice(0, 100) || username };
}
function read(file, fallback) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
function atomic(file, value) {
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
async function fetchAgencyRoster() {
  const base = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !secret) throw Error('Agency roster sync is not configured.');
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(base)) throw Error('Invalid roster service URL.');
  const headers = { apikey: secret, 'Content-Type': 'application/json', ...(secret.startsWith('eyJ') ? { Authorization: 'Bearer ' + secret } : {}) };
  const response = await fetch(base + '/rest/v1/rpc/import_member_roster', {
    method: 'POST', headers,
    body: '{}', signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw Error('Agency roster request failed (HTTP ' + response.status + ').');
  const text = await response.text();
  if (text.length > 2000000) throw Error('Agency roster response is too large.');
  const roster = JSON.parse(text);
  const feedResponse = await fetch(base + '/storage/v1/object/agency-live-watchlist/membership.json', { headers, cache: 'no-store', signal: AbortSignal.timeout(10000) });
  if (!feedResponse.ok) throw Error('Agency membership feed request failed (HTTP ' + feedResponse.status + ').');
  const feedText = await feedResponse.text();
  if (feedText.length > 2000000) throw Error('Agency membership feed is too large.');
  const feed = JSON.parse(feedText);
  if (!Array.isArray(roster) || feed?.version !== 1 || !feed.creators || typeof feed.creators !== 'object' || Array.isArray(feed.creators)) throw Error('Agency roster response is invalid.');
  const departed = new Set(), members = [];
  for (const [handle, status] of Object.entries(feed.creators)) {
    if (!/^[a-z0-9_.]{2,24}$/.test(handle) || typeof status?.active !== 'boolean') throw Error('Agency membership status is invalid.');
    if (!status.active) departed.add(handle);
  }
  for (const row of roster) {
    if (typeof row.id !== 'string' || row.id.startsWith('application:')) continue;
    const username = key(row.handle);
    if (!/^[a-z0-9_.]{2,24}$/.test(username)) throw Error('Agency roster username is invalid.');
    if (row.account_id && row.enabled !== true) departed.add(username);
    if (!departed.has(username)) members.push({ id: row.id, username, displayName: username });
  }
  return { version: 1, members, departed: [...departed] };
}

class Watchlist {
  constructor({ dataDir, fetchRoster = fetchAgencyRoster }) {
    this.file = path.join(dataDir, 'watchlist-state.json');
    this.membersFile = path.join(dataDir, 'members.json');
    this.fetchRoster = fetchRoster;
    this.inflight = null;
    fs.mkdirSync(dataDir, { recursive: true });
    const saved = read(this.file, null);
    if (saved) {
      if (saved.version !== 1 || !Array.isArray(saved.manual) || !Array.isArray(saved.excluded) || !Array.isArray(saved.roster) || !Array.isArray(saved.departed)) throw Error('Watchlist state is invalid; restore its backup before starting.');
      this.state = saved;
    } else {
      const legacy = read(this.membersFile, []);
      if (!Array.isArray(legacy)) throw Error('Legacy member list is invalid.');
      if (fs.existsSync(this.membersFile) && !fs.existsSync(this.membersFile + '.before-roster-sync')) fs.copyFileSync(this.membersFile, this.membersFile + '.before-roster-sync', fs.constants.COPYFILE_EXCL);
      this.state = { version: 1, manual: legacy.map(member), excluded: [], roster: [], departed: [], migrated: false, lastSuccess: null, lastAttempt: null, error: null };
    }
    this.save();
  }
  members() {
    const excluded = new Set(this.state.excluded);
    const members = new Map(this.state.manual.map(m => [key(m.username), { ...m, source: 'manual' }]));
    for (const row of this.state.roster) if (!members.has(row.username)) members.set(row.username, { ...member(row), source: 'agency' });
    return [...members.values()].filter(m => !excluded.has(m.username)).sort((a, b) => a.username.localeCompare(b.username));
  }
  save() {
    atomic(this.file, this.state);
    // Compatibility projection only; watchlist-state.json is authoritative.
    atomic(this.membersFile, this.members());
  }
  add(values) {
    const entries = values.map(member), manual = new Map(this.state.manual.map(m => [m.username, m]));
    for (const entry of entries) manual.set(entry.username, entry);
    this.state.manual = [...manual.values()];
    this.state.excluded = this.state.excluded.filter(name => !entries.some(m => m.username === name));
    this.save();return this.members();
  }
  remove(username) {
    username = key(username);
    if (!/^[a-z0-9_.]{2,24}$/.test(username)) throw Error('Invalid watchlist username.');
    this.state.manual = this.state.manual.filter(m => m.username !== username);
    this.state.excluded = [...new Set([...this.state.excluded, username])];
    this.save();return this.members();
  }
  sync() {
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }
  async refresh() {
    this.state.lastAttempt = new Date().toISOString();
    try {
      const data = await this.fetchRoster();
      if (data?.version !== 1 || !Array.isArray(data.members) || !Array.isArray(data.departed) || data.members.length > 10000 || data.departed.length > 10000) throw Error('Agency roster response is invalid.');
      const roster = data.members.map(row => {
        if (typeof row.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(row.id)) throw Error('Invalid agency creator ID.');
        return { ...member(row), id: row.id };
      });
      const departed = data.departed.map(name => member({ username: name }).username);
      if (new Set(roster.map(m => m.username)).size !== roster.length || new Set(roster.map(m => m.id)).size !== roster.length || departed.some(name => roster.some(m => m.username === name))) throw Error('Agency roster contains conflicting identities.');
      // Use current state AFTER the fetch, so manual edits during a request win.
      const oldNames = new Set(this.state.roster.map(m => m.username)), nextNames = new Set(roster.map(m => m.username));
      const priorDeparted = new Set(this.state.departed);
      const removed = new Set([...oldNames].filter(name => !nextNames.has(name)));
      for (const name of departed) if (!priorDeparted.has(name)) removed.add(name);
      this.state.manual = this.state.manual.filter(m => !removed.has(m.username) && (this.state.migrated || !nextNames.has(m.username)));
      this.state.roster = roster;this.state.departed = departed;this.state.migrated = true;
      this.state.lastSuccess = new Date().toISOString();this.state.error = null;
      this.save();return { ok: true, tracked: this.members().length, agency: roster.length };
    } catch (error) {
      // Never replace a usable roster with an outage, HTML response or bad data.
      this.state.error = error instanceof SyntaxError ? 'Agency roster response is invalid.' : error.message;
      atomic(this.file, this.state);
      return { ok: false, error: this.state.error, tracked: this.members().length };
    }
  }
  summary() {
    return { tracked: this.members().length, agency: this.state.roster.length, manual: this.state.manual.length, excluded: this.state.excluded.length,
      lastSuccess: this.state.lastSuccess, lastAttempt: this.state.lastAttempt, error: this.state.error };
  }
}
module.exports = { Watchlist, fetchAgencyRoster };
