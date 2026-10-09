import { BaseProvider, type ProviderCapabilities, type ProviderMediaObject, type ProviderResult, type Source } from '@omss/framework';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
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

    constructor(readonly id: string, readonly name: string) {
        super();
        const require = createRequire(import.meta.url);
        const filename = require.resolve(`nuvio-providers/providers/${id}.js`);
        const module = { exports: {} as CommunityModule };
        const quiet = (): void => {};
        // Upstream diagnostics can include signed URLs. Keep those out of service logs.
        runInNewContext(readFileSync(filename, 'utf8'), {
            module, exports: module.exports, require: createRequire(filename),
            console: { log: quiet, info: quiet, warn: quiet, error: quiet, debug: quiet },
            fetch, URL, URLSearchParams, Headers, Request, Response, AbortController, AbortSignal,
            TextEncoder, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval,
            process: { env: { NUVIO_NAKIOS_EXCLUDE_PREMIUM: '1' } },
        }, { filename, timeout: 5000 });
        this.plugin = module.exports;
        if (typeof this.plugin.getStreams !== 'function') throw new Error('Community provider has no stream entry point');
    }

    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> { return this.resolve(media); }
    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> { return this.resolve(media); }

    private async resolve(media: ProviderMediaObject): Promise<ProviderResult> {
        const rows = await this.plugin.getStreams(media.tmdbId, media.type, media.s, media.e);
        const sources: Source[] = [];
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
                    audioTracks: [{ language: /^[a-z]{2,3}$/.test(row.language || '') ? row.language! : 'und',
                        label: row.name || this.name }], provider: { id: this.id, name: this.name } });
            } catch { /* Invalid individual records never replace the requested title. */ }
        }
        return { sources, subtitles: [], diagnostics: [] };
    }
}
