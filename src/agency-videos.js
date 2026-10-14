const fs = require('node:fs');
const path = require('node:path');

const ACCOUNT = 'aetheragencytt';

function atomicSave(file, value) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

function agencyVideo(video) {
  try {
    const url = new URL(video.share_url);
    const match = url.pathname.match(/^\/@aetheragencytt\/video\/(\d+)\/?$/i);
    return url.protocol === 'https:' && ['www.tiktok.com', 'tiktok.com'].includes(url.hostname)
      && match && match[1] === String(video.id) && Number.isFinite(video.create_time);
  } catch { return false; }
}

class AgencyVideos {
  constructor({ dataDir, loadConfig, env = process.env, request = fetch }) {
    this.file = path.join(dataDir, 'agency-video-state.json');
    this.tokenFile = path.join(dataDir, 'agency-video-token.json');
    this.loadConfig = loadConfig;
    this.env = env;
    this.request = request;
    this.running = false;
  }

  async api(url, options) {
    const response = await this.request(url, { ...options, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`TikTok video API HTTP ${response.status}`);
    const body = await response.json();
    if (body.error && body.error.code !== 'ok') throw new Error('TikTok video API rejected the request; check account authorisation.');
    return body;
  }

  async accessToken() {
    const saved = fs.existsSync(this.tokenFile) ? JSON.parse(fs.readFileSync(this.tokenFile, 'utf8')) : {};
    if (saved.access_token && saved.expires_at > Date.now() + 60000) return saved.access_token;
    const refresh = saved.refresh_token || this.env.AGENCY_TIKTOK_REFRESH_TOKEN;
    if (refresh && this.env.AGENCY_TIKTOK_CLIENT_KEY && this.env.AGENCY_TIKTOK_CLIENT_SECRET) {
      const token = await this.api('https://open.tiktokapis.com/v2/oauth/token/', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh,
          client_key: this.env.AGENCY_TIKTOK_CLIENT_KEY, client_secret: this.env.AGENCY_TIKTOK_CLIENT_SECRET }),
      });
      if (!token.access_token || !token.refresh_token || !Number.isFinite(token.expires_in)) throw new Error('Invalid TikTok token refresh response.');
      atomicSave(this.tokenFile, { access_token: token.access_token, refresh_token: token.refresh_token,
        expires_at: Date.now() + token.expires_in * 1000 });
      return token.access_token;
    }
    if (!this.env.AGENCY_TIKTOK_ACCESS_TOKEN) throw new Error('Agency video alerts need @aetheragencytt video.list authorisation.');
    return this.env.AGENCY_TIKTOK_ACCESS_TOKEN;
  }

  async videos(since) {
    const token = await this.accessToken();
    const videos = [];
    let cursor;
    for (let page = 0; page < 100; page++) {
      const body = await this.api('https://open.tiktokapis.com/v2/video/list/?fields=id,title,share_url,create_time', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ max_count: 20, ...(cursor === undefined ? {} : { cursor }) }),
      });
      if (!Array.isArray(body.data?.videos)) throw new Error('TikTok video list unavailable.');
      const batch = body.data.videos;
      // Reject a token/feed for any other account before changing state or sending.
      if (batch.some(video => !agencyVideo(video))) throw new Error('Video feed is not exclusively @aetheragencytt.');
      videos.push(...batch);
      if (!body.data.has_more || since === undefined || batch.some(video => video.create_time < since)) return videos;
      if (!Number.isFinite(body.data.cursor) || body.data.cursor === cursor) throw new Error('Invalid TikTok pagination cursor.');
      cursor = body.data.cursor;
    }
    throw new Error('Video backlog exceeds pagination limit; state was preserved.');
  }

  async check(client) {
    if (this.running) return;
    const channelId = this.loadConfig().videoChannelId;
    if (!channelId) return;
    this.running = true;
    try {
      const saved = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : null;
      const videos = await this.videos(saved?.since);
      const unique = [...new Map(videos.map(video => [String(video.id), video])).values()];
      if (!saved) {
        // First successful check establishes a baseline without reposting old uploads.
        atomicSave(this.file, { since: Math.floor(Date.now() / 1000), seen: unique.map(video => String(video.id)) });
        return;
      }
      const seen = new Set(saved.seen);
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased() || (this.env.DISCORD_GUILD_ID && channel.guildId !== this.env.DISCORD_GUILD_ID)) throw new Error('Agency video channel unavailable or belongs to another server.');
      for (const video of unique.sort((a, b) => a.create_time - b.create_time)) {
        if (seen.has(String(video.id)) || video.create_time < saved.since) continue;
        const nonce = String(video.id);
        // Recover a successful send if the process stopped before persisting its ID.
        let delivered = false;
        let before;
        const marker = `AETHER-VIDEO:${video.id}`;
        for (;;) {
          const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
          if ([...messages.values()].some(message => message.author.id === client.user.id && message.embeds.some(embed => embed.footer?.text === marker))) { delivered = true; break; }
          const last = [...messages.values()].at(-1);
          if (!last || last.createdTimestamp < video.create_time * 1000 || messages.size < 100) break;
          before = last.id;
        }
        if (!delivered) await channel.send({
          embeds: [{ title: 'AETHER just posted a new TikTok', url: `https://www.tiktok.com/@${ACCOUNT}/video/${video.id}`,
            description: String(video.title || 'Watch the latest video from @aetheragencytt.').slice(0, 4000),
            color: 0x8461FF, footer: { text: marker } }],
          allowedMentions: { parse: [] }, nonce, enforceNonce: true,
        });
        seen.add(String(video.id));
        saved.seen = [...seen];
        atomicSave(this.file, saved);
      }
    } finally { this.running = false; }
  }
}

module.exports = { AgencyVideos, agencyVideo };
