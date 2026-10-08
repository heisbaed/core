import { OMSSServer, ProxyService, type SourceResponse } from '@omss/framework';
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { knownThirdPartyProxies } from './thirdPartyProxies.js';
import { streamPatterns } from './streamPatterns.js';
import {
    decodeProxyDataPreservingUrl,
    isEpisodeSelection,
    isTmdbId,
    normalizeTvStreams,
    withDeadline
} from './tvCompatibility.js';

// Framework 1.1.26 decodes an already decoded URLSearchParams value again.
// Patch this public helper before SourceService is constructed so its validation
// and deduplication preserve signed URL escapes as well as the TV response does.
ProxyService.decodeProxyData = decodeProxyDataPreservingUrl;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
    const serviceVersion = '1.0.1';
    const port = Number(process.env.PORT ?? 3000);
    const coreBaseUrl = (process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? `http://localhost:${port}`).replace(/\/$/, '');
    const server = new OMSSServer({
        name: 'CinePro',
        version: serviceVersion,

        // Network - bind to 0.0.0.0 for Render/production
        host: '0.0.0.0',
        port,
        publicUrl: coreBaseUrl,

        // Cache (memory for dev, Redis for prod)
        cache: {
            type: (process.env.CACHE_TYPE as 'memory' | 'redis') ?? 'memory',
            ttl: {
                sources: 30 * 60,
                subtitles: 60 * 60 * 24
            },
            redis: {
                host: process.env.REDIS_HOST ?? 'localhost',
                port: Number(process.env.REDIS_PORT ?? 6379),
                password: process.env.REDIS_PASSWORD
            }
        },

        // TMDB
        tmdb: {
            apiKey: process.env.TMDB_API_KEY!,
            cacheTTL: 24 * 60 * 60 // 24h
        },

        // Third Party Proxy removal
        proxyConfig: {
            knownThirdPartyProxies: knownThirdPartyProxies,
            streamPatterns
        },

        cors: {
            origin: process.env.CORS_ORIGIN ?? '*',
            methods: ['GET', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization'],
            exposedHeaders: ['Content-Range', 'Accept-Ranges', 'ETag'],
            preflightContinue: false,
            optionsSuccessStatus: 204
        },

        stremio: {
            // exposes a stremio addon on /stremio/manifest.json
            enableNativeAddon: process.env.STREMIO_ADDON === 'true',
            // you can your own custom stremio addons as sources into cinepro.
            stremioAddons: []
            /*
            stremioAddons: [
                {
                    id: 'some-unique-id',
                    url: 'https://example.com/manifest.json',
                    enabled: true
                }
            ]
            */
        },

        // MCP for AI agents
        mcp: {
            enabled: process.env.MCP_ENABLED === 'true'
        }
    });

    // Register providers
    const registry = server.getRegistry();
    await registry.discoverProviders(path.join(__dirname, './providers/'));

    const adapterStatus = new Map<string, 'disabled' | 'configured' | 'ok' | 'broken'>();
    for (const provider of registry.getProviders()) {
        adapterStatus.set(provider.id, provider.enabled ? 'configured' : 'disabled');
        if (!provider.enabled) continue;
        const movieSources = provider.getMovieSources.bind(provider);
        const tvSources = provider.getTVSources.bind(provider);
        provider.getMovieSources = async (media) => {
            try {
                return await withDeadline(movieSources(media), 15000);
            } catch (error) {
                adapterStatus.set(provider.id, 'broken');
                throw error;
            }
        };
        provider.getTVSources = async (media) => {
            try {
                return await withDeadline(tvSources(media), 15000);
            } catch (error) {
                adapterStatus.set(provider.id, 'broken');
                throw error;
            }
        };
    }

    // Add compatibility endpoints for Cine-verse TV app BEFORE starting server
    const fastify = server.getInstance();

    // Health check
    fastify.get('/health', async () => ({
        ok: true,
        serviceVersion,
        configuredProviders: registry.count,
        enabledProviders: registry.getEnabledProviders().length
    }));

    // Version endpoint with adapter status
    fastify.get('/version', async () => ({
        serviceVersion,
        adapters: Object.fromEntries(adapterStatus),
        broken_sources: [...adapterStatus].filter(([, status]) => status === 'broken').map(([id]) => id)
    }));

    // Use the framework's public routes so TV and OMSS share one SourceService,
    // one cache and the same provider validation instead of two divergent copies.
    async function resolveTvStreams(url: string, excludeValue?: string) {
        const result = await withDeadline(fastify.inject({ method: 'GET', url, headers: { accept: 'application/json' } }), 28000);
        if (result.statusCode !== 200) {
            return { statusCode: result.statusCode, body: result.json() };
        }
        const response = result.json<SourceResponse>();
        const exclude = new Set((excludeValue ?? '').split(',').map((id) => id.trim()).filter(Boolean));
        const availableStreams = normalizeTvStreams(response, coreBaseUrl);
        // A provider can recover even when this client's last status check asked
        // to exclude it. Remember recovery before applying request exclusions.
        for (const stream of availableStreams) adapterStatus.set(stream.source, 'ok');
        const streams = availableStreams.filter((stream) => !exclude.has(stream.source));
        if (streams.length === 0) {
            return { statusCode: 404, body: { error: 'No compatible HTTPS movie stream is available', streams: [] } };
        }
        return { statusCode: 200, body: { streams } };
    }

    fastify.get<{ Params: { tmdbId: string }; Querystring: { exclude?: string } }>('/stream/movie/:tmdbId', async (request, reply) => {
        const { tmdbId } = request.params;
        if (!isTmdbId(tmdbId)) return reply.code(400).send({ error: 'Invalid TMDB id' });
        try {
            const result = await resolveTvStreams(`/v1/movies/${tmdbId}`, request.query.exclude);
            return reply.code(result.statusCode).send(result.body);
        } catch {
            return reply.code(503).send({ error: 'Stream service could not complete this request. Try again.', streams: [] });
        }
    });

    fastify.get<{ Params: { tmdbId: string; season: string; episode: string }; Querystring: { exclude?: string } }>('/stream/tv/:tmdbId/:season/:episode', async (request, reply) => {
        const { tmdbId, season, episode } = request.params;
        if (!isTmdbId(tmdbId) || !isEpisodeSelection(season, episode)) {
            return reply.code(400).send({ error: 'Invalid series or episode id' });
        }
        try {
            const result = await resolveTvStreams(`/v1/tv/${tmdbId}/seasons/${season}/episodes/${episode}`, request.query.exclude);
            return reply.code(result.statusCode).send(result.body);
        } catch {
            return reply.code(503).send({ error: 'Stream service could not complete this request. Try again.', streams: [] });
        }
    });

    await server.start();

    const publicUrl =
        process.env.PUBLIC_URL ??
        `http://${process.env.HOST ?? '0.0.0.0'}:${process.env.PORT ?? 3000}`;

    const uiUrl = `https://ui.cinepro.cc/?omssurl=${encodeURIComponent(publicUrl)}`;

    const title = '🚀 CinePro/ui is in public testing';
    const contrib =
        '🤝 We are looking for contributors to improve and develop!';
    const repo = 'Contribute: https://github.com/cinepro-org/ui';
    const tryIt = `🌐 Try it out: ${uiUrl} !`;
    const note =
        'You will need to give the website "access to local applications" that it works.';

    const lines = [title, '', repo, '', contrib, '', tryIt, '', note];

    // compute box width based on longest line
    const width = Math.max(...lines.map((l) => l.length)) + 2;

    const borderTop = '╭' + '─'.repeat(width) + '╮';
    const borderBottom = '╰' + '─'.repeat(width) + '╯';

    const pad = (line: string) => '│ ' + line.padEnd(width - 2, ' ') + ' │';

    console.log(`
================== CINEPRO BETA ANNOUNCEMENT ==================

${borderTop}
${lines.map(pad).join('\n')}
${borderBottom}
`);

}

main().catch((error: unknown) => {
    console.error('[Server] Startup failed:', error instanceof Error ? error.message : 'Unknown startup error');
    process.exit(1);
});
