import { OMSSServer } from '@omss/framework';
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { knownThirdPartyProxies } from './thirdPartyProxies.js';
import { streamPatterns } from './streamPatterns.js';
import { SourceService } from '@omss/framework';
import { MemoryCacheService } from '@omss/framework';
import { TMDBService } from '../node_modules/@omss/framework/dist/services/tmdb.service.js';
import { StremioService } from '../node_modules/@omss/framework/dist/services/stremio.service.js';
import { ProxyService } from '@omss/framework';

// Global error handlers - prevent process exit on unhandled rejections
process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] Unhandled Rejection:', reason);
});
process.on('uncaughtException', (error) => {
    console.error('[FATAL] Uncaught Exception:', error);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
    const server = new OMSSServer({
        name: 'CinePro',
        version: '1.0.0',

        // Network
        host: process.env.HOST ?? 'localhost',
        port: Number(process.env.PORT ?? 3000),
        publicUrl: process.env.PUBLIC_URL,

        // Cache (memory for dev, Redis for prod)
        cache: {
            type: (process.env.CACHE_TYPE as 'memory' | 'redis') ?? 'memory',
            ttl: {
                sources: 60 * 60,
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

    await server.start();

    // Add compatibility endpoints for Cine-verse TV app
    const fastify = server.getInstance();
    const cache = new MemoryCacheService();
    const tmdbService = new TMDBService(process.env.TMDB_API_KEY!, cache, 24 * 60 * 60);
    const proxyService = new ProxyService(streamPatterns);
    const stremioService = new StremioService([], proxyService);
    const sourceService = new SourceService(registry, cache, tmdbService, stremioService, { sources: 60 * 60, subtitles: 60 * 60 * 24 });
    
    // Health check
    fastify.get('/health', async () => ({ ok: true, serviceVersion: '1.0.0' }));
    
    // Version endpoint with adapter status
    fastify.get('/version', async () => {
        const providers = registry.getProviders();
        const adapters: Record<string, string> = {};
        for (const p of providers) {
            adapters[p.id] = 'ok';
        }
        return {
            serviceVersion: '1.0.0',
            adapters,
            broken_sources: []
        };
    });

    // Movie stream endpoint (compatibility)
    fastify.get('/stream/movie/:tmdbId', async (request, reply) => {
        const tmdbId = Number((request.params as any).tmdbId);
        if (!tmdbId) return reply.code(400).send({ error: 'Invalid TMDB id' });
        
        const exclude = (request.query as any).exclude?.split(',').map((v: string) => v.trim()).filter(Boolean) || [];
        
        try {
            const response = await sourceService.getMovieSources(String(tmdbId));
            const streams = response.sources
                .filter((s: any) => !exclude.includes(s.providerId))
                .map((s: any) => ({
                    url: s.url,
                    headers: s.headers || {},
                    quality: s.quality || 'Auto',
                    subtitles: s.subtitles || [],
                    source: s.providerId,
                    expiresAt: Date.now() + 30 * 60 * 1000
                }));
            return { streams };
        } catch (error) {
            return reply.code(500).send({ error: 'Failed to resolve streams' });
        }
    });

    // TV stream endpoint (compatibility)
    fastify.get('/stream/tv/:tmdbId/:season/:episode', async (request, reply) => {
        const tmdbId = Number((request.params as any).tmdbId);
        const season = Number((request.params as any).season);
        const episode = Number((request.params as any).episode);
        if (!tmdbId || !season || !episode) return reply.code(400).send({ error: 'Invalid series or episode id' });
        
        const exclude = (request.query as any).exclude?.split(',').map((v: string) => v.trim()).filter(Boolean) || [];
        
        try {
            const response = await sourceService.getTVSources(String(tmdbId), season, episode);
            const streams = response.sources
                .filter((s: any) => !exclude.includes(s.providerId))
                .map((s: any) => ({
                    url: s.url,
                    headers: s.headers || {},
                    quality: s.quality || 'Auto',
                    subtitles: s.subtitles || [],
                    source: s.providerId,
                    expiresAt: Date.now() + 30 * 60 * 1000
                }));
            return { streams };
        } catch (error) {
            return reply.code(500).send({ error: 'Failed to resolve streams' });
        }
    });

    const publicUrl =
        process.env.PUBLIC_URL ??
        `http://${process.env.HOST ?? 'localhost'}:${process.env.PORT ?? 3000}`;

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

    // Keep process alive - prevent exit after main() completes
    await new Promise(() => {});
}

main();