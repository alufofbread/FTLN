const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');const os = require('node:os');const path = require('node:path');
const { Watchlist, fetchAgencyRoster } = require('./watchlist');
const fixture = members => ({ version: 1, members: members.map(([id, username]) => ({ id, username })), departed: [] });
function setup(t, legacy = []) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchlist-'));t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'members.json'), JSON.stringify(legacy.map(username => ({ username }))));
  let data = fixture([]), fail = false;
  const options = { dataDir, fetchRoster: async () => { if (fail) throw Error('offline');return data; } };
  return { options, list: new Watchlist(options), set: value => { data = value; }, fail: value => { fail = value; } };
}
test('adopts matching legacy members, preserves unrelated extras and removes leavers', async t => {
  const f = setup(t, ['alice', 'manual.extra']);f.set(fixture([['1', 'alice'], ['2', 'bob']]));await f.list.sync();
  assert.deepEqual(f.list.members().map(m => m.username), ['alice', 'bob', 'manual.extra']);
  f.set(fixture([['2', 'bob']]));await f.list.sync();assert.deepEqual(f.list.members().map(m => m.username), ['bob', 'manual.extra']);
  assert(fs.existsSync(path.join(f.options.dataDir, 'members.json.before-roster-sync')));
});
test('manual remove persists across refresh/restart and add clears it', async t => {
  const f = setup(t);f.set(fixture([['1', 'alice']]));await f.list.sync();f.list.remove('ALICE');await f.list.sync();assert.equal(f.list.members().length, 0);
  f.list = new Watchlist(f.options);assert.equal(f.list.members().length, 0);f.list.add([{ username: '@Alice' }]);assert.equal(f.list.members().length, 1);
  f.set(fixture([]));await f.list.sync();assert.equal(f.list.members().length, 0, 'Departure clears a prior manual pin for that agency creator');
});
test('explicit departure removes legacy leftovers, but later manual fallback sticks', async t => {
  const f = setup(t, ['frostbite_poole']);const data = { ...fixture([]), departed: ['frostbite_poole'] };f.set(data);await f.list.sync();assert.equal(f.list.members().length, 0);
  f.list.add([{ username: 'frostbite_poole' }]);await f.list.sync();assert.equal(f.list.members().length, 1);
});
test('network failure and malformed roster keep the last usable list', async t => {
  const f = setup(t);f.set(fixture([['1', 'alice']]));await f.list.sync();f.fail(true);assert.equal((await f.list.sync()).ok, false);assert.equal(f.list.members()[0].username, 'alice');
  f.fail(false);f.set({});assert.equal((await f.list.sync()).ok, false);assert.equal(f.list.members()[0].username, 'alice');
  f.set(fixture([['1', 'bad user']]));assert.equal((await f.list.sync()).ok, false);assert.equal(f.list.members()[0].username, 'alice');
});
test('renames remove old handles and a valid empty roster removes auto members', async t => {
  const f = setup(t);f.set(fixture([['1', 'alice']]));await f.list.sync();f.set(fixture([['1', 'new.alice']]));await f.list.sync();assert.deepEqual(f.list.members().map(m => m.username), ['new.alice']);
  f.set(fixture([]));await f.list.sync();assert.equal(f.list.members().length, 0);
});
test('manual changes made while fetch waits are retained', async t => {
  const f = setup(t);let resolve;f.list.fetchRoster = () => new Promise(r => { resolve = r; });const pending = f.list.sync();
  f.list.remove('alice');f.list.add([{ username: 'manual.extra' }]);resolve(fixture([['1', 'alice']]));await pending;assert.deepEqual(f.list.members().map(m => m.username), ['manual.extra']);
});
test('roster request is server-authenticated and does not log secret response bodies', async t => {
  const originalFetch = global.fetch, originalEnv = { ...process.env };t.after(() => { global.fetch = originalFetch;process.env = originalEnv; });
  process.env.SUPABASE_URL = 'https://fixture.supabase.co';process.env.SUPABASE_SERVICE_ROLE_KEY = 'secret-test';
  global.fetch = async (url, options) => { assert(url.endsWith('/rpc/import_member_roster'));assert.equal(options.headers.apikey, 'secret-test');return new Response('private upstream error', { status: 500 }); };
  await assert.rejects(fetchAgencyRoster(), error => error.message.includes('HTTP 500') && !error.message.includes('private upstream'));
});
test('private feed departures and website disable state filter the live roster', async t => {
  const originalFetch = global.fetch, originalEnv = { ...process.env };t.after(() => { global.fetch = originalFetch;process.env = originalEnv; });
  process.env.SUPABASE_URL = 'https://fixture.supabase.co';process.env.SUPABASE_SERVICE_ROLE_KEY = 'secret-test';
  global.fetch = async url => new Response(JSON.stringify(url.includes('/rpc/') ? [
    {id:'1',handle:'alice',account_id:'a',enabled:true}, {id:'2',handle:'bob',account_id:'b',enabled:true},
    {id:'3',handle:'disabled',account_id:'c',enabled:false}, {id:'application:4',handle:'pending',account_id:null}
  ] : {version:1,creators:{bob:{active:false}}}));
  const result=await fetchAgencyRoster();assert.deepEqual(result.members.map(m=>m.username),['alice']);assert.deepEqual(result.departed.sort(),['bob','disabled']);
});
