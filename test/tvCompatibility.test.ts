import test from 'node:test';
import assert from 'node:assert/strict';
import { ProxyService, type Source, type SourceResponse } from '@omss/framework';
import {
    canonicalPlaybackHeaders,
    decodeProxyDataPreservingUrl,
    directPlaybackUrl,
    isEpisodeSelection,
    isTmdbId,
    normalizeTvStreams,
    withDeadline
} from '../src/tvCompatibility.js';

const CORE = 'https://core.example';
const SIGNED_URL = 'https://media.example/movie.m3u8?token=a%2Fb&scope=x%252Fy&literal=50%25&name=x+y&key=%3D';
const NOW = 1700000000000;

function proxy(url: string, headers: Record<string, string> = {}): string {
    return `${CORE}/v1/proxy?data=${encodeURIComponent(JSON.stringify({ url, headers }))}`;
}

function source(url: string, type: Source['type'] = 'hls', id = 'origin-a'): Source {
    return { url, type, quality: '1080p', audioTracks: [{ language: 'en', label: 'English' }], provider: { id, name: 'Origin A' } };
}

function response(sources: Source[]): SourceResponse {
    return {
        sources,
        responseId: 'request',
        expiresAt: new Date(NOW + 7200000).toISOString(),
        subtitles: [],
        diagnostics: []
    };
}

test('signed URLs retain every percent escape through raw and encoded query decoding', () => {
    const json = JSON.stringify({ url: SIGNED_URL, headers: { Referer: 'https://origin.example/' } });
    for (const input of [json, encodeURIComponent(json), new URL(proxy(SIGNED_URL)).searchParams.get('data')!]) {
        assert.equal(decodeProxyDataPreservingUrl(input).url, SIGNED_URL);
    }
    const original = ProxyService.decodeProxyData;
    try {
        ProxyService.decodeProxyData = decodeProxyDataPreservingUrl;
        assert.equal(ProxyService.decodeProxyData(new URL(proxy(SIGNED_URL)).searchParams.get('data')!).url, SIGNED_URL);
    } finally {
        ProxyService.decodeProxyData = original;
    }
});

test('decoder rejects malformed data, repeated encoding, invalid URL schemes and header injection', () => {
    for (const input of [
        '', 'not-json', '%', 'null', '[]', '{}',
        JSON.stringify({ url: 'file:///secret' }),
        JSON.stringify({ url: 'relative/path' }),
        JSON.stringify({ url: SIGNED_URL, headers: [] }),
        JSON.stringify({ url: SIGNED_URL, headers: { Referer: 1 } }),
        JSON.stringify({ url: SIGNED_URL, headers: { Referer: 'https://origin.example\r\nHost: bad' } }),
        encodeURIComponent(encodeURIComponent(JSON.stringify({ url: SIGNED_URL })))
    ]) {
        assert.throws(() => decodeProxyDataPreservingUrl(input), { name: 'OMSSError' });
    }
});

test('only own Core wrappers are decoded and only HTTPS origins reach the TV', () => {
    const wrapped = proxy(SIGNED_URL, { referer: 'https://origin.example/', 'USER-AGENT': 'Player/1', Host: 'invalid' });
    assert.deepEqual(directPlaybackUrl(wrapped, CORE), {
        url: SIGNED_URL,
        headers: { Referer: 'https://origin.example/', 'User-Agent': 'Player/1' }
    });
    assert.equal(directPlaybackUrl(wrapped.replace(CORE, 'http://localhost:3000'), 'http://localhost:3000').url, SIGNED_URL);
    const foreignWrapper = wrapped.replace(CORE, 'https://foreign.example');
    assert.equal(directPlaybackUrl(foreignWrapper, CORE).url, foreignWrapper);
    assert.deepEqual(directPlaybackUrl(SIGNED_URL, CORE), { url: SIGNED_URL, headers: {} });
    assert.throws(() => directPlaybackUrl(proxy('http://media.example/movie.mp4'), CORE));
    assert.throws(() => directPlaybackUrl('https://user:password@media.example/movie.mp4', CORE));
});

test('canonical headers preserve required values and reject unallowed or unsafe headers', () => {
    assert.deepEqual(canonicalPlaybackHeaders({
        REFERER: 'https://origin.example/',
        origin: 'https://origin.example',
        'user-agent': 'Player/1',
        cookie: 'session=a%2Fb',
        authorization: 'Bearer signed',
        accept: '*/*',
        'accept-language': 'en',
        Host: 'invalid',
        'X-Internal-Key': 'not-forwarded'
    }), {
        Referer: 'https://origin.example/',
        Origin: 'https://origin.example',
        'User-Agent': 'Player/1',
        Cookie: 'session=a%2Fb',
        Authorization: 'Bearer signed',
        Accept: '*/*',
        'Accept-Language': 'en'
    });
    assert.deepEqual(canonicalPlaybackHeaders({ Cookie: 'bad\nvalue', Referer: 'x'.repeat(8193) }), {});
});

test('TV normalization uses nested provider IDs, exact upstream headers, MIME and root subtitles', () => {
    const result = response([source(proxy(SIGNED_URL, { Referer: 'https://origin.example/' }))]);
    result.subtitles = [
        { url: proxy('https://media.example/subtitle.vtt?token=a%2Fb'), label: 'English', format: 'vtt' },
        { url: 'http://media.example/insecure.srt', label: 'Bad', format: 'srt' }
    ];
    const streams = normalizeTvStreams(result, CORE, new Set(), NOW);
    assert.equal(streams.length, 1);
    assert.deepEqual(streams[0], {
        url: SIGNED_URL,
        headers: { Referer: 'https://origin.example/' },
        source: 'origin-a',
        sourceName: 'Origin A',
        quality: '1080p',
        type: 'hls',
        mimeType: 'application/x-mpegURL',
        language: 'en',
        expiresAt: NOW + 1800000,
        subtitles: [{
            url: 'https://media.example/subtitle.vtt?token=a%2Fb',
            headers: {},
            lang: 'und',
            label: 'English',
            mimeType: 'text/vtt'
        }]
    });
    assert.deepEqual(normalizeTvStreams(result, CORE, new Set(['origin-a']), NOW), []);
});

test('bad sources are isolated, unsupported types excluded, MP4 MIME explicit and expiry respected', () => {
    const result = response([
        source('http://media.example/bad.mp4', 'mp4'),
        source(proxy('https://media.example/movie.mp4?sig=x%2Fy'), 'mp4', 'origin-b'),
        source('https://media.example/page', 'embed'),
        source('https://media.example/movie.mpd', 'dash')
    ]);
    const streams = normalizeTvStreams(result, CORE, new Set(), NOW);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].mimeType, 'video/mp4');
    assert.equal(streams[0].url, 'https://media.example/movie.mp4?sig=x%2Fy');
    result.expiresAt = new Date(NOW - 1).toISOString();
    assert.deepEqual(normalizeTvStreams(result, CORE, new Set(), NOW), []);
});

test('IDs are positive integers and series specials season zero is allowed', () => {
    for (const value of ['0', '-1', '1.5', '1e3', 'x', '999999999999999999999']) assert.equal(isTmdbId(value), false);
    for (const value of ['1', '12345', '99999999999999999999']) assert.equal(isTmdbId(value), true);
    assert.equal(isEpisodeSelection('0', '1'), true);
    assert.equal(isEpisodeSelection('99', '9999'), true);
    for (const [season, episode] of [['-1', '1'], ['100', '1'], ['1', '0'], ['1', '10000'], ['1.5', '1']]) {
        assert.equal(isEpisodeSelection(season, episode), false);
    }
});

test('resolution deadline settles a hung source and preserves completed results', async () => {
    assert.equal(await withDeadline(Promise.resolve('resolved'), 100), 'resolved');
    await assert.rejects(withDeadline(new Promise<never>(() => {}), 5), /timed out/);
});
