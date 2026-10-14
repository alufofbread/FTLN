const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgencyVideos, agencyVideo } = require('./agency-videos');

const video = (id, account = 'aetheragencytt') => ({ id: String(id), create_time: Math.floor(Date.now() / 1000),
  title: 'Agency update', share_url: `https://www.tiktok.com/@${account}/video/${id}` });

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-video-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let feed = [video(1)];
  const sent = [];
  const channel = { guildId: 'guild', isTextBased: () => true,
    messages: { fetch: async () => new Map() }, send: async payload => sent.push(payload) };
  const watcher = new AgencyVideos({ dataDir, loadConfig: () => ({ videoChannelId: 'channel' }),
    env: { AGENCY_TIKTOK_ACCESS_TOKEN: 'test', DISCORD_GUILD_ID: 'guild' },
    request: async () => ({ ok: true, json: async () => ({ data: { videos: feed, has_more: false }, error: { code: 'ok' } }) }) });
  const client = { user: { id: 'bot' }, channels: { fetch: async () => channel } };
  return { watcher, client, channel, sent, dataDir, setFeed: value => { feed = value; } };
}

test('only accepts exact agency video links and matching IDs', () => {
  assert(agencyVideo(video(1)));
  assert(!agencyVideo(video(1, 'creator')));
  assert(!agencyVideo({ ...video(1), share_url: 'https://tiktok.com.evil.test/@aetheragencytt/video/1' }));
  assert(!agencyVideo({ ...video(1), id: '2' }));
});

test('baseline is silent; new uploads send once across restart', async t => {
  const f = fixture(t);
  await f.watcher.check(f.client);
  assert.equal(f.sent.length, 0);
  f.setFeed([video(2), video(1)]);
  await f.watcher.check(f.client);
  await f.watcher.check(f.client);
  assert.equal(f.sent.length, 1);
  assert(f.sent[0].embeds[0].url.endsWith('/video/2'));
  const restarted = new AgencyVideos({ dataDir: f.dataDir, loadConfig: f.watcher.loadConfig,
    env: f.watcher.env, request: f.watcher.request });
  await restarted.check(f.client);
  assert.equal(f.sent.length, 1);
});

test('creator feed cannot send or overwrite agency state', async t => {
  const f = fixture(t);
  await f.watcher.check(f.client);
  const before = fs.readFileSync(f.watcher.file, 'utf8');
  f.setFeed([video(2, 'creator')]);
  await assert.rejects(f.watcher.check(f.client), /not exclusively/);
  assert.equal(f.sent.length, 0);
  assert.equal(fs.readFileSync(f.watcher.file, 'utf8'), before);
});

test('failed send retries without marking the video delivered', async t => {
  const f = fixture(t);
  await f.watcher.check(f.client);
  f.setFeed([video(2)]);
  const send = f.channel.send;
  f.channel.send = async () => { throw new Error('Discord unavailable'); };
  await assert.rejects(f.watcher.check(f.client));
  f.channel.send = send;
  await f.watcher.check(f.client);
  assert.equal(f.sent.length, 1);
});

test('uncertain sends recover from the message footer', async t => {
  const f = fixture(t);
  await f.watcher.check(f.client);
  f.setFeed([video(2)]);
  f.channel.messages.fetch = async () => new Map([['message', { author: { id: 'bot' },
    embeds: [{ footer: { text: 'AETHER-VIDEO:2' } }] }]]);
  await f.watcher.check(f.client);
  assert.equal(f.sent.length, 0);
  assert(JSON.parse(fs.readFileSync(f.watcher.file)).seen.includes('2'));
});
