import { OMSSError, type ProxyData, type SourceResponse, type SourceType } from '@omss/framework';

const HEADER_NAMES: Record<string, string> = {
    referer: 'Referer',
    origin: 'Origin',
    'user-agent': 'User-Agent',
    cookie: 'Cookie',
    authorization: 'Authorization',
    accept: 'Accept',
    'accept-language': 'Accept-Language'
};

const STREAM_MIME: Partial<Record<SourceType, string>> = {
    hls: 'application/x-mpegURL',
    mp4: 'video/mp4'
};

const SUBTITLE_MIME: Record<string, string> = {
    vtt: 'text/vtt',
    srt: 'application/x-subrip',
    ass: 'text/x-ssa',
    ssa: 'text/x-ssa',
    ttml: 'application/ttml+xml'
};

export interface TvSubtitle {
    url: string;
    lang: string;
    label: string;
    mimeType: string;
    headers: Record<string, string>;
}

export interface TvStream {
    url: string;
    headers: Record<string, string>;
    quality: string;
    type: 'hls' | 'mp4';
    mimeType: string;
    source: string;
    sourceName: string;
    language: string;
    subtitles: TvSubtitle[];
    expiresAt: number;
}

function invalidProxyData(): never {
    throw new OMSSError('INVALID_PARAMETER', 'Invalid data parameter format', 400, { parameter: 'data' });
}

/**
 * The framework passes both an encoded query value and URLSearchParams' already
 * decoded value into this method. Parse JSON first to preserve percent escapes
 * inside signed URLs; decode only the outer query encoding when necessary.
 */
export function decodeProxyDataPreservingUrl(encodedData: string): ProxyData {
    if (typeof encodedData !== 'string' || encodedData.length === 0 || encodedData.length > 131072) {
        return invalidProxyData();
    }
    let data: unknown;
    try {
        data = JSON.parse(encodedData);
    } catch {
        try {
            data = JSON.parse(decodeURIComponent(encodedData));
        } catch {
            return invalidProxyData();
        }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return invalidProxyData();
    const object = data as Record<string, unknown>;
    if (typeof object.url !== 'string' || object.url.length === 0 || object.url.length > 32768) {
        return invalidProxyData();
    }
    try {
        const url = new URL(object.url);
        if (!['http:', 'https:'].includes(url.protocol)) return invalidProxyData();
    } catch {
        return invalidProxyData();
    }
    if (object.headers !== undefined && (!object.headers || typeof object.headers !== 'object' || Array.isArray(object.headers))) {
        return invalidProxyData();
    }
    const headers = object.headers as Record<string, unknown> | undefined;
    if (headers && Object.entries(headers).some(([name, value]) =>
        typeof value !== 'string' || /[\r\n\0]/.test(name) || /[\r\n\0]/.test(value))) {
        return invalidProxyData();
    }
    return { url: object.url, ...(headers ? { headers: headers as Record<string, string> } : {}) };
}

export function canonicalPlaybackHeaders(headers: Record<string, string> = {}): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
        const canonicalName = HEADER_NAMES[name.toLowerCase()];
        if (canonicalName && typeof value === 'string' && value.length <= 8192 && !/[\r\n\0]/.test(value)) {
            result[canonicalName] = value;
        }
    }
    return result;
}

/** Unwrap only this Core's own wrapper. Other URLs' data parameters are untouched. */
export function directPlaybackUrl(value: string, coreBaseUrl: string): ProxyData {
    const base = new URL(coreBaseUrl.endsWith('/') ? coreBaseUrl : `${coreBaseUrl}/`);
    const wrapper = new URL('v1/proxy', base);
    const candidate = new URL(value, base);
    let url = value;
    let headers: Record<string, string> = {};
    if (candidate.origin === wrapper.origin && candidate.pathname === wrapper.pathname) {
        const data = candidate.searchParams.get('data');
        if (!data) return invalidProxyData();
        const upstream = decodeProxyDataPreservingUrl(data);
        url = upstream.url;
        headers = canonicalPlaybackHeaders(upstream.headers);
    }
    const upstream = new URL(url);
    if (upstream.protocol !== 'https:' || upstream.username || upstream.password) {
        throw new Error('Playback URL must use HTTPS without URL credentials');
    }
    // Return the original string. URL.href would unnecessarily normalize tokens.
    return { url, headers };
}

function languageCode(value?: string): string {
    return value && /^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(value) ? value : 'und';
}

export function normalizeTvStreams(
    response: SourceResponse,
    coreBaseUrl: string,
    exclude: ReadonlySet<string> = new Set(),
    now = Date.now()
): TvStream[] {
    const parsedExpiry = Date.parse(response.expiresAt);
    const expiresAt = Math.min(Number.isFinite(parsedExpiry) ? parsedExpiry : now + 1800000, now + 1800000);
    if (expiresAt <= now) return [];
    const subtitles: TvSubtitle[] = [];
    for (const subtitle of response.subtitles ?? []) {
        try {
            const mimeType = SUBTITLE_MIME[subtitle.format];
            if (!mimeType) continue;
            const direct = directPlaybackUrl(subtitle.url, coreBaseUrl);
            subtitles.push({
                url: direct.url,
                headers: direct.headers ?? {},
                lang: languageCode(subtitle.label),
                label: subtitle.label,
                mimeType
            });
        } catch {
            // A bad subtitle must not prevent an otherwise playable source.
        }
    }
    const streams: TvStream[] = [];
    const seen = new Set<string>();
    for (const source of response.sources ?? []) {
        try {
            const mimeType = STREAM_MIME[source.type];
            if (!mimeType || !source.provider?.id || exclude.has(source.provider.id)) continue;
            const direct = directPlaybackUrl(source.url, coreBaseUrl);
            if (seen.has(direct.url)) continue;
            seen.add(direct.url);
            streams.push({
                url: direct.url,
                headers: direct.headers ?? {},
                quality: source.quality && source.quality !== 'unknown' ? source.quality : 'Auto',
                type: source.type as 'hls' | 'mp4',
                mimeType,
                source: source.provider.id,
                sourceName: source.provider.name,
                language: languageCode(source.audioTracks?.[0]?.language),
                subtitles,
                expiresAt
            });
        } catch {
            // Reject an invalid source individually so alternatives remain usable.
        }
    }
    return streams;
}

export function isTmdbId(value: string): boolean {
    return /^\d{1,20}$/.test(value) && BigInt(value) > 0n;
}

export function isEpisodeSelection(season: string, episode: string): boolean {
    return /^\d{1,2}$/.test(season) && Number(season) <= 99 &&
        /^\d{1,4}$/.test(episode) && Number(episode) >= 1 && Number(episode) <= 9999;
}

export async function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Source resolution timed out')), timeoutMs);
            })
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}
