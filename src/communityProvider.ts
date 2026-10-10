import { BaseProvider, type ProviderCapabilities, type ProviderMediaObject, type ProviderResult, type Source, type Subtitle } from '@omss/framework';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { canonicalPlaybackHeaders } from './tvCompatibility.js';

interface CommunityStream {
    url?: string;
    type?: string;
    quality?: string;
    language?: string;
    name?: string;
    headers?: Record<string, string>;
    isEmbed?: boolean;
    isPremium?: boolean;
    subtitles?: { url?: string; language?: string; name?: string; format?: string; headers?: Record<string, string> }[];
}
interface CommunityModule {
    getStreams(id: string, type: string, season?: number, episode?: number): Promise<CommunityStream[]>;
}

/** Generic bridge to an immutable upstream package; site resolvers stay upstream. */
export class CommunityProvider extends BaseProvider {
    readonly enabled = true;
    readonly BASE_URL = 'https://github.com/Gowaru/gowaru-nuvio-providers';
    readonly HEADERS = {};
    readonly capabilities: ProviderCapabilities = { supportedContentTypes: ['movies', 'tv'] };
    private readonly plugin: CommunityModule;

    constructor(readonly id: string, readonly name: string, packageName = 'nuvio-providers') {
        super();
        const require = createRequire(import.meta.url);
        const filename = require.resolve(`${packageName}/providers/${id}.js`);
        const module = { exports: {} as CommunityModule };
        const quiet = (): void => {};
        // Upstream diagnostics can include signed URLs. Keep those out of service logs.
        runInNewContext(readFileSync(filename, 'utf8'), {
            module, exports: module.exports, require: createRequire(filename),
            console: { log: quiet, info: quiet, warn: quiet, error: quiet, debug: quiet },
            fetch, URL, URLSearchParams, Headers, Request, Response, AbortController, AbortSignal,
            TextEncoder, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval,
            atob, btoa, Buffer, crypto: webcrypto,
            process: { env: { NUVIO_NAKIOS_EXCLUDE_PREMIUM: '1' } },
        }, { filename, timeout: 5000 });
        this.plugin = module.exports;
        if (typeof this.plugin.getStreams !== 'function') throw new Error('Community provider has no stream entry point');
    }

    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> { return this.resolve(media); }
    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> { return this.resolve(media); }

    private async resolve(media: ProviderMediaObject): Promise<ProviderResult> {
        const rows = await this.plugin.getStreams(media.tmdbId, media.type, media.s, media.e);
        let originalLanguage = 'und';
        if (rows.some(row => /\[OST\]/i.test(row.name || '')) && process.env.TMDB_API_KEY) {
            try {
                const response = await fetch(`https://api.themoviedb.org/3/${media.type}/${media.tmdbId}?api_key=${encodeURIComponent(process.env.TMDB_API_KEY)}`, { signal: AbortSignal.timeout(5000) });
                if (response.ok) {
                    const metadata = await response.json() as { original_language?: string };
                    originalLanguage = metadata.original_language || 'und';
                }
            } catch { /* Keep unspecified audio unknown if canonical metadata is unavailable. */ }
        }
        const sources: Source[] = [];
        const subtitles: Subtitle[] = [];
        const subtitleUrls = new Set<string>();
        for (const row of Array.isArray(rows) ? rows : []) {
            if (!row.url || row.isEmbed || row.isPremium) continue;
            try {
                const url = new URL(row.url);
                if (url.protocol !== 'https:' || url.username || url.password) continue;
                const type = row.type === 'hls' || url.pathname.toLowerCase().endsWith('.m3u8') ? 'hls'
                    : row.type === 'mp4' || url.pathname.toLowerCase().endsWith('.mp4') ? 'mp4' : null;
                if (!type) continue;
                sources.push({ url: this.createProxyUrl(row.url, canonicalPlaybackHeaders(row.headers)), type,
                    quality: row.quality || 'Auto',
                    audioTracks: [{ language: /^[a-z]{2,3}$/.test(row.language || '') ? row.language! : languageFromLabel(row.name, originalLanguage),
                        label: row.name || this.name }], provider: { id: this.id, name: this.name } });
                for (const track of row.subtitles || []) {
                    if (!track.url || subtitleUrls.has(track.url)) continue;
                    const subtitleUrl = new URL(track.url);
                    if (subtitleUrl.protocol !== 'https:' || subtitleUrl.username || subtitleUrl.password) continue;
                    const format = (track.format || subtitleUrl.pathname.split('.').pop() || '').toLowerCase();
                    if (!['vtt', 'srt', 'ass', 'ssa', 'ttml'].includes(format)) continue;
                    subtitles.push({ url: this.createProxyUrl(track.url, canonicalPlaybackHeaders(track.headers)),
                        label: track.name || track.language || 'Subtitles', format: format as Subtitle['format'] });
                    subtitleUrls.add(track.url);
                }
            } catch { /* Invalid individual records never replace the requested title. */ }
        }
        return { sources, subtitles, diagnostics: [] };
    }
}

// Never label an unspecified or shared audio track as English.
export function languageFromLabel(label?: string, originalLanguage = 'und'): string {
    const language = label?.match(/\[([^\]]+)\]/)?.[1]?.toLowerCase();
    if (language === 'ost') return /^[a-z]{2,3}$/.test(originalLanguage) ? originalLanguage : 'und';
    return ({ english: 'en', hindi: 'hi', telugu: 'te', tamil: 'ta', malayalam: 'ml', kannada: 'kn', french: 'fr' } as Record<string, string>)[language || ''] || 'und';
}
